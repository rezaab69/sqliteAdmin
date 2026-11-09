// Value encoding, literals and CSV helpers used by the API layer.
import path from 'node:path';

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (message, status = 400) => { throw new HttpError(status, message); };

/** A worker process's own directory for temporary files inside its workspace's `tmpDir`. */
export const scratchDir = (tmpDir, pid) => path.join(tmpDir, `worker-${pid}`);

const MAGIC = [
  ['89504e47', 'image/png'], ['ffd8ff', 'image/jpeg'], ['47494638', 'image/gif'],
  ['52494646', 'image/webp'], ['25504446', 'application/pdf'], ['504b0304', 'application/zip'],
  ['1f8b', 'application/gzip'], ['53514c69746520666f726d6174', 'application/x-sqlite3'],
  ['424d', 'image/bmp'], ['00000100', 'image/x-icon'],
];

export function sniffMime(bytes) {
  const head = Buffer.from(bytes.subarray(0, 16)).toString('hex');
  for (const [sig, mime] of MAGIC) if (head.startsWith(sig)) return mime;
  return 'application/octet-stream';
}

/** Convert a value read from SQLite into a JSON-safe value. */
export function encodeValue(v, fullBlob = false) {
  if (typeof v === 'bigint') return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : { $bigint: v.toString() };
  if (v instanceof Uint8Array) {
    if (fullBlob) return { $blob: Buffer.from(v).toString('base64') };
    return { $blob: true, size: v.length, hex: Buffer.from(v.subarray(0, 48)).toString('hex'), mime: sniffMime(v) };
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return { $real: String(v) };
  return v;
}

/** Convert a JSON value from the client into a value bindable to SQLite. */
export function decodeValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  // node:sqlite binds JS numbers as REAL; bind whole numbers as INTEGER instead.
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (v && typeof v === 'object') {
    if (typeof v.$bigint === 'string') return BigInt(v.$bigint);
    if (typeof v.$blob === 'string') return new Uint8Array(Buffer.from(v.$blob, 'base64'));
    if (typeof v.$hex === 'string') return new Uint8Array(Buffer.from(v.$hex.replace(/\s+/g, ''), 'hex'));
    if (typeof v.$real === 'string') return Number(v.$real);
    return JSON.stringify(v);
  }
  return v;
}

/** Render a value as an SQL literal (for dumps and for displaying executed statements). */
export function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    // Integers are read as BigInt, so a JS number is always a REAL value.
    if (Number.isNaN(v)) return 'NULL';
    if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999';
    const s = String(v);
    return /[.eE]/.test(s) ? s : s + '.0';
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex').toUpperCase() + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Replace ? placeholders in sql with literal values, for display purposes only. */
export function inlineParams(sql, params, maxLen = 200) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) return '?';
    const lit = literal(params[i++]);
    return lit.length > maxLen ? lit.slice(0, maxLen) + '…' : lit;
  });
}

/** Parse CSV text (RFC 4180, quotes and embedded newlines supported). */
export function parseCsv(text, delimiter = ',') {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function csvField(v, delimiter, nullText) {
  if (v === null || v === undefined) return nullText;
  const s = v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') || s !== s.trim()) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function jsonValue(v) {
  if (typeof v === 'bigint') return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}
