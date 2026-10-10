/**
 * Honest measurements for the Optimize tab.
 *
 * Two things went wrong with the old panel. It claimed savings without showing
 * any evidence, and — because it only ever measured nothing — nobody could tell
 * whether a switch had helped. This hook reads real numbers instead:
 *
 *  - the whole app's process tree, from the desktop shell (browser, renderer,
 *    GPU and utility processes, which is the figure Task Manager shows);
 *  - this page's JavaScript heap, from Chromium's `performance.memory`;
 *  - the document's node count, which is the cheapest proxy for how much the
 *    renderer has to keep alive;
 *  - how many surfaces are painting a backdrop blur right now, counted on
 *    request because it walks the document.
 *
 * Everything here is a measurement, never an estimate, and unavailable
 * readings stay null rather than being filled in with something plausible.
 */

import { useCallback, useEffect, useState } from 'react';
import { getPlatform, type ProcessMemory } from '../lib/platform.ts';

export interface EfficiencySnapshot {
  /**
   * Every app process's working set summed — what a task manager shows, and
   * therefore what a user will compare against. It counts Chromium's shared
   * read-only pages once per process, so it is not what the app uniquely holds.
   * Null in a browser, where there is no process tree to read.
   */
  totalBytes: number | null;
  /**
   * The app's private bytes summed: the honest "how much memory does this take"
   * number, because private pages do not overlap between processes.
   */
  privateBytes: number | null;
  processes: ProcessMemory[];
  /** This page's live JavaScript heap. Null where Chromium will not say. */
  heapBytes: number | null;
  heapLimitBytes: number | null;
  /** Nodes in the document. */
  nodes: number;
  /** Surfaces painting a backdrop blur. Counted on request, else null. */
  blurred: number | null;
}

interface HeapReading {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Chromium's non-standard heap figures. Typed locally: no lib.d.ts entry. */
function heapReading(): HeapReading | null {
  const memory = (performance as Performance & { memory?: HeapReading }).memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return null;
  return memory;
}

/** Elements currently painting a backdrop blur — the per-frame GPU cost the panel talks about. */
function countBlurred(): number {
  let count = 0;
  const all = document.body?.querySelectorAll('*');
  if (!all) return 0;
  for (const element of all) {
    const filter = getComputedStyle(element).backdropFilter;
    if (filter && filter !== 'none') count += 1;
  }
  return count;
}

export async function measureEfficiency(options: { countBlurred?: boolean } = {}): Promise<EfficiencySnapshot> {
  const heap = heapReading();
  let totalBytes: number | null = null;
  let privateBytes: number | null = null;
  let processes: ProcessMemory[] = [];
  const runtime = getPlatform().runtime;
  if (runtime?.memory) {
    try {
      const measured = await runtime.memory();
      if (measured) {
        totalBytes = measured.totalBytes;
        privateBytes = measured.privateTotalBytes;
        processes = measured.processes;
      }
    } catch {
      // A shell that cannot answer leaves the reading null, never a guess.
    }
  }
  return {
    totalBytes,
    privateBytes,
    processes,
    heapBytes: heap ? heap.usedJSHeapSize : null,
    heapLimitBytes: heap ? heap.jsHeapSizeLimit : null,
    nodes: document.getElementsByTagName('*').length,
    blurred: options.countBlurred ? countBlurred() : null,
  };
}

/**
 * Measures once on open and then on every explicit request.
 *
 * Deliberately not on a timer: walking the document to count blurred surfaces
 * every couple of seconds would itself be the kind of background work this
 * panel exists to remove.
 */
export function useEfficiency(active: boolean) {
  const [snapshot, setSnapshot] = useState<EfficiencySnapshot | null>(null);
  const [measuring, setMeasuring] = useState(false);

  const measure = useCallback(async () => {
    setMeasuring(true);
    try {
      setSnapshot(await measureEfficiency({ countBlurred: true }));
    } finally {
      setMeasuring(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void measure();
  }, [active, measure]);

  return { snapshot, measuring, measure };
}

/** Bytes as a short human string. Whole megabytes below a gigabyte, one decimal above. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const mb = bytes / 1_048_576;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
