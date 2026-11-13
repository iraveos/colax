/**
 * CSV reading for the vault's import path.
 *
 * The previous importer split the file into lines before looking at quotes, so
 * any note containing a comma or a line break came back as several phantom
 * logins whose names and passwords were fragments of someone else's note. The
 * file was valid CSV, it was the reader that was wrong.
 *
 * This is a small RFC 4180 state machine instead: quotes protect commas and
 * newlines, doubled quotes are an escaped quote, and CRLF, LF and a lone CR all
 * count as a row break outside quotes. It deliberately stays dependency-free and
 * framework-free like the rest of `vault/`, so a test can feed it any file a
 * browser exports.
 */

/** One parsed CSV cell, still a string: coercion belongs to the importer. */
export type CsvRow = string[];

/**
 * Parses a whole CSV document.
 *
 * Blank trailing rows are dropped, because most exporters end the file with a
 * newline and an empty row would otherwise become a login with no fields.
 * Rows with genuinely empty fields are kept: a login with no password is still
 * a login.
 */
export function parseCsv(text: string): CsvRow[] {
  // A UTF-8 BOM is common in files written by spreadsheets. It would otherwise
  // become part of the first header name, so "name" would never match.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let row: CsvRow = [];
  let cell = '';
  let quoted = false;
  let touched = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
    touched = true;
  };
  const endRow = () => {
    endCell();
    // A row of one empty cell is a blank line, not a record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      // RFC 4180 only opens a quoted field at the start of a cell. A quote in
      // the middle of an unquoted cell (an inch mark, a stray quote in someone
      // else's export) is literal text; treating it as an opening quote used to
      // swallow every following row into one cell, which is how one bad line
      // became a single login named after the rest of the file.
      if (cell === '') {
        quoted = true;
        touched = true;
        continue;
      }
      cell += char;
      touched = true;
      continue;
    }
    if (char === ',') {
      endCell();
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    cell += char;
    touched = true;
  }

  // A final row without a closing newline is still a row.
  if (touched || cell !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Splits a parsed document into its header and data rows.
 *
 * Header names are trimmed, lowercased and stripped of surrounding whitespace,
 * so `"Name"`, ` name` and `NAME` all name the same column.
 */
export function csvTable(text: string): { header: string[]; rows: CsvRow[] } {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return { header: [], rows: [] };
  const [first, ...rest] = parsed;
  return {
    header: (first ?? []).map((name) => name.trim().toLowerCase()),
    rows: rest.filter((row) => row.some((cell) => cell.trim() !== '')),
  };
}

/**
 * The index of the first column matching any of `names`, or -1.
 *
 * Exporters disagree on spelling — Chrome writes `name`, `url`, `username`,
 * `password`, `note`; Bitwarden writes `login_uri` and `login_password` — so
 * importers give a list of acceptable names rather than one exact string.
 */
export function columnIndex(header: readonly string[], ...names: readonly string[]): number {
  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    const index = header.indexOf(wanted);
    if (index !== -1) return index;
  }
  return -1;
}

/** A cell by position, with a missing/ragged row returning the empty string. */
export function cellAt(row: readonly string[], index: number): string {
  return index >= 0 ? (row[index] ?? '') : '';
}
