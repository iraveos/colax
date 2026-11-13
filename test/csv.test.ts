import test from 'node:test';
import assert from 'node:assert/strict';
import { cellAt, columnIndex, csvTable, parseCsv } from '../src/vault/csv.ts';

test('quoted commas stay inside one cell', () => {
  assert.deepEqual(parseCsv('a,b,c\n"one, two",3,4'), [
    ['a', 'b', 'c'],
    ['one, two', '3', '4'],
  ]);
});

test('quoted newlines stay inside one cell instead of inventing rows', () => {
  const rows = parseCsv('name,notes\nBank,"first line\nsecond line"\nShop,ok');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Bank', 'first line\nsecond line']);
  assert.deepEqual(rows[2], ['Shop', 'ok']);
});

test('doubled quotes decode to one quote', () => {
  assert.deepEqual(parseCsv('name,notes\nA,"say ""hello"""'), [
    ['name', 'notes'],
    ['A', 'say "hello"'],
  ]);
});

test('CRLF, LF and a lone CR all end rows', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r3,4\n5,6'), [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
    ['5', '6'],
  ]);
});

test('a UTF-8 BOM does not become part of the first header name', () => {
  const { header } = csvTable('\uFEFFName,URL,Username,Password\nSite,https://x.test,me,x');
  assert.deepEqual(header, ['name', 'url', 'username', 'password']);
});

test('a trailing newline does not create an empty login row', () => {
  const { rows } = csvTable('name,url\nOne,https://one.test\n');
  assert.equal(rows.length, 1);
});

test('blank rows are dropped and ragged rows stay addressable', () => {
  const { rows } = csvTable('name,url\n\nOne,https://one.test\nTwo\n\n');
  assert.equal(rows.length, 2);
  assert.equal(cellAt(rows[1]!, 1), '');
});

test('column names match on common exporter spellings', () => {
  const header = ['name', 'url', 'username', 'password', 'note'];
  assert.equal(columnIndex(header, 'title', 'name'), 0);
  assert.equal(columnIndex(header, 'notes', 'note'), 4);
  assert.equal(columnIndex(header, 'missing'), -1);
});

test('a quote inside an unquoted cell stays literal instead of swallowing rows', () => {
  // Third-party exports write inch marks and stray quotes without quoting the
  // cell. Opening a quoted field mid-cell used to merge every following row
  // into one giant value, which is how one bad line became garbage logins.
  const rows = parseCsv('name,notes\nMonitor,24" screen\nBank,ok');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Monitor', '24" screen']);
  assert.deepEqual(rows[2], ['Bank', 'ok']);
});

test('a Colax text export round-trips: every login stays exactly one row', () => {
  // Mirrors Settings' exportCsv: every cell quoted, CRLF rows, notes carrying
  // commas, quotes and line breaks. The old line-based importer turned those
  // notes into extra phantom logins; this is the regression guard.
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const table: string[][] = [
    ['name', 'url', 'username', 'password', 'notes', 'tags'],
    ['Bank', 'https://bank.test', 'me@example.com', 'p"a,ss', 'line one\nline "two", again', 'money;work'],
    ['Shop', 'https://shop.test', 'shop@example.com', 'hunter2', 'single line', ''],
  ];
  const csv = table.map((cells) => cells.map(escape).join(',')).join('\r\n');
  const parsed = csvTable(csv);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], table[1]);
  assert.deepEqual(parsed.rows[1], table[2]);
});
