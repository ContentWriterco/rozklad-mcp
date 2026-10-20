/**
 * Minimal, fast RFC 4180 CSV reader for GTFS files.
 * Handles BOM, quoted fields, escaped quotes and CRLF/LF line endings.
 * `parseCsv` works on a whole string, `CsvStream` on chunks (for huge files).
 */
export type ColFn = (name: string) => number;
export type RowFn = (row: string[], col: ColFn) => void;

export interface CsvTable {
  header: string[];
  forEach(fn: RowFn): void;
}

/**
 * Parse complete rows from text[start..]. When `final` is false, an
 * unterminated last row is left unconsumed. Returns the consumed position.
 */
function parseRows(text: string, start: number, final: boolean, onRow: (r: string[]) => void): number {
  const len = text.length;
  let pos = start;
  while (pos < len) {
    const rowStart = pos;
    const row: string[] = [];
    let complete = false;
    for (;;) {
      if (pos >= len) break;
      let ch = text.charCodeAt(pos);
      if (ch === 34) {
        // quoted field
        let field = "";
        pos++;
        let closed = false;
        while (pos < len) {
          const q = text.indexOf('"', pos);
          if (q === -1) {
            pos = len;
            break;
          }
          field += text.slice(pos, q);
          if (text.charCodeAt(q + 1) === 34) {
            field += '"';
            pos = q + 2;
            continue;
          }
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) break;
        // skip garbage until delimiter
        while (pos < len) {
          ch = text.charCodeAt(pos);
          if (ch === 44 || ch === 10 || ch === 13) break;
          pos++;
        }
        row.push(field);
      } else {
        let end = pos;
        while (end < len) {
          const c = text.charCodeAt(end);
          if (c === 44 || c === 10 || c === 13) break;
          end++;
        }
        row.push(text.slice(pos, end));
        pos = end;
      }
      if (pos >= len) break;
      ch = text.charCodeAt(pos);
      if (ch === 44) {
        pos++;
        if (pos >= len) break;
        continue;
      }
      // newline
      pos++;
      if (ch === 13 && pos < len && text.charCodeAt(pos) === 10) pos++;
      else if (ch === 13 && pos >= len && !final) {
        // CR at chunk end: LF may follow in next chunk - harmless, blank line is skipped
      }
      complete = true;
      break;
    }
    if (!complete) {
      if (!final) return rowStart;
      if (row.length) onRow(row);
      return len;
    }
    if (!(row.length === 1 && row[0] === "")) onRow(row);
  }
  return pos;
}

function makeCol(header: string[]): ColFn {
  const index = new Map<string, number>();
  header.forEach((h, i) => index.set(h.trim(), i));
  return (name: string) => index.get(name) ?? -1;
}

export function parseCsv(text: string): CsvTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // header = first non-empty line
  let header: string[] = [];
  const nl = text.search(/\r?\n/);
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  parseRows(firstLine + "\n", 0, true, (r) => {
    if (!header.length) header = r.map((h) => h.trim());
  });
  return {
    header,
    forEach(fn) {
      const col = makeCol(header);
      let first = true;
      parseRows(text, 0, true, (r) => {
        if (first) {
          first = false;
          return;
        }
        fn(r, col);
      });
    },
  };
}

/** Incremental parser: push decoded text chunks, rows are emitted as they complete. */
export class CsvStream {
  private buf = "";
  private header: string[] | null = null;
  private col: ColFn = () => -1;
  private first = true;
  constructor(private onRow: RowFn) {}
  push(chunk: string, final: boolean) {
    let text = this.buf + chunk;
    if (this.first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.first = false;
    }
    const used = parseRows(text, 0, final, (r) => {
      if (!this.header) {
        this.header = r.map((h) => h.trim());
        this.col = makeCol(this.header);
        return;
      }
      this.onRow(r, this.col);
    });
    this.buf = text.slice(used);
  }
}
