// Cell parsers for bulk upload. They accept the formats people actually type or Excel
// produces, and report anything ambiguous instead of guessing. Identifiers (lot IDs,
// collector codes, area codes, LPO / SFCL numbers) are only trimmed — never rewritten.

/** Header / alias normaliser: "Collector Code" → "collectorcode". */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Undo the spreadsheet formula guard our own CSV exports add ('=…). Only for those characters. */
export const clean = (s: string | undefined) => {
  const t = (s ?? '').replace(/ /g, ' ').trim();
  return /^'[=+\-@]/.test(t) ? t.slice(1) : t;
};

/** Number: "1250", "1,250", "1250.5", Excel numbers. Decimal commas are refused (ambiguous). */
export function parseNum(s: string): { value?: number; error?: string } {
  const t = s.replace(/\s/g, '');
  if (!t) return {};
  if (/^-?\d+(\.\d+)?$/.test(t) || /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) || /^-?\d+(\.\d+)?e[+-]?\d+$/i.test(t)) return { value: Number(t.replace(/,/g, '')) };
  if (/^-?\d+,\d+$/.test(t)) return { error: `"${s}" uses a decimal comma. Use a point, e.g. ${t.replace(',', '.')}.` };
  return { error: `"${s}" is not a number.` };
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Excel serial day number → ISO date (1900 date system). */
function excelDate(n: number) {
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400_000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Date: 2026-07-14 · 14/07/2026 · 14-07-2026 · 14.07.2026 · 14 Jul 2026 · Excel date numbers.
 * Day/month order is day first (Ghana / UK). Anything else is refused, never guessed.
 */
export function parseDate(s: string): { value?: string; time?: string; error?: string } {
  const t = s.trim();
  if (!t) return {};
  let m: RegExpMatchArray | null;
  if (/^\d{4,5}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 20000 && n < 80000) {
      const frac = n - Math.floor(n);
      return { value: excelDate(n), time: frac > 0 ? excelTime(frac) : undefined };
    }
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}:\d{2}(?::\d{2})?))?/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validDate(y, mo, d) ? { value: `${y}-${pad(mo)}-${pad(d)}`, time: m[4] } : { error: `"${s}" is not a real date.` };
  }
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?))?$/i))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [d, mo] = [+m[1], +m[2]];
    if (mo > 12 && d <= 12) return { error: `"${s}" looks like month/day order. Use day/month/year (e.g. ${pad(mo)}/${pad(d)}/${y}) or YYYY-MM-DD.` };
    return validDate(y, mo, d) ? { value: `${y}-${pad(mo)}-${pad(d)}`, time: m[4] } : { error: `"${s}" is not a real date (dates are read as day/month/year).` };
  }
  if ((m = t.match(/^(\d{1,2})[ -]([a-z]{3,9})[ -,]*(\d{4})$/i))) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (mo && validDate(+m[3], mo, +m[1])) return { value: `${m[3]}-${pad(mo)}-${pad(+m[1])}` };
  }
  return { error: `"${s}" is not a date this upload understands. Use YYYY-MM-DD, e.g. 2026-07-14.` };
}

function excelTime(frac: number) {
  const mins = Math.round(frac * 24 * 60);
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}

/** Time: 08:30 · 8:30 · 08:30:00 · 8:30 AM · Excel time fractions. */
export function parseTime(s: string): { value?: string; error?: string } {
  const t = s.trim();
  if (!t) return {};
  if (/^0?\.\d+$/.test(t)) return { value: excelTime(Number(t)) };
  const m = t.match(/^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return { error: `"${s}" is not a time. Use 24-hour HH:MM, e.g. 08:30.` };
  let h = +m[1];
  const min = +m[2];
  if (m[4]) {
    const pm = /p/i.test(m[4]);
    if (h < 1 || h > 12) return { error: `"${s}" is not a valid time.` };
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59) return { error: `"${s}" is not a valid time.` };
  return { value: `${pad(h)}:${pad(min)}` };
}

/** Time zone offset: +00:00, UTC, GMT, UTC+1, +1, +0100, CET/CEST. */
export function parseOffset(s: string): { value?: string; error?: string } {
  const t = s.trim().toUpperCase().replace(/\s/g, '');
  if (!t) return {};
  if (['UTC', 'GMT', 'Z', 'UTC+0', 'GMT+0', '+0', '0', 'GHANA'].includes(t)) return { value: '+00:00' };
  if (t === 'CET') return { value: '+01:00' };
  if (t === 'CEST') return { value: '+02:00' };
  const m = t.replace(/^(UTC|GMT)/, '').match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m || +m[2] > 14) return { error: `"${s}" is not a time zone offset. Use +00:00 (Ghana), +01:00 or +02:00 (Netherlands).` };
  return { value: `${m[1]}${pad(+m[2])}:${m[3] ?? '00'}` };
}

export function parseYes(s: string): { value?: boolean; error?: string } {
  const t = s.trim().toLowerCase();
  if (!t) return {};
  if (['yes', 'y', 'true', '1', 'x'].includes(t)) return { value: true };
  if (['no', 'n', 'false', '0'].includes(t)) return { value: false };
  return { error: `"${s}" should be yes or no.` };
}

/** Lower-case slug for internal location codes (not business identifiers). */
export const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Polygon from a cell: GeoJSON (FeatureCollection, Feature, Polygon, single MultiPolygon,
 * or a bare ring) in [lng, lat] order, or plain text "lat, lng; lat, lng; …" (one vertex per
 * pair, like the area editor). Returns a closed ring in [lng, lat] order.
 */
export function parsePolygon(s: string): { ring?: [number, number][]; error?: string; warning?: string } {
  const t = s.trim();
  if (!t) return {};
  let warning: string | undefined;
  let ring: unknown;
  if (/^[[{]/.test(t)) {
    let g: unknown;
    try {
      g = JSON.parse(t);
    } catch {
      return { error: 'The polygon is not valid GeoJSON (the cell may have been cut off — Excel cells hold at most 32,767 characters).' };
    }
    const geoms: { type: string; coordinates: unknown }[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      const o = x as { type?: string; features?: unknown[]; geometry?: unknown; geometries?: unknown[]; coordinates?: unknown };
      if (o.type === 'FeatureCollection') o.features?.forEach(walk);
      else if (o.type === 'Feature') walk(o.geometry);
      else if (o.type === 'GeometryCollection') o.geometries?.forEach(walk);
      else if (o.type === 'Polygon' || o.type === 'MultiPolygon') geoms.push(o as { type: string; coordinates: unknown });
    };
    if (Array.isArray(g)) ring = Array.isArray((g as unknown[])[0]) && Array.isArray(((g as unknown[])[0] as unknown[])[0]) ? (g as unknown[])[0] : g;
    else {
      walk(g);
      if (geoms.length === 0) return { error: 'The GeoJSON has no Polygon in it.' };
      if (geoms.length > 1) return { error: `The GeoJSON has ${geoms.length} separate shapes. One collection area needs one boundary.` };
      const geom = geoms[0];
      let rings = geom.coordinates as unknown[];
      if (geom.type === 'MultiPolygon') {
        if ((rings as unknown[]).length !== 1) return { error: 'The MultiPolygon has several parts. One collection area needs one boundary.' };
        rings = (rings as unknown[][])[0];
      }
      if ((rings as unknown[]).length > 1) warning = 'The boundary has holes; only the outer boundary is used.';
      ring = rings[0];
    }
    if (!Array.isArray(ring)) return { error: 'The polygon has no coordinates.' };
    const pts: [number, number][] = [];
    for (const p of ring as unknown[]) {
      if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) return { error: 'The polygon has a vertex that is not a [longitude, latitude] pair.' };
      pts.push([p[0] as number, p[1] as number]);
    }
    return finishRing(pts, warning);
  }
  const pairs = t.split(/\s*[;\n|]\s*/).filter(Boolean);
  const pts: [number, number][] = [];
  for (const p of pairs) {
    const nums = p.split(/[,\s]+/).filter(Boolean).map(Number);
    if (nums.length !== 2 || !nums.every(Number.isFinite)) return { error: `"${p}" is not a "lat, lng" pair. Separate vertices with semicolons.` };
    pts.push([nums[1], nums[0]]);
  }
  return finishRing(pts, warning);
}

function finishRing(pts: [number, number][], warning?: string): { ring?: [number, number][]; error?: string; warning?: string } {
  if (pts.some(([lng, lat]) => Math.abs(lat) > 90 || Math.abs(lng) > 180)) return { error: 'A vertex is outside valid latitude/longitude ranges.' };
  const first = pts[0];
  const last = pts[pts.length - 1];
  const closed = pts.length > 1 && first[0] === last[0] && first[1] === last[1];
  const open = closed ? pts.slice(0, -1) : pts;
  if (new Set(open.map((p) => p.join(','))).size < 3) return { error: 'A boundary needs at least 3 different vertices.' };
  return { ring: [...open, open[0]], warning };
}

/** Centre of a closed ring (vertex average; fine for sanity checks). */
export function ringCentre(ring: [number, number][]): [number, number] {
  const open = ring.slice(0, -1);
  return [open.reduce((s, p) => s + p[0], 0) / open.length, open.reduce((s, p) => s + p[1], 0) / open.length];
}

/** Great-circle distance in km. */
export function km(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export async function hashHex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
