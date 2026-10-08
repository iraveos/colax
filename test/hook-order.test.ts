/**
 * A source-level check that every hook in a component sits above its early
 * returns.
 *
 * React's "rendered more hooks than during the previous render" error is a
 * runtime crash with no stack that points at the actual mistake: the offending
 * hook is hundreds of lines above the `if` that skipped it. It happened here
 * once already — five hooks were added next to the views that consumed them,
 * below four early returns for boot, loading, lock and the vault gate, so the
 * app worked until it was unlocked and then refused to render.
 *
 * ESLint's rules-of-hooks catches the direct case but needs the JSX parser and
 * a config this project does not have. This reads the file as text, finds each
 * function, and reports any hook call that appears after a top-level `return`.
 * It is a heuristic, and it is deliberately crude: it would flag a hook inside
 * a nested callback, which is not a real error. It has no false negatives for
 * the bug it is aimed at, which is the trade worth making.
 *
 * Run as part of the test suite so the mistake cannot come back unnoticed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Splits a file into top-level components and the hooks declared inside each.
 *
 * Boundaries are `export function` / `function` at column zero, which is this
 * codebase's convention. Everything after a boundary belongs to that function
 * until the next one starts.
 */
function components(lines: string[]): { name: string; start: number; end: number }[] {
  const marks: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(?:export\s+)?(?:default\s+)?function\s+(\w+)/.exec(lines[i]!);
    if (m) marks.push({ name: m[1]!, line: i });
  }
  return marks.map((mark, index) => ({
    name: mark.name,
    start: mark.line,
    end: index + 1 < marks.length ? marks[index + 1]!.line : lines.length,
  }));
}

/**
 * A custom hook, not a component.
 *
 * These are skipped: a file that defines several hooks (hooks.ts) has one
 * `return` in the first of them and the rest legitimately follow, and React
 * allows a custom hook to return early as long as every call site is consistent.
 * The bug this guards against can only happen in a component.
 */
function isCustomHook(name: string): boolean {
  return name.startsWith('use');
}

/** Hook calls inside one function body, ignoring nested function bodies. */
function hooksIn(lines: string[], start: number, end: number): Map<number, string> {
  const found = new Map<number, string>();
  let depth = 0;
  for (let i = start + 1; i < end; i += 1) {
    const raw = lines[i]!;
    const atTopLevel = depth === 0;
    const isHook = /\buse[A-Z]\w*\s*\(/.test(raw) && !/^\s*(\/\/|\*|\/\*)/.test(raw);
    if (atTopLevel && isHook) found.set(i, raw.trim());
    depth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return found;
}

/** The first early return in a function body, or -1. */
function firstEarlyReturn(lines: string[], start: number, end: number): number {
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]!;
    // Only a return at the function's own indentation. A nested callback's
    // return is not an early exit of the component.
    if (/^ {2}return\b/.test(line)) return i;
  }
  return -1;
}

test('no component calls a hook after an early return', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const component of components(lines)) {
      if (isCustomHook(component.name)) continue;
      const earlyReturn = firstEarlyReturn(lines, component.start, component.end);
      if (earlyReturn < 0) continue;
      for (const [line, text] of hooksIn(lines, component.start, component.end)) {
        if (line > earlyReturn) {
          offenders.push(
            `${file.replace(SRC, 'src')}:${line + 1}: ${text} — in ${component.name}, below the early return on line ${earlyReturn + 1}`,
          );
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `hooks below an early return:\n${offenders.join('\n')}`);
});

test('App specifically keeps its selection hooks above the lock returns', () => {
  // Named explicitly because this is the file it happened in, and because the
  // generic check can pass for the wrong reason if the app is restructured.
  const lines = readFileSync(join(SRC, 'ui', 'App.tsx'), 'utf8').split(/\r?\n/);

  // The guard itself, not any of the `if (vault.status !== 'unlocked') return`
  // lines inside effects above it — those are one-line guards at deeper
  // indentation and have nothing to do with the component's early exit.
  const gate = lines.findIndex((line) => /^ {2}if \(vault\.status !== 'unlocked'\) \{$/.test(line));
  assert.ok(gate > 0, 'the lock return still exists');

  // The five that caused the crash must all sit above it.
  for (const name of ['onSelectForEdit', 'selectedItems', 'shareSelection', 'applySelectionEdit', 'selectionMenu']) {
    const line = lines.findIndex((l) => l.includes(`const ${name} = use`));
    assert.ok(line > 0, `${name} is declared somewhere`);
    assert.ok(line < gate, `${name} must be declared above the lock return on line ${gate + 1}`);
  }
});
