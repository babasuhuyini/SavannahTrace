// Bulk upload definitions: one per kind of data entry. Each turns spreadsheet rows into
// the SAME records the on-screen forms create, then runs the same validation engine.
// Identifiers are matched exactly and never repaired; anything uncertain is an error or a
// warning for a person to check, not a silent fix. The server re-validates every entry.

import type { CollectionArea, Collector, CommissionEvent, DeliverEvent, IssueEvent, Location, LocationKind, LotQty, ProcessingGroup, ProductCode, ReadyEvent, ReceiveEvent, RoleId, ShipEvent, TraceEvent, TransformEvent, TransformKind } from '../../data/types';
import { PRODUCTS } from '../../data/types';
import type { Viewer } from '../access';
import { analyze, transformRule, type Analysis, type Place } from '../engine';
import { fmtKg, mmddyy } from '../format';
import { ROLES } from '../roles';
import type { BulkEvent } from '../storeTypes';
import type { DemoDB } from '../../data/types';
import { clean, hashHex, km, norm, parseDate, parseNum, parseOffset, parsePolygon, parseTime, parseYes, ringCentre, slug } from './values';

export type ImportKind = 'collection_areas' | 'collectors' | 'locations' | 'groups' | 'purchases' | 'shipments' | 'receipts' | 'issues' | 'processing' | 'aggregation' | 'ready' | 'deliveries';

export interface Col {
  key: string;
  label: string;
  aliases?: string[];
  required?: boolean;
  help: string;
}

export interface Row {
  /** Spreadsheet row number (1-based, as Excel shows it). */
  _row: number;
  v: Record<string, string>;
  raw: string[];
}

export interface Entry {
  id: string;
  rows: number[];
  label: string;
  errors: string[];
  warnings: string[];
  /** Master data: the record already exists and will be updated. */
  update?: boolean;
  /** Event already imported earlier (same content) — will be skipped by the server. */
  duplicate?: boolean;
  master?: Record<string, unknown>;
  bulk?: BulkEvent;
}

export interface Ctx {
  db: DemoDB;
  analysis: Analysis;
  viewer: Viewer | null;
  role: RoleId;
  mode: 'demo' | 'live';
  fileName: string;
  options: Record<string, boolean>;
}

export interface Spec {
  kind: ImportKind;
  title: string;
  description: string;
  group: 'master' | 'event';
  columns: Col[];
  options?: { key: string; label: string; help: string }[];
  /** Example rows for the template (written as comment rows starting with #, which uploads ignore). */
  example: (ctx: Ctx) => string[][];
  /** Real rows to complete (e.g. open shipments for receipts). */
  prefill?: (ctx: Ctx) => string[][];
  prepare: (rows: Row[], ctx: Ctx) => Promise<Entry[]>;
}

// ── shared column definitions ────────────────────────────────────────────────
const C = {
  date: (label = 'date', aliases: string[] = []): Col => ({ key: 'date', label, aliases: ['date', 'event date', ...aliases], required: true, help: 'YYYY-MM-DD (e.g. 2026-07-14) or day/month/year (14/07/2026).' }),
  time: (): Col => ({ key: 'time', label: 'time', aliases: ['event time', 'time (24h)', 'hour'], required: true, help: '24-hour HH:MM, when it actually happened (e.g. 08:30).' }),
  tz: (): Col => ({ key: 'timezone', label: 'timezone', aliases: ['tz', 'time zone', 'offset', 'utc offset'], help: 'Optional. +00:00 for Ghana (default), +01:00 / +02:00 for the Netherlands.' }),
  lot: (help = 'Lot / batch ID, exactly as recorded.'): Col => ({ key: 'lot_id', label: 'lot_id', aliases: ['lot', 'lot id', 'lot no', 'lot number', 'batch', 'batch id', 'batch no', 'lpo', 'lpo number'], required: true, help }),
  qty: (key = 'quantity_kg', aliases: string[] = []): Col => ({ key, label: key, aliases: ['quantity', 'qty', 'kg', 'quantity (kg)', 'weight', 'weight kg', 'net weight', ...aliases], required: true, help: 'Kilograms, using a decimal point (e.g. 1250.5).' }),
  notes: (): Col => ({ key: 'notes', label: 'notes', aliases: ['note', 'remarks', 'comment', 'comments'], help: 'Optional.' }),
};

// ── helpers ──────────────────────────────────────────────────────────────────
const MAX_FUTURE_MS = 5 * 60_000;
const EXPORT_KINDS = new Set(['warehouse', 'port', 'terminal', 'destination-warehouse', 'refiner', 'filterer']);
const nameOf = (ctx: Ctx, id: string) => ctx.analysis.places.get(id)?.name.replace(/^DEMO /, '') ?? id;

/** Resolve a place by its code, its exact name, or (collection areas) its area code. */
function findPlace(ctx: Ctx, raw: string, kinds?: string[]): { place?: Place; error?: string } {
  const s = raw.trim();
  if (!s) return { error: 'is empty' };
  const places = [...ctx.analysis.places.values()].filter((p) => !kinds || kinds.includes(p.kind));
  const byId = places.filter((p) => p.id.toLowerCase() === s.toLowerCase());
  if (byId.length === 1) return { place: byId[0] };
  const area = ctx.db.collectionAreas.find((a) => a.code === s);
  if (area && ctx.analysis.places.get(area.id) && (!kinds || kinds.includes('collection-area'))) return { place: ctx.analysis.places.get(area.id) };
  const byName = places.filter((p) => norm(p.name) === norm(s) || norm(p.name.replace(/^DEMO /, '')) === norm(s));
  if (byName.length === 1) return { place: byName[0] };
  if (byName.length > 1) return { error: `"${s}" matches ${byName.length} places — use the location code instead (${byName.map((p) => p.id).join(', ')})` };
  return { error: `"${s}" is not a known ${kinds?.length === 1 ? kinds[0].replace('-', ' ') : 'location'}` };
}

const mine = (ctx: Ctx, id: string) => !!ctx.viewer?.locations.has(id);

/** Event time from date + time + timezone columns (or a date cell that carries a time). */
function eventTime(r: Row, _ctx: Ctx, at?: Place): { iso?: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const d = parseDate(r.v.date ?? '');
  const t = parseTime(r.v.time ?? '');
  const z = parseOffset(r.v.timezone ?? '');
  if (d.error) errors.push(`Date: ${d.error}`);
  else if (!d.value) errors.push('Date is empty.');
  const time = t.value ?? (d.time ? parseTime(d.time).value : undefined);
  if (t.error) errors.push(`Time: ${t.error}`);
  else if (!time) errors.push('Time is empty. Give the time it actually happened (HH:MM).');
  if (z.error) errors.push(`Time zone: ${z.error}`);
  let offset = z.value;
  if (!offset) {
    offset = at && at.lat > 30 ? '+01:00' : '+00:00';
    if (at && at.lat > 30) warnings.push('No time zone given for a Netherlands location: +01:00 assumed. Use +02:00 for summer time.');
  }
  if (errors.length || !d.value || !time) return { errors, warnings };
  const iso = `${d.value}T${time}:00${offset}`;
  if (Date.parse(iso) > Date.now() + MAX_FUTURE_MS) errors.push('The event time is in the future.');
  return { iso, errors, warnings };
}

function base<T extends TraceEvent['type']>(type: T, locationId: string, eventTime: string, ctx: Ctx, hash: string) {
  return { id: `ev-b${hash.slice(0, 14)}`, type, locationId, eventTime, recordedAt: new Date().toISOString(), recordedBy: ctx.role, version: 1, idempotencyKey: `bulk-${hash.slice(0, 32)}` };
}

/** Rows sharing a reference form one entry; rows with a blank reference stand alone. */
function groupBy(rows: Row[], key: string): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = (r.v[key] ?? '').trim();
    const g = k ? `k:${k}` : `r:${r._row}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return [...groups.values()];
}

/** A value that must be the same on every row of a group. */
function same(rows: Row[], key: string, label: string, errors: string[]): string {
  const vals = [...new Set(rows.map((r) => (r.v[key] ?? '').trim()).filter(Boolean))];
  if (vals.length > 1) errors.push(`Rows ${rows.map((r) => r._row).join(', ')} give different ${label}: ${vals.map((v) => `"${v}"`).join(' / ')}. They must match within one entry.`);
  return vals[0] ?? '';
}

function qtyOf(r: Row, key: string, errors: string[], allowZero = false): number {
  const q = parseNum(r.v[key] ?? '');
  if (q.error) errors.push(`Row ${r._row}: quantity ${q.error}`);
  else if (q.value === undefined) errors.push(`Row ${r._row}: quantity is empty.`);
  else if (q.value < 0 || (!allowZero && q.value === 0)) errors.push(`Row ${r._row}: quantity must be more than 0.`);
  return q.value ?? 0;
}

function lotLine(ctx: Ctx, r: Row, errors: string[], key = 'quantity_kg'): LotQty | null {
  const lotId = (r.v.lot_id ?? '').trim();
  if (!lotId) {
    errors.push(`Row ${r._row}: lot ID is empty.`);
    return null;
  }
  const lot = ctx.analysis.lots.get(lotId);
  if (!lot) {
    const ci = [...ctx.analysis.lots.keys()].find((k) => k.toLowerCase() === lotId.toLowerCase());
    errors.push(`Row ${r._row}: "${lotId}" is not a known lot${ci ? ` (did you mean "${ci}"? IDs must match exactly)` : ''}.`);
    return null;
  }
  return { lotId, product: lot.product, qty: qtyOf(r, key, errors) };
}

function dupLots(lines: LotQty[], errors: string[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.lotId)) errors.push(`Lot ${l.lotId} appears more than once in this entry. Put the total on one row.`);
    seen.add(l.lotId);
  }
}

/** Finish event entries: stable ids/keys from content, then the validation engine over all of them. */
async function finishEvents(kind: ImportKind, ctx: Ctx, drafts: { rows: Row[]; label: string; errors: string[]; warnings: string[]; build?: (hash: string) => Omit<BulkEvent, 'key'> }[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  const knownKeys = new Set(ctx.db.events.map((e) => e.idempotencyKey).filter(Boolean));
  for (const d of drafts) {
    const hash = await hashHex(`${kind}|${JSON.stringify(d.rows.map((r) => r.v))}`);
    const e: Entry = { id: hash.slice(0, 16), rows: d.rows.map((r) => r._row), label: d.label, errors: d.errors, warnings: d.warnings };
    if (!d.errors.length && d.build) {
      const b = d.build(hash);
      const key = `bulk-${hash.slice(0, 32)}`;
      e.bulk = { ...b, key, event: { ...b.event, idempotencyKey: key } };
      if (knownKeys.has(key)) e.duplicate = true;
    }
    entries.push(e);
  }
  engineCheck(ctx.db, entries.filter((e) => e.bulk && !e.duplicate));
  return entries;
}

/** Run the same rules as the forms over all new events together; drop blocking ones and re-check. */
function engineCheck(db: DemoDB, entries: Entry[]) {
  let active = entries;
  const review = new Map<Entry, string[]>();
  for (let pass = 0; pass < 6 && active.length; pass++) {
    const next = analyze({ ...db, events: [...db.events, ...active.map((e) => e.bulk!.event)] });
    let blocked = false;
    for (const e of active) {
      const own = next.findings.filter((f) => f.eventId === e.bulk!.event.id);
      const blocking = own.filter((f) => f.severity === 'blocking');
      if (blocking.length) {
        e.errors.push(...blocking.map((f) => f.message));
        blocked = true;
      }
      review.set(e, own.filter((f) => f.severity === 'review').map((f) => f.message));
    }
    if (!blocked) break;
    active = active.filter((e) => !e.errors.length);
  }
  for (const [e, msgs] of review) if (!e.errors.length) e.warnings.push(...msgs);
}

// ── master data ──────────────────────────────────────────────────────────────
const KIND_ALIASES: Record<LocationKind, string[]> = {
  phc: ['phc', 'post harvest centre', 'post-harvest centre', 'post harvest center', 'postharvestcentre'],
  'butter-centre': ['butter centre', 'butter center', 'butter-centre', 'bc', 'butter processing centre'],
  warehouse: ['warehouse', 'store'],
  port: ['port'],
  terminal: ['terminal', 'arrival terminal'],
  'destination-warehouse': ['destination warehouse', 'destination-warehouse', 'eu warehouse'],
  refiner: ['refiner', 'refinery'],
  filterer: ['filterer', 'filtering', 'filter plant'],
  client: ['client', 'client site', 'customer'],
};
const KIND_LABEL: Record<LocationKind, string> = {
  phc: 'Post-harvest centre',
  'butter-centre': 'Shea butter processing centre',
  warehouse: 'Warehouse',
  port: 'Port of export',
  terminal: 'Arrival terminal',
  'destination-warehouse': 'Destination warehouse',
  refiner: 'Refinery',
  filterer: 'Filtering partner',
  client: 'Client site',
};

function coords(r: Row, errors: string[], warnings: string[]): { lat?: number; lng?: number } {
  const la = parseNum(r.v.latitude ?? '');
  const lo = parseNum(r.v.longitude ?? '');
  if (la.error) errors.push(`Latitude: ${la.error}`);
  if (lo.error) errors.push(`Longitude: ${lo.error}`);
  if (la.value !== undefined && Math.abs(la.value) > 90) errors.push('Latitude must be between -90 and 90.');
  if (lo.value !== undefined && Math.abs(lo.value) > 180) errors.push('Longitude must be between -180 and 180.');
  if ((la.value === undefined) !== (lo.value === undefined)) warnings.push('Only one of latitude / longitude is filled in.');
  return { lat: la.value, lng: lo.value };
}

const areasSpec: Spec = {
  kind: 'collection_areas',
  group: 'master',
  title: 'Collection areas',
  description:
    'One row per collection site with its boundary. Your coordinates sheet can be uploaded as it is (COLLECTION AREA, Heading, Latitude, Long, Polygon) once an area_code column is added: areas are keyed by their account code (e.g. NE06-CA1332), which the system never invents.',
  columns: [
    { key: 'area_code', label: 'area_code', aliases: ['area code', 'account', 'account code', 'wholechain account', 'ca code', 'code', 'collection area code'], required: true, help: 'Operational-area prefix + CA code, e.g. NE06-CA1332. Must be unique.' },
    { key: 'name', label: 'name', aliases: ['collection area', 'collection area name', 'site', 'community', 'area name'], required: true, help: 'Name of the collection site.' },
    { key: 'operational_area', label: 'operational_area', aliases: ['operational area', 'district', 'heading', 'area'], required: true, help: 'e.g. Bimbila. A "Heading" like “Bimbila Collection Area: Achiriyili” is read as Bimbila.' },
    { key: 'polygon', label: 'polygon', aliases: ['geometry', 'geojson', 'boundary', 'shape', 'coordinates'], required: true, help: 'GeoJSON (as exported from Google My Maps / QGIS) or “lat, lng; lat, lng; …”.' },
    { key: 'latitude', label: 'latitude', aliases: ['lat'], help: 'Optional, used only to double-check the polygon position.' },
    { key: 'longitude', label: 'longitude', aliases: ['long', 'lng', 'lon'], help: 'Optional, as above.' },
    { key: 'geometry_source', label: 'geometry_source', aliases: ['source', 'geometry source'], help: 'Optional. Where the boundary came from (survey, date).' },
  ],
  example: () => [
    ['NE06-CA1332', 'Achiriyili Bimbila', 'Bimbila', '{"type":"Polygon","coordinates":[[[0.0193,9.1434],[0.0234,9.1456],[0.0063,9.1738],[-0.0168,9.1597],[0.0193,9.1434]]]}', '9.1596', '0.0026', 'Field survey 2025'],
  ],
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const code = (r.v.area_code ?? '').trim();
      const name = (r.v.name ?? '').trim();
      let op = (r.v.operational_area ?? '').trim();
      const heading = op.match(/^(.*?)\s+Collection Area\b/i);
      if (heading) op = heading[1].trim();
      if (!code) errors.push('Area code is empty. Add the account code (e.g. NE06-CA1332).');
      else if (!/^[A-Z]{2}\d{2}-CA\d{3,5}$/.test(code)) warnings.push(`Area code "${code}" does not look like PREFIX-CA#### (e.g. NE06-CA1332). It is saved exactly as written.`);
      if (code && seen.has(code)) errors.push(`Area code ${code} is also on row ${seen.get(code)}. Each area code must be unique.`);
      if (code) seen.set(code, r._row);
      if (!name) errors.push('Name is empty.');
      if (!op) errors.push('Operational area is empty.');
      const poly = parsePolygon(r.v.polygon ?? '');
      if (poly.error) errors.push(`Polygon: ${poly.error}`);
      else if (!poly.ring) errors.push('No boundary polygon. Collection areas need a boundary; add one or leave this row out for now.');
      if (poly.warning) warnings.push(poly.warning);
      const { lat, lng } = coords(r, errors, warnings);
      if (poly.ring) {
        const [clng, clat] = ringCentre(poly.ring);
        if (clat < 4.5 || clat > 11.5 || clng < -3.5 || clng > 1.5) warnings.push('The boundary is outside Ghana. Check the coordinate order ([longitude, latitude] in GeoJSON).');
        if (lat !== undefined && lng !== undefined) {
          const d = km(lat, lng, clat, clng);
          if (d > 30) warnings.push(km(lng, lat, clat, clng) < 30 ? 'Latitude and longitude look swapped compared with the polygon.' : `The latitude/longitude point is ${Math.round(d)} km from the polygon. Check the row.`);
        }
      }
      const id = code ? `ca-${slug(code)}` : '';
      const exists = ctx.db.collectionAreas.find((a) => a.code === code);
      const item: CollectionArea & { _row: number } = {
        id: exists?.id ?? id,
        code,
        name,
        operationalArea: op,
        polygon: poly.ring ?? [],
        demo: ctx.mode === 'demo',
        geometrySource: (r.v.geometry_source ?? '').trim() || `Imported from ${ctx.fileName}`,
        _row: r._row,
      };
      return { id: `${r._row}`, rows: [r._row], label: `${code || '—'} · ${name || '—'} (${op || '—'})`, errors, warnings, update: !!exists, master: errors.length ? undefined : (item as unknown as Record<string, unknown>) };
    });
  },
};

const collectorsSpec: Spec = {
  kind: 'collectors',
  group: 'master',
  title: 'Collectors',
  description: 'One row per registered collector. The collector code must start with its collection area code (e.g. NE06-CA1332-014 belongs to NE06-CA1332). Import collection areas first.',
  columns: [
    { key: 'collector_code', label: 'collector_code', aliases: ['collector code', 'code', 'serial', 'collector id', 'collector no', 'farmer code', 'id'], required: true, help: 'e.g. NE06-CA1332-014. Unique; never changed by the system.' },
    { key: 'name', label: 'name', aliases: ['collector name', 'full name', 'collector', 'farmer name'], required: true, help: 'Full name. Personal data: visible only to authorised roles.' },
    { key: 'area_code', label: 'area_code', aliases: ['area code', 'account', 'account code', 'collection area code', 'ca code'], help: 'Optional. If empty, the area is found from the start of the collector code.' },
  ],
  example: () => [['NE06-CA1332-014', 'Example Name', 'NE06-CA1332']],
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    const areas = [...ctx.db.collectionAreas].sort((a, b) => b.code.length - a.code.length);
    return rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const code = (r.v.collector_code ?? '').trim();
      const name = (r.v.name ?? '').trim();
      const given = (r.v.area_code ?? '').trim();
      if (!code) errors.push('Collector code is empty.');
      if (code && seen.has(code)) errors.push(`Collector ${code} is also on row ${seen.get(code)}.`);
      if (code) seen.set(code, r._row);
      if (!name) errors.push('Name is empty.');
      let area: CollectionArea | undefined;
      if (given) {
        area = ctx.db.collectionAreas.find((a) => a.code === given);
        if (!area) errors.push(`Area code ${given} is not in the collection areas. Import the areas first.`);
        else if (code && !code.startsWith(`${given}-`)) errors.push(`Collector code ${code} does not start with its area code ${given}-. Codes are never repaired; check the Master Data List.`);
      } else if (code) {
        area = areas.find((a) => code.startsWith(`${a.code}-`));
        if (!area) errors.push('No collection area code matches the start of this collector code. Add an area_code column or import the areas first.');
      }
      const exists = ctx.db.collectors.find((c) => c.code === code);
      const item: Collector & { areaCode: string; _row: number } = { id: code, code, name, collectionAreaId: area?.id ?? '', demo: ctx.mode === 'demo', areaCode: area?.code ?? '', _row: r._row };
      return { id: `${r._row}`, rows: [r._row], label: `${code || '—'} · ${area ? area.name : '—'}`, errors, warnings, update: !!exists, master: errors.length ? undefined : (item as unknown as Record<string, unknown>) };
    });
  },
};

const locationsSpec: Spec = {
  kind: 'locations',
  group: 'master',
  title: 'Facilities & waypoints',
  description: 'Post-harvest centres, butter centres, warehouses, ports, terminals, refiners, filterers and client sites. (Collection areas have their own upload.)',
  columns: [
    { key: 'name', label: 'name', aliases: ['location', 'facility', 'site name'], required: true, help: 'e.g. Tamba Butter Centre.' },
    { key: 'type', label: 'type', aliases: ['kind', 'location type', 'facility type', 'category'], required: true, help: 'PHC, butter centre, warehouse, port, terminal, destination warehouse, refiner, filterer or client.' },
    { key: 'latitude', label: 'latitude', aliases: ['lat'], required: true, help: 'Decimal degrees, e.g. 9.4034.' },
    { key: 'longitude', label: 'longitude', aliases: ['long', 'lng', 'lon'], required: true, help: 'Decimal degrees, e.g. -0.8424.' },
    { key: 'code', label: 'code', aliases: ['location code', 'id'], help: 'Optional internal code (lower-case letters, digits, dashes). Made from the name if empty.' },
    { key: 'public_label', label: 'public_label', aliases: ['customer label', 'public label'], help: 'Optional. What customers see instead of the name.' },
    { key: 'country', label: 'country', help: 'Optional. Default Ghana.' },
    { key: 'account_code', label: 'account_code', aliases: ['account', 'account code'], help: 'PHCs only: the batch prefix, e.g. NE06-CA9150.' },
    { key: 'public_place', label: 'public_place', aliases: ['public'], help: 'yes for public places (ports) that customers may see exactly.' },
  ],
  example: () => [['Example Butter Centre', 'butter centre', '9.9061', '-2.4950', 'bc-example', 'Shea butter processing centre, Upper West', 'Ghana', '', 'no']],
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const name = (r.v.name ?? '').trim();
      const t = norm(r.v.type ?? '');
      const kind = (Object.keys(KIND_ALIASES) as LocationKind[]).find((k) => KIND_ALIASES[k].some((a) => norm(a) === t));
      if (!name) errors.push('Name is empty.');
      if (!kind) errors.push(t ? `Type "${r.v.type}" is not recognised. Use PHC, butter centre, warehouse, port, terminal, destination warehouse, refiner, filterer or client.` : 'Type is empty.');
      const { lat, lng } = coords(r, errors, warnings);
      if (lat === undefined || lng === undefined) errors.push('Latitude and longitude are required.');
      const code = (r.v.code ?? '').trim() || slug(name);
      if (!/^[a-z0-9-]{2,64}$/.test(code)) errors.push(`Code "${code}" may use only lower-case letters, digits and dashes (2–64).`);
      if (seen.has(code)) errors.push(`Code ${code} is also on row ${seen.get(code)}.`);
      seen.set(code, r._row);
      const pp = parseYes(r.v.public_place ?? '');
      if (pp.error) errors.push(`public_place: ${pp.error}`);
      const exists = ctx.db.locations.find((l) => l.id === code);
      const item: Location & { _row: number } = {
        id: code,
        name,
        kind: kind ?? 'phc',
        lat: lat ?? 0,
        lng: lng ?? 0,
        publicLabel: (r.v.public_label ?? '').trim() || (kind ? KIND_LABEL[kind] : ''),
        country: (r.v.country ?? '').trim() || 'Ghana',
        accountCode: (r.v.account_code ?? '').trim() || undefined,
        publicPlace: pp.value ?? false,
        demo: ctx.mode === 'demo',
        _row: r._row,
      };
      return { id: `${r._row}`, rows: [r._row], label: `${name || '—'} (${kind ? KIND_LABEL[kind] : '?'})`, errors, warnings, update: !!exists, master: errors.length ? undefined : (item as unknown as Record<string, unknown>) };
    });
  },
};

const groupsSpec: Spec = {
  kind: 'groups',
  group: 'master',
  title: 'Processing groups',
  description: 'Women’s processing groups at each butter centre.',
  columns: [
    { key: 'centre', label: 'centre', aliases: ['butter centre', 'center', 'location'], required: true, help: 'Butter centre name or code.' },
    { key: 'name', label: 'name', aliases: ['group', 'group name'], required: true, help: 'Group name, unique within the centre.' },
    { key: 'members', label: 'members', aliases: ['number of members', 'size'], help: 'Optional. Number of members.' },
    { key: 'code', label: 'code', aliases: ['group code', 'id'], help: 'Optional internal code. Made from centre + name if empty.' },
  ],
  example: () => [['Tamba Butter Centre', 'Example Women’s Group', '25', '']],
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const errors: string[] = [];
      const centre = findPlace(ctx, r.v.centre ?? '', ['butter-centre']);
      if (centre.error) errors.push(`Centre ${centre.error}.`);
      const name = (r.v.name ?? '').trim();
      if (!name) errors.push('Group name is empty.');
      const m = parseNum(r.v.members ?? '');
      if (m.error) errors.push(`Members: ${m.error}`);
      const code = (r.v.code ?? '').trim() || slug(`${centre.place?.id ?? ''}-${name}`);
      if (seen.has(code)) errors.push(`Group ${code} is also on row ${seen.get(code)}.`);
      seen.set(code, r._row);
      const exists = ctx.db.groups.find((g) => g.id === code);
      const item: ProcessingGroup & { _row: number } = { id: code, centreId: centre.place?.id ?? '', name, members: Math.max(0, Math.round(m.value ?? 0)), demo: ctx.mode === 'demo', _row: r._row };
      return { id: `${r._row}`, rows: [r._row], label: `${name || '—'} · ${centre.place?.name ?? '—'}`, errors, warnings: [], update: !!exists, master: errors.length ? undefined : (item as unknown as Record<string, unknown>) };
    });
  },
};

// ── events ───────────────────────────────────────────────────────────────────
const purchasesSpec: Spec = {
  kind: 'purchases',
  group: 'event',
  title: 'Purchases',
  description: 'One row per purchase from a registered collector. One purchase per collector per date. The collection area comes from the collector.',
  columns: [
    { key: 'collector_code', label: 'collector_code', aliases: ['collector', 'collector code', 'collector id', 'serial', 'farmer code'], required: true, help: 'Exactly as on the master list, e.g. NE06-CA1332-014.' },
    C.date('purchase_date', ['purchase date', 'date of purchase']),
    C.time(),
    C.tz(),
    C.qty(),
    { key: 'product', label: 'product', aliases: ['product code'], help: 'OFN (fresh nuts, default) or ODK (dried kernel).' },
    { ...C.lot('The officer’s lot ID, usually collector code + MMDDYY. Saved exactly as written.'), required: false },
    { key: 'price_per_kg', label: 'price_per_kg', aliases: ['price', 'price per kg', 'unit price', 'price ghs', 'ghs per kg'], help: 'Optional.' },
    { key: 'currency', label: 'currency', help: 'Optional. Default GHS.' },
    { key: 'evidence', label: 'evidence', aliases: ['receipt', 'receipt no', 'evidence reference', 'receipt book page'], help: 'Optional. Receipt book page, photo reference…' },
    C.notes(),
  ],
  options: [{ key: 'fillLotIds', label: 'Fill empty Lot ID cells with the standard pattern (collector code + purchase date as MMDDYY)', help: 'Only empty cells are filled. A Lot ID you typed is never changed.' }],
  example: (ctx) => {
    const c = ctx.db.collectors[0];
    const code = c?.code ?? 'NE06-CA1332-014';
    return [[code, '2026-07-14', '08:30', '+00:00', '1000', 'OFN', `${code}-071426`, '1.85', 'GHS', 'Receipt book 12, p.4', '']];
  },
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    const drafts = rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const code = (r.v.collector_code ?? '').trim();
      const col = ctx.db.collectors.find((c) => c.code === code);
      if (!code) errors.push('Collector code is empty.');
      else if (!col) {
        const ci = ctx.db.collectors.find((c) => c.code.toLowerCase() === code.toLowerCase());
        errors.push(`Collector ${code} is not on the master list${ci ? ` (did you mean ${ci.code}? codes must match exactly)` : ''}.`);
      }
      const area = col ? ctx.analysis.places.get(col.collectionAreaId) : undefined;
      if (col && !mine(ctx, col.collectionAreaId)) errors.push(`You are not assigned to ${nameOf(ctx, col.collectionAreaId)}, where this collector is registered.`);
      const t = eventTime(r, ctx, area);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      const date = t.iso?.slice(0, 10) ?? '';
      if (code && date) {
        const k = `${code}|${date}`;
        if (seen.has(k)) errors.push(`Row ${seen.get(k)} is also a purchase from ${code} on ${date}. One purchase per collector per date.`);
        seen.set(k, r._row);
      }
      const product = ((r.v.product ?? '').trim().toUpperCase() || 'OFN') as ProductCode;
      if (product !== 'OFN' && product !== 'ODK') errors.push(`Product "${r.v.product}" must be OFN or ODK.`);
      const qty = qtyOf(r, 'quantity_kg', errors);
      const expected = code && date ? `${code}-${mmddyy(date)}` : '';
      let lotId = (r.v.lot_id ?? '').trim();
      if (!lotId && ctx.options.fillLotIds && expected) {
        lotId = expected;
        warnings.push(`Lot ID filled in as ${expected} (standard pattern).`);
      } else if (!lotId) errors.push(`Lot ID is empty${expected ? ` (usual pattern: ${expected}; tick “Fill empty Lot ID cells” to use it)` : ''}.`);
      else if (expected && lotId !== expected) warnings.push(`Lot ID differs from the usual pattern ${expected}. Saved exactly as written.`);
      const price = parseNum(r.v.price_per_kg ?? '');
      if (price.error) errors.push(`Price: ${price.error}`);
      return {
        rows: [r],
        label: `${code || '—'} · ${date || '—'} · ${fmtKg(qty)} ${product}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: CommissionEvent = {
            ...base('commission', col!.collectionAreaId, t.iso!, ctx, hash),
            collectorId: col!.id,
            purchaseDate: date,
            pricePerKg: price.value,
            currency: (r.v.currency ?? '').trim().toUpperCase() || 'GHS',
            outputs: [{ lotId, product, qty }],
            evidence: r.v.evidence?.trim() ? [r.v.evidence.trim()] : [],
            notes: r.v.notes?.trim() || undefined,
          };
          return { event: ev, summary: `Purchase recorded: ${lotId} (${fmtKg(qty)} ${product})` };
        },
      };
    });
    return finishEvents('purchases', ctx, drafts);
  },
};

const shipmentsSpec: Spec = {
  kind: 'shipments',
  group: 'event',
  title: 'Shipments',
  description: 'One row per lot. Rows with the same shipment_ref form one shipment (same from, to, date and time). Leave shipment_ref empty to make each row its own shipment.',
  columns: [
    { key: 'shipment_ref', label: 'shipment_ref', aliases: ['ref', 'reference', 'waybill', 'waybill no', 'shipment', 'consignment'], help: 'Groups rows into one shipment. Optional.' },
    { key: 'from', label: 'from', aliases: ['ship from', 'origin', 'from location'], required: true, help: 'Where the lots are now (name or code).' },
    { key: 'to', label: 'to', aliases: ['ship to', 'destination', 'to location'], required: true, help: 'Destination (name or code).' },
    C.date('date', ['ship date', 'dispatch date', 'departure date']),
    C.time(),
    C.tz(),
    C.lot(),
    C.qty(),
    { key: 'container_no', label: 'container_no', aliases: ['container', 'container number'], help: 'Export legs only. Optional.' },
    { key: 'vessel', label: 'vessel', help: 'Export legs only. Optional.' },
    { key: 'eta', label: 'eta', help: 'Export legs only. Optional date.' },
    { key: 'client', label: 'client', aliases: ['client name', 'customer'], help: 'Export legs only. Optional.' },
    { key: 'order_ref', label: 'order_ref', aliases: ['order', 'order reference', 'client order'], help: 'Export legs only. Optional.' },
  ],
  example: () => [['WB-0412', 'Nayiri PHC', 'Tamba Butter Centre', '2026-07-20', '07:15', '+00:00', 'NE06-CA9150-B003-071826', '2550', '', '', '', '', '']],
  async prepare(rows, ctx) {
    const drafts = groupBy(rows, 'shipment_ref').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const ref = same(g, 'shipment_ref', 'shipment references', errors);
      const fromS = same(g, 'from', '"from" locations', errors);
      const toS = same(g, 'to', '"to" locations', errors);
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      same(g, 'timezone', 'time zones', errors);
      const from = findPlace(ctx, fromS);
      const to = findPlace(ctx, toS);
      if (from.error) errors.push(`From: ${from.error}.`);
      if (to.error) errors.push(`To: ${to.error}.`);
      if (from.place && !mine(ctx, from.place.id)) errors.push(`You are not assigned to ${from.place.name}.`);
      if (from.place && to.place && from.place.id === to.place.id) errors.push('From and to are the same place.');
      const t = eventTime(g[0], ctx, from.place);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      const items = g.map((r) => lotLine(ctx, r, errors)).filter(Boolean) as LotQty[];
      dupLots(items, errors);
      const exp = { containerNo: same(g, 'container_no', 'container numbers', errors), vessel: same(g, 'vessel', 'vessels', errors), eta: same(g, 'eta', 'ETAs', errors), clientName: same(g, 'client', 'clients', errors), orderRef: same(g, 'order_ref', 'order references', errors) };
      const isExport = !!from.place && EXPORT_KINDS.has(from.place.kind);
      if (exp.eta) {
        const d = parseDate(exp.eta);
        if (d.error) errors.push(`ETA: ${d.error}`);
        else exp.eta = d.value ?? '';
      }
      if (!isExport && Object.values(exp).some(Boolean)) warnings.push('Export details (container, vessel, ETA, client, order) are ignored for this leg.');
      const total = items.reduce((s, i) => s + i.qty, 0);
      return {
        rows: g,
        label: `${ref || `Row ${g[0]._row}`} · ${from.place?.name ?? '?'} → ${to.place?.name ?? '?'} · ${items.length} lot(s), ${fmtKg(total)}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: ShipEvent = {
            ...base('ship', from.place!.id, t.iso!, ctx, hash),
            fromId: from.place!.id,
            toId: to.place!.id,
            items,
            shipmentRef: ref || undefined,
            exportDetails: isExport && Object.values(exp).some(Boolean) ? exp : undefined,
          };
          return { event: ev, summary: `Shipment recorded: ${items.length} lot(s), ${from.place!.name} → ${to.place!.name}` };
        },
      };
    });
    return finishEvents('shipments', ctx, drafts);
  },
};

const receiptsSpec: Spec = {
  kind: 'receipts',
  group: 'event',
  title: 'Receipts',
  description: 'Confirm arrivals of shipments addressed to your locations. Download the template: it lists every open shipment with its lots — fill in the received quantity, date and time.',
  columns: [
    { key: 'shipment', label: 'shipment', aliases: ['shipment_ref', 'shipment ref', 'ref', 'reference', 'waybill'], required: true, help: 'Shipment reference (as listed in the template).' },
    C.lot(),
    { key: 'shipped_kg', label: 'shipped_kg', aliases: ['shipped'], help: 'For information only (from the template).' },
    C.qty('received_kg', ['received', 'received quantity', 'received kg']),
    C.date('date', ['received date', 'arrival date', 'date received']),
    C.time(),
    C.tz(),
    { key: 'outcome', label: 'outcome', aliases: ['result', 'status'], help: 'accepted (default) or discrepancy.' },
    { key: 'discrepancy_note', label: 'discrepancy_note', aliases: ['note', 'notes', 'discrepancy', 'reason'], help: 'Required for a discrepancy.' },
  ],
  example: () => [],
  prefill: (ctx) =>
    ctx.analysis.openShipments
      .filter((s) => mine(ctx, s.toId))
      .flatMap((s) => s.items.map((i) => [s.shipmentRef || s.id, i.lotId, String(i.qty), '', '', '', '', 'accepted', ''])),
  async prepare(rows, ctx) {
    const open = ctx.analysis.openShipments.filter((s) => mine(ctx, s.toId));
    const drafts = groupBy(rows, 'shipment').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const ref = same(g, 'shipment', 'shipments', errors);
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      const matches = open.filter((s) => s.shipmentRef === ref || s.id === ref);
      if (!ref) errors.push('Shipment is empty.');
      else if (!matches.length) errors.push(`No open shipment "${ref}" to your locations (it may already be received).`);
      else if (matches.length > 1) errors.push(`${matches.length} open shipments use the reference "${ref}". Use the ID from the downloaded template instead.`);
      const ship = matches.length === 1 ? matches[0] : undefined;
      const dest = ship ? ctx.analysis.places.get(ship.toId) : undefined;
      const t = eventTime(g[0], ctx, dest);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      const outcomeRaw = norm(same(g, 'outcome', 'outcomes', errors));
      const note = same(g, 'discrepancy_note', 'notes', errors);
      let outcome: 'accepted' | 'discrepancy' = outcomeRaw.startsWith('disc') ? 'discrepancy' : 'accepted';
      if (outcomeRaw && !['accepted', 'accept', 'ok', 'discrepancy'].includes(outcomeRaw)) errors.push(`Outcome "${outcomeRaw}" must be accepted or discrepancy.`);
      const received = new Map<string, number>();
      for (const r of g) {
        const lot = (r.v.lot_id ?? '').trim();
        if (received.has(lot)) errors.push(`Row ${r._row}: lot ${lot} is listed twice.`);
        received.set(lot, qtyOf(r, 'received_kg', errors, true));
        if (ship && !ship.items.some((i) => i.lotId === lot)) errors.push(`Row ${r._row}: lot ${lot} is not on this shipment.`);
      }
      const differs = ship?.items.some((i) => received.has(i.lotId) && received.get(i.lotId) !== i.qty);
      if (ship) for (const i of ship.items) if (!received.has(i.lotId)) errors.push(`Lot ${i.lotId} on this shipment has no row. Every lot must be confirmed.`);
      if (differs && !outcomeRaw) errors.push('Received quantities differ from the shipment. Set outcome to discrepancy and add a note.');
      if (differs && outcomeRaw && outcome === 'accepted') warnings.push('Received quantities differ from the shipment but the outcome is "accepted".');
      if (outcome === 'discrepancy' && !note) errors.push('A discrepancy needs a note explaining it.');
      if (!differs && !outcomeRaw) outcome = 'accepted';
      return {
        rows: g,
        label: ship ? `${ref} · ${nameOf(ctx, ship.fromId)} → ${nameOf(ctx, ship.toId)} · ${outcome}` : `${ref || '—'}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: ReceiveEvent = {
            ...base('receive', ship!.toId, t.iso!, ctx, hash),
            shipEventId: ship!.id,
            fromId: ship!.fromId,
            items: ship!.items.map((i) => ({ ...i, qty: received.get(i.lotId) ?? i.qty })),
            outcome,
            discrepancyNote: outcome === 'discrepancy' ? note : undefined,
          };
          return { event: ev, summary: `Receipt recorded at ${nameOf(ctx, ship!.toId)}${outcome === 'discrepancy' ? ' (discrepancy flagged)' : ''}` };
        },
      };
    });
    return finishEvents('receipts', ctx, drafts);
  },
};

const issuesSpec: Spec = {
  kind: 'issues',
  group: 'event',
  title: 'Issue ODK to groups',
  description: 'One row per ODK lot issued. Rows with the same issue_ref form one issue (same centre, group, date and time).',
  columns: [
    { key: 'issue_ref', label: 'issue_ref', aliases: ['ref', 'reference', 'issue'], help: 'Groups rows into one issue. Optional.' },
    { key: 'centre', label: 'centre', aliases: ['butter centre', 'center', 'location'], required: true, help: 'Butter centre name or code.' },
    { key: 'group', label: 'group', aliases: ['processing group', 'group name'], required: true, help: 'Group name or code at that centre.' },
    C.date(),
    C.time(),
    C.tz(),
    C.lot('ODK lot ID, exactly as recorded.'),
    C.qty(),
  ],
  example: () => [['ISS-1', 'Tamba Butter Centre', 'Example Women’s Group', '2026-07-22', '09:00', '+00:00', 'NE06-CA9150-B003-071826', '600']],
  async prepare(rows, ctx) {
    const drafts = groupBy(rows, 'issue_ref').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const centre = findPlace(ctx, same(g, 'centre', 'centres', errors), ['butter-centre']);
      if (centre.error) errors.push(`Centre ${centre.error}.`);
      if (centre.place && !mine(ctx, centre.place.id)) errors.push(`You are not assigned to ${centre.place.name}.`);
      const gName = same(g, 'group', 'groups', errors);
      const group = ctx.db.groups.find((x) => x.centreId === centre.place?.id && (x.id === gName || norm(x.name) === norm(gName)));
      if (centre.place && !group) errors.push(`"${gName}" is not a processing group at ${centre.place.name}.`);
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      const t = eventTime(g[0], ctx, centre.place);
      errors.push(...t.errors);
      const items = g.map((r) => lotLine(ctx, r, errors)).filter(Boolean) as LotQty[];
      dupLots(items, errors);
      return {
        rows: g,
        label: `${group?.name ?? gName ?? '—'} · ${items.length} lot(s), ${fmtKg(items.reduce((s, i) => s + i.qty, 0))}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: IssueEvent = { ...base('issue', centre.place!.id, t.iso!, ctx, hash), groupId: group!.id, items };
          return { event: ev, summary: `Issued ${fmtKg(items.reduce((s, i) => s + i.qty, 0))} ODK to ${group!.name}` };
        },
      };
    });
    return finishEvents('issues', ctx, drafts);
  },
};

const PROCESS: Record<Exclude<TransformKind, 'aggregation'>, string[]> = {
  kernel: ['kernel', 'ofn→odk', 'ofn->odk', 'ofn to odk', 'ofn-odk', 'drying', 'ofnodk'],
  butter: ['butter', 'odk→osb', 'odk->osb', 'odk to osb', 'odk-osb', 'lpo', 'odkosb'],
  refine: ['refine', 'refining', 'osb→orsb', 'osb->orsb', 'osb to orsb'],
  filter: ['filter', 'filtering', 'osb→ofsb', 'osb->ofsb', 'osb to ofsb'],
};
const canProcess = (role: RoleId, k: TransformKind) => {
  const c = ROLES[role].can;
  return k === 'kernel' ? c.processKernel : k === 'butter' ? c.processButter : k === 'aggregation' ? c.aggregateSfcl : c.refineFilter;
};

const processingSpec: Spec = {
  kind: 'processing',
  group: 'event',
  title: 'Processing runs',
  description: 'Transformations: OFN → ODK (kernel), ODK → OSB (butter, with LPO), refining and filtering. Each run has input rows (consumed lots) and output rows (new batches), sharing one run_ref.',
  columns: [
    { key: 'run_ref', label: 'run_ref', aliases: ['run', 'run reference', 'reference', 'ref'], required: true, help: 'Any label that groups the rows of one run, e.g. RUN-1.' },
    { key: 'process', label: 'process', aliases: ['type', 'transformation', 'stage'], required: true, help: 'kernel (OFN→ODK), butter (ODK→OSB), refine or filter.' },
    { key: 'location', label: 'location', aliases: ['centre', 'center', 'site'], required: true, help: 'Where it happened (name or code).' },
    { key: 'group', label: 'group', aliases: ['processing group'], help: 'Butter runs only: the processing group.' },
    C.date(),
    C.time(),
    C.tz(),
    { key: 'line', label: 'line', aliases: ['input/output', 'direction', 'role', 'in/out'], required: true, help: 'input or output.' },
    C.lot('Input: an existing lot. Output: the NEW batch ID you assign (LPO number for butter).'),
    { key: 'product', label: 'product', help: 'Outputs only. Default: the usual output product for the process.' },
    C.qty(),
  ],
  example: () => [
    ['RUN-1', 'kernel', 'Nayiri PHC', '', '2026-07-18', '16:00', '+00:00', 'input', 'NE06-CA1332-014-071426', '', '2550'],
    ['RUN-1', 'kernel', 'Nayiri PHC', '', '2026-07-18', '16:00', '+00:00', 'output', 'NE06-CA9150-B003-071826', 'ODK', '850'],
  ],
  async prepare(rows, ctx) {
    const drafts = groupBy(rows, 'run_ref').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const ref = same(g, 'run_ref', 'run references', errors);
      if (!ref) errors.push('run_ref is empty. Give the input and output rows of a run the same run_ref.');
      const pRaw = norm(same(g, 'process', 'processes', errors));
      const kind = (Object.keys(PROCESS) as (keyof typeof PROCESS)[]).find((k) => PROCESS[k].some((a) => norm(a) === pRaw));
      if (!kind) errors.push(`Process "${pRaw}" must be kernel, butter, refine or filter.`);
      else if (!canProcess(ctx.role, kind)) errors.push(`Your role cannot record ${transformRule(kind).label} runs.`);
      const rule = kind ? transformRule(kind) : undefined;
      const loc = findPlace(ctx, same(g, 'location', 'locations', errors), rule?.at);
      if (loc.error) errors.push(`Location ${loc.error}${rule ? ` (${rule.label} happens at a ${rule.at.join(' / ')})` : ''}.`);
      if (loc.place && !mine(ctx, loc.place.id)) errors.push(`You are not assigned to ${loc.place.name}.`);
      const gName = same(g, 'group', 'groups', errors);
      const group = kind === 'butter' ? ctx.db.groups.find((x) => x.centreId === loc.place?.id && (x.id === gName || norm(x.name) === norm(gName))) : undefined;
      if (kind === 'butter' && !group) errors.push(gName ? `"${gName}" is not a processing group at ${loc.place?.name ?? 'this centre'}.` : 'Butter runs need the processing group.');
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      const t = eventTime(g[0], ctx, loc.place);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      const inputs: LotQty[] = [];
      const outputs: LotQty[] = [];
      for (const r of g) {
        const line = norm(r.v.line ?? '');
        if (line.startsWith('in')) {
          const l = lotLine(ctx, r, errors);
          if (l) inputs.push(l);
        } else if (line.startsWith('out')) {
          const lotId = (r.v.lot_id ?? '').trim();
          if (!lotId) errors.push(`Row ${r._row}: output batch ID is empty.`);
          if (lotId && ctx.analysis.lots.has(lotId)) errors.push(`Row ${r._row}: batch ID ${lotId} already exists. Output batches need a new ID.`);
          const product = ((r.v.product ?? '').trim().toUpperCase() || rule?.out[0] || 'ODK') as ProductCode;
          if (!(product in PRODUCTS)) errors.push(`Row ${r._row}: product "${r.v.product}" is not a product code.`);
          else if (rule && !rule.out.includes(product)) errors.push(`Row ${r._row}: ${rule.label} produces ${rule.out.join(' or ')}, not ${product}.`);
          outputs.push({ lotId, product, qty: qtyOf(r, 'quantity_kg', errors) });
        } else errors.push(`Row ${r._row}: line must be input or output.`);
      }
      if (!inputs.length) errors.push('The run has no input rows.');
      if (!outputs.length) errors.push('The run has no output rows.');
      dupLots(inputs, errors);
      dupLots(outputs, errors);
      return {
        rows: g,
        label: `${ref || '—'} · ${rule?.label ?? '?'} · ${inputs.length} in → ${outputs.map((o) => o.lotId).join(', ') || '?'}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: TransformEvent = { ...base('transform', loc.place!.id, t.iso!, ctx, hash), kind: kind!, groupId: kind === 'butter' ? group!.id : undefined, inputs, outputs };
          return { event: ev, summary: `${rule!.label} recorded: ${outputs.map((o) => o.lotId).join(', ')}` };
        },
      };
    });
    return finishEvents('processing', ctx, drafts);
  },
};

const aggregationSpec: Spec = {
  kind: 'aggregation',
  group: 'event',
  title: 'SFCL aggregations',
  description: 'New SFCL batches made from LPO draws at the warehouse. One row per LPO draw; rows with the same sfcl_number form one SFCL. To add draws to an SFCL that already exists, use the SFCL aggregation form.',
  columns: [
    { key: 'sfcl_number', label: 'sfcl_number', aliases: ['sfcl', 'sfcl no', 'sfcl id', 'sfcl batch', 'output'], required: true, help: 'SFCL number assigned at the warehouse, e.g. SFCL 26017.' },
    { key: 'warehouse', label: 'warehouse', aliases: ['location'], help: 'Optional if you are assigned to one warehouse.' },
    C.date(),
    C.time(),
    C.tz(),
    C.lot('LPO number drawn from.'),
    C.qty(),
    { key: 'finalize', label: 'finalize', aliases: ['final', 'finalise', 'finalized', 'finalised'], help: 'yes to finalize the SFCL now, no (default) to keep it in progress.' },
  ],
  example: () => [['SFCL 26017', '', '2026-08-02', '10:00', '+00:00', 'LPO-90418', '3000', 'no']],
  async prepare(rows, ctx) {
    const myWh = [...(ctx.viewer?.locations ?? [])].filter((id) => ctx.analysis.places.get(id)?.kind === 'warehouse');
    const drafts = groupBy(rows, 'sfcl_number').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!canProcess(ctx.role, 'aggregation')) errors.push('Your role cannot record SFCL aggregations.');
      const sfcl = same(g, 'sfcl_number', 'SFCL numbers', errors);
      if (!sfcl) errors.push('SFCL number is empty.');
      if (sfcl && ctx.analysis.lots.has(sfcl)) errors.push(`${sfcl} already exists. Add draws to it with the SFCL aggregation form.`);
      const whS = same(g, 'warehouse', 'warehouses', errors);
      const wh = whS ? findPlace(ctx, whS, ['warehouse']) : myWh.length === 1 ? { place: ctx.analysis.places.get(myWh[0]) } : { error: 'is empty (you are assigned to several warehouses)' };
      if (wh.error) errors.push(`Warehouse ${wh.error}.`);
      if (wh.place && !mine(ctx, wh.place.id)) errors.push(`You are not assigned to ${wh.place.name}.`);
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      const t = eventTime(g[0], ctx, wh.place);
      errors.push(...t.errors);
      const fin = parseYes(same(g, 'finalize', 'finalize values', errors));
      if (fin.error) errors.push(`Finalize: ${fin.error}`);
      const inputs = (g.map((r) => lotLine(ctx, r, errors)).filter(Boolean) as LotQty[]).map((l) => ({ ...l, product: 'OSB' as ProductCode }));
      dupLots(inputs, errors);
      const total = inputs.reduce((s, i) => s + i.qty, 0);
      return {
        rows: g,
        label: `${sfcl || '—'} · ${inputs.length} LPO draw(s), ${fmtKg(total)}${fin.value ? ' · finalize' : ''}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: TransformEvent = { ...base('transform', wh.place!.id, t.iso!, ctx, hash), kind: 'aggregation', inputs, outputs: [{ lotId: sfcl, product: 'OSB', qty: total }], sfclStage: fin.value ? 'finalized' : 'in-progress' };
          return { event: ev, summary: fin.value ? `${sfcl} finalized at ${fmtKg(total)}` : `${sfcl} saved in progress (${fmtKg(total)})` };
        },
      };
    });
    return finishEvents('aggregation', ctx, drafts);
  },
};

const readySpec: Spec = {
  kind: 'ready',
  group: 'event',
  title: 'Ready for pickup',
  description: 'Mark lots as arrived and ready for pickup at a destination. Each row creates a customer trace link and a Commercial handoff.',
  columns: [
    { key: 'location', label: 'location', aliases: ['destination', 'site'], required: true, help: 'Refiner, filterer or destination warehouse (name or code).' },
    C.lot(),
    C.qty(),
    { key: 'client', label: 'client', aliases: ['client name', 'customer'], required: true, help: 'Client name.' },
    { key: 'order_ref', label: 'order_ref', aliases: ['order', 'order reference', 'client order', 'po'], required: true, help: 'Client order reference.' },
    C.date(),
    C.time(),
    C.tz(),
  ],
  example: () => [['Zaandam Refinery', 'ORSB 26901-R1', '20000', 'Example Client B.V.', 'PO-4471', '2026-09-30', '14:00', '+02:00']],
  async prepare(rows, ctx) {
    const seen = new Map<string, number>();
    const drafts = rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const loc = findPlace(ctx, r.v.location ?? '', ['refiner', 'filterer', 'destination-warehouse']);
      if (loc.error) errors.push(`Location ${loc.error}.`);
      if (loc.place && !mine(ctx, loc.place.id)) errors.push(`You are not assigned to ${loc.place.name}.`);
      const line = lotLine(ctx, r, errors);
      const client = (r.v.client ?? '').trim();
      const order = (r.v.order_ref ?? '').trim();
      if (!client) errors.push('Client is empty.');
      if (!order) errors.push('Order reference is empty.');
      if (line && loc.place && ctx.db.handoffs.some((h) => h.lotId === line.lotId && h.locationId === loc.place!.id)) errors.push(`${line.lotId} is already marked ready at ${loc.place.name}.`);
      const k = `${line?.lotId}|${loc.place?.id}`;
      if (seen.has(k)) errors.push(`Row ${seen.get(k)} marks the same lot ready at the same place.`);
      seen.set(k, r._row);
      const t = eventTime(r, ctx, loc.place);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      return {
        rows: [r],
        label: `${line?.lotId ?? '—'} · ${loc.place?.name ?? '—'} · ${client || '—'}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: ReadyEvent = { ...base('ready', loc.place!.id, t.iso!, ctx, hash), items: [line!], handoffId: `ho-b${hash.slice(0, 12)}` };
          return {
            event: ev,
            summary: `${line!.lotId} marked ready for pickup at ${loc.place!.name}`,
            handoff: { lotId: line!.lotId, qty: line!.qty, product: line!.product, locationId: loc.place!.id, clientName: client, orderRef: order },
          };
        },
      };
    });
    return finishEvents('ready', ctx, drafts);
  },
};

const deliveriesSpec: Spec = {
  kind: 'deliveries',
  group: 'event',
  title: 'Deliveries to clients',
  description: 'Direct-to-client hand-overs. Rows with the same delivery_ref form one delivery.',
  columns: [
    { key: 'delivery_ref', label: 'delivery_ref', aliases: ['ref', 'reference', 'delivery'], help: 'Groups rows into one delivery. Optional.' },
    { key: 'from', label: 'from', aliases: ['origin', 'deliver from'], required: true, help: 'Terminal, destination warehouse, refiner or filterer.' },
    { key: 'client', label: 'client', aliases: ['to', 'client site', 'customer'], required: true, help: 'Client site (name or code).' },
    C.date(),
    C.time(),
    C.tz(),
    C.lot(),
    C.qty(),
  ],
  example: () => [['DEL-1', 'Zaandam Refinery', 'Example Client B.V.', '2026-10-02', '11:00', '+02:00', 'ORSB 26901-R1', '20000']],
  async prepare(rows, ctx) {
    const drafts = groupBy(rows, 'delivery_ref').map((g) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const from = findPlace(ctx, same(g, 'from', '"from" locations', errors), ['terminal', 'destination-warehouse', 'refiner', 'filterer']);
      const to = findPlace(ctx, same(g, 'client', 'clients', errors), ['client']);
      if (from.error) errors.push(`From ${from.error}.`);
      if (to.error) errors.push(`Client ${to.error}.`);
      if (from.place && !mine(ctx, from.place.id)) errors.push(`You are not assigned to ${from.place.name}.`);
      same(g, 'date', 'dates', errors);
      same(g, 'time', 'times', errors);
      const t = eventTime(g[0], ctx, from.place);
      errors.push(...t.errors);
      warnings.push(...t.warnings);
      const items = g.map((r) => lotLine(ctx, r, errors)).filter(Boolean) as LotQty[];
      dupLots(items, errors);
      return {
        rows: g,
        label: `${from.place?.name ?? '?'} → ${to.place?.name ?? '?'} · ${items.length} lot(s), ${fmtKg(items.reduce((s, i) => s + i.qty, 0))}`,
        errors,
        warnings,
        build: (hash: string): Omit<BulkEvent, 'key'> => {
          const ev: DeliverEvent = { ...base('deliver', from.place!.id, t.iso!, ctx, hash), toId: to.place!.id, items };
          return { event: ev, summary: `Delivery recorded to ${to.place!.name}` };
        },
      };
    });
    return finishEvents('deliveries', ctx, drafts);
  },
};

export const SPECS: Record<ImportKind, Spec> = {
  collection_areas: areasSpec,
  collectors: collectorsSpec,
  locations: locationsSpec,
  groups: groupsSpec,
  purchases: purchasesSpec,
  shipments: shipmentsSpec,
  receipts: receiptsSpec,
  issues: issuesSpec,
  processing: processingSpec,
  aggregation: aggregationSpec,
  ready: readySpec,
  deliveries: deliveriesSpec,
};

/** The event uploads a role may use (the server enforces the same rules). */
export function eventKindsFor(role: RoleId): ImportKind[] {
  const c = ROLES[role].can;
  const k: ImportKind[] = [];
  if (c.recordPurchase) k.push('purchases');
  if (c.ship) k.push('shipments');
  if (c.receive) k.push('receipts');
  if (c.issueToGroup) k.push('issues');
  if (c.processKernel || c.processButter || c.refineFilter) k.push('processing');
  if (c.aggregateSfcl) k.push('aggregation');
  if (c.markReady) k.push('ready');
  if (c.deliver) k.push('deliveries');
  return k;
}
export const MASTER_KINDS: ImportKind[] = ['collection_areas', 'collectors', 'locations', 'groups'];

// ── sheet → rows ─────────────────────────────────────────────────────────────
export interface Mapped {
  rows: Row[];
  headers: string[];
  matched: { col: Col; header: string }[];
  ignored: string[];
  missing: Col[];
}

/** Match the header row to the spec's columns (by name or a known alias) and read the data rows. */
export function mapSheet(sheet: string[][], spec: Spec): Mapped {
  const isComment = (r: string[]) => (r.find((c) => (c ?? '').trim()) ?? '').trim().startsWith('#');
  const hi = sheet.findIndex((r) => r.some((c) => (c ?? '').trim()) && !isComment(r));
  const headers = hi >= 0 ? sheet[hi].map((h) => (h ?? '').trim()) : [];
  const index = new Map<string, number>();
  const matched: Mapped['matched'] = [];
  const ignored: string[] = [];
  headers.forEach((h, i) => {
    if (!h) return;
    const n = norm(h);
    const col = spec.columns.find((c) => !index.has(c.key) && [c.key, c.label, ...(c.aliases ?? [])].some((a) => norm(a) === n));
    if (col) {
      index.set(col.key, i);
      matched.push({ col, header: h });
    } else ignored.push(h);
  });
  const missing = spec.columns.filter((c) => c.required && !index.has(c.key) && !(c.key === 'time' && index.has('date')));
  const rows: Row[] = [];
  if (hi >= 0)
    for (let i = hi + 1; i < sheet.length; i++) {
      const raw = sheet[i] ?? [];
      if (!raw.some((c) => (c ?? '').trim()) || isComment(raw)) continue;
      const v: Record<string, string> = {};
      for (const [key, ci] of index) v[key] = clean(raw[ci]);
      rows.push({ _row: i + 1, v, raw });
    }
  return { rows, headers, matched, ignored, missing };
}

/** Template: header row, example rows as # comments, then any prefilled rows. */
export function templateFor(spec: Spec, ctx: Ctx): string[][] {
  const header = spec.columns.map((c) => c.label);
  const ex = spec.example(ctx).map((r, i) => (i === 0 ? [`# EXAMPLE (ignored) ${r[0] ?? ''}`, ...r.slice(1)] : [`# ${r[0] ?? ''}`, ...r.slice(1)]));
  return [header, ...ex, ...(spec.prefill?.(ctx) ?? [])];
}
