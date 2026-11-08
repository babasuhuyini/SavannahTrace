const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtKg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
export const fmtNum = (n: number) => Math.round(n).toLocaleString('en-GB');
export const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

/** Event-local date (YYYY-MM-DD) taken from an ISO string that carries its own offset. */
export const eventDate = (iso: string) => iso.slice(0, 10);

export const mmddyy = (isoDate: string) => isoDate.slice(5, 7) + isoDate.slice(8, 10) + isoDate.slice(2, 4);

function offsetLabel(iso: string) {
  const m = iso.match(/([+-]\d{2}):(\d{2})$/);
  if (!m || iso.endsWith('Z')) return 'UTC';
  const h = parseInt(m[1], 10);
  const mins = m[2] === '00' ? '' : `:${m[2]}`;
  return h === 0 && !mins ? 'UTC+0' : `UTC${h >= 0 ? '+' : ''}${h}${mins}`;
}

/** Formats an event time in the time zone it was recorded in (no browser conversion). */
export function fmtEventTime(iso: string, withZone = true) {
  const d = iso.slice(0, 10);
  const t = iso.slice(11, 16);
  return `${fmtDate(d)}, ${t}${withZone ? ` ${offsetLabel(iso)}` : ''}`;
}

export function fmtDate(isoDate: string) {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function fmtShortDate(isoDate: string) {
  const [, m, d] = isoDate.slice(0, 10).split('-');
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]}`;
}

export function fmtDateRange(a: string, b: string) {
  const da = eventDate(a);
  const db = eventDate(b);
  if (da === db) return fmtDate(da);
  if (da.slice(0, 4) === db.slice(0, 4)) return `${fmtShortDate(da)} – ${fmtDate(db)}`;
  return `${fmtDate(da)} – ${fmtDate(db)}`;
}

/** Recorded timestamps are UTC; show them in the viewer's local time zone. */
export function fmtRecorded(isoUtc: string) {
  const d = new Date(isoUtc);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Convert a <input type="datetime-local"> value + offset into an ISO string with offset. */
export const toEventIso = (local: string, offset: string) => (local ? `${local.length === 16 ? local + ':00' : local}${offset}` : '');

/** Current time as a datetime-local string in the given fixed offset. */
export function nowLocalFor(offset: string) {
  const m = offset.match(/([+-])(\d{2}):(\d{2})/)!;
  const mins = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  const d = new Date(Date.now() + mins * 60_000);
  return d.toISOString().slice(0, 16);
}

export const uid = (prefix: string) => {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${prefix}-${a[0].toString(36)}${a[1].toString(36)}`.slice(0, prefix.length + 12);
};

export function randomToken() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(14);
  crypto.getRandomValues(a);
  return 'tr-' + Array.from(a, (x) => alphabet[x % alphabet.length]).join('');
}
