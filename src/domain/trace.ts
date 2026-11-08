// Genealogy and trace assembly. The map, timeline and customer page are all
// built from these structures, which come only from recorded events. Nothing
// here invents a movement: if an event is missing, the trace simply has a gap.

import type { DemoDB, LotQty, ProductCode, TraceEvent } from '../data/types';
import type { Analysis, LotRecord, Place } from './engine';
import { SFCL_TARGET, TRANSFORM_LABEL, ms } from './engine';
import { eventDate, fmtKg } from './format';

export type MarkerKind =
  | 'purchase'
  | 'ship'
  | 'receive'
  | 'issue'
  | 'kernel'
  | 'butter'
  | 'aggregate'
  | 'export'
  | 'arrival'
  | 'refine'
  | 'filter'
  | 'ready'
  | 'delivery';

export type StageId = 'origin' | 'post-harvest' | 'butter' | 'warehouse' | 'export' | 'destination' | 'refining';

export const STAGES: { id: StageId; label: string; publicLabel: string }[] = [
  { id: 'origin', label: 'Collection', publicLabel: 'Collected from certified forest reserves' },
  { id: 'post-harvest', label: 'Post-Harvest', publicLabel: 'Dried into kernel' },
  { id: 'butter', label: 'Butter Processing', publicLabel: 'Pressed into crude shea butter' },
  { id: 'warehouse', label: 'Warehouse / SFCL', publicLabel: 'Consolidated into an export batch' },
  { id: 'export', label: 'Export', publicLabel: 'Exported via Tema Port' },
  { id: 'destination', label: 'Destination', publicLabel: 'Arrived at destination' },
  { id: 'refining', label: 'Refining / Filtering', publicLabel: 'Refined or filtered' },
];

const EXPORT_FROM = new Set(['warehouse', 'port', 'terminal', 'destination-warehouse', 'refiner', 'filterer']);
const ARRIVAL_AT = new Set(['port', 'terminal', 'destination-warehouse', 'refiner', 'filterer', 'client']);

export function markerKind(e: TraceEvent, places: Map<string, Place>): MarkerKind {
  switch (e.type) {
    case 'commission':
      return 'purchase';
    case 'ship':
      return EXPORT_FROM.has(places.get(e.fromId)?.kind ?? '') ? 'export' : 'ship';
    case 'receive':
      return ARRIVAL_AT.has(places.get(e.locationId)?.kind ?? '') ? 'arrival' : 'receive';
    case 'issue':
      return 'issue';
    case 'transform':
      return e.kind === 'kernel' ? 'kernel' : e.kind === 'butter' ? 'butter' : e.kind === 'aggregation' ? 'aggregate' : e.kind === 'refine' ? 'refine' : 'filter';
    case 'ready':
      return 'ready';
    case 'deliver':
      return 'delivery';
  }
}

export function stageOf(placeKind: string | undefined): StageId {
  switch (placeKind) {
    case 'collection-area':
      return 'origin';
    case 'phc':
      return 'post-harvest';
    case 'butter-centre':
      return 'butter';
    case 'warehouse':
      return 'warehouse';
    case 'port':
      return 'export';
    default:
      return 'destination';
  }
}

/** Lines of an event with their role (consumed input, created output, or moved item). */
export function eventLines(e: TraceEvent): (LotQty & { role: 'in' | 'out' | 'item' })[] {
  switch (e.type) {
    case 'commission':
      return e.outputs.map((l) => ({ ...l, role: 'out' as const }));
    case 'transform':
      return [...e.inputs.map((l) => ({ ...l, role: 'in' as const })), ...e.outputs.map((l) => ({ ...l, role: 'out' as const }))];
    default:
      return e.items.map((l) => ({ ...l, role: 'item' as const }));
  }
}

export function ancestors(a: Analysis, lotId: string) {
  const seen = new Set<string>();
  const stack = [lotId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const p of a.lots.get(id)?.parents ?? []) if (!seen.has(p.lotId)) seen.add(p.lotId), stack.push(p.lotId);
  }
  return seen;
}

export function descendants(a: Analysis, lotId: string) {
  const seen = new Set<string>();
  const stack = [lotId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of a.lots.get(id)?.children ?? []) if (!seen.has(c.lotId)) seen.add(c.lotId), stack.push(c.lotId);
  }
  return seen;
}

export type Direction = 'backward' | 'forward' | 'full';

export interface Step {
  id: string;
  kind: MarkerKind;
  stage: StageId;
  locationId: string;
  fromId?: string;
  toId?: string;
  groupId?: string;
  events: TraceEvent[];
  start: string;
  end: string;
  lines: (LotQty & { role: 'in' | 'out' | 'item' })[];
  waypointId: string;
}

export interface Waypoint {
  id: string;
  kind: MarkerKind;
  locationId: string;
  stepIds: string[];
  start: string;
  end: string;
}

export interface Edge {
  id: string;
  fromId: string;
  toId: string;
  product: ProductCode;
  qty: number;
  count: number;
  stepIds: string[];
}

export interface Trace {
  target: LotRecord;
  direction: Direction;
  lotSet: Set<string>;
  events: TraceEvent[];
  steps: Step[];
  waypoints: Waypoint[];
  edges: Edge[];
  areaIds: string[];
  status: LotStatus;
}

export interface LotStatus {
  label: string;
  detail: string;
  locationId?: string;
  at?: string;
  tone: 'done' | 'progress' | 'transit' | 'warn';
}

export function lotStatus(a: Analysis, lotId: string): LotStatus {
  const lot = a.lots.get(lotId);
  if (!lot) return { label: 'Unknown lot', detail: '', tone: 'warn' };
  const place = (id?: string) => (id ? a.places.get(id)?.name ?? id : '');
  if (lot.kind === 'sfcl' && lot.sfclStage !== 'finalized') {
    return { label: 'Aggregation in progress', detail: `${fmtKg(lot.createdQty)} of ${fmtKg(SFCL_TARGET)} at ${place(lot.createdAtLocation)}`, locationId: lot.createdAtLocation, at: lot.createdAt, tone: 'progress' };
  }
  const evs = a.sorted.filter((e) => eventLines(e).some((l) => l.lotId === lotId));
  const ready = evs.filter((e) => e.type === 'ready').at(-1);
  if (ready) return { label: 'Arrived and ready for pickup', detail: place(ready.locationId), locationId: ready.locationId, at: ready.eventTime, tone: 'done' };
  const open = a.openShipments.find((s) => s.items.some((i) => i.lotId === lotId));
  if (open && open.type === 'ship') return { label: 'In transit', detail: `${place(open.fromId)} → ${place(open.toId)}`, locationId: open.toId, at: open.eventTime, tone: 'transit' };
  const held = [...(a.stock.get(lotId)?.entries() ?? [])].filter(([, q]) => q > 0);
  const issued = [...(a.allocated.get(lotId)?.entries() ?? [])].filter(([, q]) => q > 0);
  const last = evs.at(-1);
  if (!held.length && !issued.length) {
    return { label: 'Fully used', detail: `All of ${lotId} has been transformed into later batches.`, locationId: last?.locationId, at: last?.eventTime, tone: 'done' };
  }
  const where = held.map(([l, q]) => `${place(l)} (${fmtKg(q)})`).join(', ');
  return { label: lot.kind === 'purchase' && held.some(([l]) => l === lot.createdAtLocation) ? 'Purchased, awaiting shipment' : 'Held in stock', detail: where || 'Issued to processing group', locationId: held[0]?.[0] ?? last?.locationId, at: last?.eventTime, tone: 'progress' };
}

/**
 * Build a trace for a lot.
 *  backward: the lot + all ancestors; ancestor movements are pruned to the path
 *            that actually leads to where each lot was consumed.
 *  forward:  the lot + all descendants and every movement of them.
 *  full:     both directions, nothing pruned.
 * endpointLocationId (customer view) also prunes the target's own movements to
 * the path that reaches that endpoint.
 */
export function buildTrace(a: Analysis, db: DemoDB, lotId: string, direction: Direction = 'backward', endpointLocationId?: string): Trace | null {
  const target = a.lots.get(lotId);
  if (!target) return null;
  const anc = direction === 'forward' ? new Set<string>() : ancestors(a, lotId);
  const desc = direction === 'backward' ? new Set<string>() : descendants(a, lotId);
  const lotSet = new Set<string>([lotId, ...anc, ...desc]);

  // transforms/commissions that create a lot in the set
  const creating = a.sorted.filter((e) => (e.type === 'transform' || e.type === 'commission') && e.outputs.some((o) => lotSet.has(o.lotId)));
  const includedTransforms = creating.filter((e) => e.type === 'transform');

  // Which lots get their movements pruned, and to which sink locations.
  const sinks = new Map<string, Set<string>>();
  if (direction === 'backward') {
    for (const id of anc) {
      const s = new Set<string>();
      for (const t of includedTransforms) if (t.type === 'transform' && t.inputs.some((i) => i.lotId === id)) s.add(t.locationId);
      sinks.set(id, s);
    }
  }
  if (endpointLocationId) sinks.set(lotId, new Set([endpointLocationId]));

  const keptMoves = new Set<string>();
  for (const [id, sinkSet] of sinks) {
    const created = a.lots.get(id)?.createdAtLocation;
    const queue = [...sinkSet];
    const visited = new Set<string>();
    while (queue.length) {
      const loc = queue.shift()!;
      if (visited.has(loc)) continue;
      visited.add(loc);
      if (loc === created) continue;
      for (const e of a.sorted) {
        if (e.type === 'receive' && e.locationId === loc && e.items.some((i) => i.lotId === id)) {
          keptMoves.add(`${e.id}|${id}`);
          keptMoves.add(`${e.shipEventId}|${id}`);
          const s = a.byId.get(e.shipEventId);
          if (s && s.type === 'ship') queue.push(s.fromId);
        }
      }
    }
  }
  // issue events: keep only issues to groups whose included transform used that lot
  const groupUse = new Set<string>();
  for (const t of includedTransforms) if (t.type === 'transform' && t.groupId) for (const i of t.inputs) groupUse.add(`${t.groupId}|${i.lotId}`);

  const events: TraceEvent[] = [];
  for (const e of a.sorted) {
    if (e.type === 'commission' || e.type === 'transform') {
      if (e.outputs.some((o) => lotSet.has(o.lotId))) events.push(e);
      continue;
    }
    const relevant = e.items.filter((i) => lotSet.has(i.lotId));
    if (!relevant.length) continue;
    if (e.type === 'issue') {
      if (relevant.some((i) => groupUse.has(`${e.groupId}|${i.lotId}`))) events.push(e);
      continue;
    }
    if (e.type === 'ship' || e.type === 'receive') {
      const keep = relevant.some((i) => !sinks.has(i.lotId) || keptMoves.has(`${e.id}|${i.lotId}`));
      if (keep) events.push(e);
      continue;
    }
    if (e.type === 'ready' && endpointLocationId && e.locationId !== endpointLocationId) continue;
    events.push(e);
  }

  // ── steps (timeline) ───────────────────────────────────────────────────────
  const stepMap = new Map<string, Step>();
  for (const e of events) {
    const kind = markerKind(e, a.places);
    const placeKind = a.places.get(e.locationId)?.kind;
    let key: string;
    if (e.type === 'commission') key = `${kind}|${e.locationId}|${eventDate(e.eventTime)}`;
    else if (e.type === 'ship') key = `${kind}|${e.fromId}|${e.toId}|${eventDate(e.eventTime)}`;
    else if (e.type === 'receive') key = `${kind}|${e.locationId}|${e.fromId}|${eventDate(e.eventTime)}`;
    else key = `${kind}|${e.id}`;
    let st = stepMap.get(key);
    if (!st) {
      st = {
        id: `st-${stepMap.size + 1}`,
        kind,
        stage: e.type === 'ship' ? stageOf(a.places.get(e.fromId)?.kind) : e.type === 'transform' && (e.kind === 'refine' || e.kind === 'filter') ? 'refining' : stageOf(placeKind),
        locationId: e.locationId,
        fromId: e.type === 'receive' ? e.fromId : e.type === 'ship' ? e.fromId : undefined,
        toId: e.type === 'ship' || e.type === 'deliver' ? e.toId : undefined,
        groupId: e.type === 'issue' ? e.groupId : e.type === 'transform' ? e.groupId : undefined,
        events: [],
        start: e.eventTime,
        end: e.eventTime,
        lines: [],
        waypointId: `${kind}|${e.locationId}`,
      };
      stepMap.set(key, st);
    }
    st.events.push(e);
    if (ms(e.eventTime) < ms(st.start)) st.start = e.eventTime;
    if (ms(e.eventTime) > ms(st.end)) st.end = e.eventTime;
    const lines = eventLines(e).filter((l) => l.role !== 'item' || lotSet.has(l.lotId));
    st.lines.push(...lines);
  }
  const steps = [...stepMap.values()].sort((x, y) => ms(x.start) - ms(y.start));
  steps.forEach((s, i) => (s.id = `st-${i + 1}`));

  const wpMap = new Map<string, Waypoint>();
  for (const s of steps) {
    let w = wpMap.get(s.waypointId);
    if (!w) wpMap.set(s.waypointId, (w = { id: s.waypointId, kind: s.kind, locationId: s.locationId, stepIds: [], start: s.start, end: s.end }));
    w.stepIds.push(s.id);
    if (ms(s.end) > ms(w.end)) w.end = s.end;
  }

  const edgeMap = new Map<string, Edge>();
  for (const s of steps) {
    if (s.kind !== 'ship' && s.kind !== 'export' && s.kind !== 'delivery') continue;
    for (const l of s.lines) {
      const k = `${s.fromId ?? s.locationId}|${s.toId}|${l.product}`;
      let ed = edgeMap.get(k);
      if (!ed) edgeMap.set(k, (ed = { id: k, fromId: s.fromId ?? s.locationId, toId: s.toId!, product: l.product, qty: 0, count: 0, stepIds: [] }));
      ed.qty += l.qty;
      if (!ed.stepIds.includes(s.id)) ed.stepIds.push(s.id), (ed.count += 1);
    }
  }

  const areaIds = [...new Set(events.filter((e) => e.type === 'commission').map((e) => e.locationId))];
  void db;
  return { target, direction, lotSet, events, steps, waypoints: [...wpMap.values()], edges: [...edgeMap.values()], areaIds, status: lotStatus(a, lotId) };
}

export function stepTitle(s: Step, a: Analysis, db: DemoDB): string {
  const place = (id?: string) => (id ? a.places.get(id)?.name ?? id : '');
  const group = (id?: string) => db.groups.find((g) => g.id === id)?.name ?? '';
  const outs = s.lines.filter((l) => l.role === 'out').map((l) => l.lotId);
  const products = [...new Set(s.lines.map((l) => l.product))].join(', ');
  switch (s.kind) {
    case 'purchase':
      return `${s.events.length} purchase${s.events.length > 1 ? 's' : ''} of ${products} at ${place(s.locationId)}`;
    case 'ship':
    case 'export':
      return `Ship ${products} → ${place(s.toId)}`;
    case 'receive':
      return `Received at ${place(s.locationId)}`;
    case 'arrival':
      return `Arrived at ${place(s.locationId)}`;
    case 'issue':
      return `Issued ODK to ${group(s.groupId)}, ${place(s.locationId)}`;
    case 'kernel':
    case 'butter':
    case 'aggregate':
    case 'refine':
    case 'filter': {
      const e = s.events[0];
      const label = e.type === 'transform' ? TRANSFORM_LABEL(e.kind) : '';
      return `${label} · ${outs.join(', ')}${s.groupId ? ` (${group(s.groupId)})` : ''}`;
    }
    case 'ready':
      return `Arrived and ready for pickup`;
    case 'delivery':
      return `Delivered to ${place(s.toId)}`;
  }
}

export function sumBy(lines: { qty: number; role?: string }[], role?: string) {
  return lines.filter((l) => !role || l.role === role).reduce((s, l) => s + l.qty, 0);
}

/** One-line, plain-language summary of a stage's steps (used when the stage is collapsed). */
export function stageSummary(stage: StageId, steps: Step[], a: Analysis): string {
  const events = steps.flatMap((s) => s.events);
  const count = (k: MarkerKind) => steps.filter((s) => s.kind === k).reduce((n, s) => n + s.events.length, 0);
  const places = new Set(steps.map((s) => s.locationId));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : /(ch|sh|s|x)$/.test(w) ? 'es' : 's'}`;
  const kg = (k: MarkerKind[], role?: 'in' | 'out' | 'item') =>
    steps.filter((s) => k.includes(s.kind)).flatMap((s) => s.lines).filter((l) => !role || l.role === role).reduce((t, l) => t + l.qty, 0);
  const parts: string[] = [];
  switch (stage) {
    case 'origin': {
      const areas = new Set(events.filter((e) => e.type === 'commission').map((e) => e.locationId));
      parts.push(`${plural(count('purchase'), 'purchase')} across ${plural(areas.size, 'collection area')}`);
      parts.push(fmtKg(kg(['purchase'], 'out')));
      break;
    }
    case 'post-harvest':
      parts.push(`${plural(count('kernel'), 'OFN → ODK batch')}`, `${plural(count('receive'), 'receipt')}`);
      break;
    case 'butter':
      parts.push(`${plural(count('butter'), 'LPO')} from ${plural(new Set(steps.filter((s) => s.kind === 'butter').map((s) => s.groupId)).size, 'group')} at ${plural(places.size, 'centre')}`);
      break;
    case 'warehouse': {
      const agg = steps.find((s) => s.kind === 'aggregate');
      parts.push(agg ? `${agg.lines.filter((l) => l.role === 'in').length} LPO draws → ${agg.lines.filter((l) => l.role === 'out').map((l) => l.lotId).join(', ')}` : plural(events.length, 'event'));
      break;
    }
    case 'export':
    case 'destination': {
      const names = [...places].map((id) => a.places.get(id)?.name.replace(/^DEMO /, '') ?? id);
      parts.push(names.slice(0, 3).join(' · ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
      break;
    }
    case 'refining':
      parts.push(`${plural(count('refine') + count('filter'), 'run')}`, fmtKg(kg(['refine', 'filter'], 'out')) + ' out');
      break;
  }
  return parts.filter(Boolean).join(' · ');
}
