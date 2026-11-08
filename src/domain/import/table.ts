// Reading uploaded spreadsheets: CSV (any of , ; or tab, UTF-8 or Windows-1252, as saved by
// Excel) and .xlsx (read directly, no extra library). Everything happens in the browser; the
// file is never uploaded anywhere as a file — only the validated rows are sent to the server.

export interface Sheet {
  name: string;
  rows: string[][];
}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024; // guards against "zip bombs"
const MAX_ROWS = 20_000;

/** Decode bytes as UTF-8 if valid, otherwise as Windows-1252 (Excel's "CSV" on Windows). */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** RFC 4180 CSV parser with delimiter detection (comma, semicolon, tab). */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const outside = firstLine.replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map((d) => [d, outside.split(d).length - 1] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_ROWS) throw new Error(`The file has more than ${MAX_ROWS.toLocaleString('en-GB')} rows. Split it into smaller files.`);
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return trimEmpty(rows);
}

const trimEmpty = (rows: string[][]) => {
  const out = rows.map((r) => r.map((c) => c ?? ''));
  while (out.length && out[out.length - 1].every((c) => !c.trim())) out.pop();
  return out;
};

// ── minimal .xlsx reader (ZIP + SpreadsheetML) ───────────────────────────────
interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

function readZipDirectory(buf: ArrayBuffer): Map<string, ZipEntry> {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file. Save it again from Excel, or save it as CSV.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The .xlsx file is damaged.');
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error('The .xlsx file is too large once unpacked. Save the sheet as CSV instead.');
    entries.set(name, { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipFile(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const v = new DataView(buf);
  if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error('The .xlsx file is damaged.');
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('Unsupported compression in the .xlsx file. Save it as CSV instead.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read .xlsx files. Save the sheet as CSV (UTF-8) instead.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = await new Response(stream).arrayBuffer();
  if (out.byteLength > MAX_UNZIPPED_BYTES) throw new Error('The .xlsx file is too large once unpacked.');
  return new TextDecoder().decode(out);
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const all = (n: Document | Element, tag: string) => Array.from(n.getElementsByTagNameNS('*', tag));
const textOf = (n: Element) => all(n, 't').map((t) => t.textContent ?? '').join('');
const colIndex = (ref: string) => {
  const letters = ref.replace(/\d+$/, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const zip = readZipDirectory(buf);
  const get = async (name: string) => {
    const e = zip.get(name);
    return e ? readZipFile(buf, e) : null;
  };
  const wb = await get('xl/workbook.xml');
  if (!wb) throw new Error('This .xlsx file has no workbook. Save it again from Excel, or save it as CSV.');
  const rels = xml((await get('xl/_rels/workbook.xml.rels')) ?? '<Relationships/>');
  const target = new Map(all(rels, 'Relationship').map((r) => [r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? ''] as const));
  const ssText = await get('xl/sharedStrings.xml');
  const shared = ssText ? all(xml(ssText), 'si').map(textOf) : [];
  const sheets: Sheet[] = [];
  for (const s of all(xml(wb), 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id') ?? '';
    let t = target.get(rid) ?? '';
    t = t.startsWith('/') ? t.slice(1) : t.startsWith('xl/') ? t : `xl/${t}`;
    const body = await get(t);
    if (!body) continue;
    const rows: string[][] = [];
    for (const r of all(xml(body), 'row')) {
      const idx = Number(r.getAttribute('r') ?? rows.length + 1) - 1;
      if (idx >= MAX_ROWS) throw new Error(`The sheet has more than ${MAX_ROWS.toLocaleString('en-GB')} rows. Split it into smaller files.`);
      const row: string[] = [];
      for (const c of all(r, 'c')) {
        const ref = c.getAttribute('r');
        const ci = ref ? colIndex(ref) : row.length;
        const type = c.getAttribute('t');
        const v = all(c, 'v')[0]?.textContent ?? '';
        row[ci] = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? textOf(c) : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      }
      while (rows.length < idx) rows.push([]);
      rows[idx] = Array.from(row, (x) => x ?? '');
    }
    sheets.push({ name: s.getAttribute('name') ?? `Sheet ${sheets.length + 1}`, rows: trimEmpty(rows) });
  }
  return sheets;
}

/** Read an uploaded .csv / .tsv / .txt / .xlsx file into one or more sheets of text cells. */
export async function readTableFile(file: File): Promise<Sheet[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Split it into smaller files.`);
  const buf = await file.arrayBuffer();
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xls')) throw new Error('Old .xls files are not supported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV UTF-8.');
  const isZip = buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
  if (lower.endsWith('.xlsx') || isZip) return readXlsx(buf);
  return [{ name: file.name, rows: parseCsv(decodeText(buf)) }];
}
