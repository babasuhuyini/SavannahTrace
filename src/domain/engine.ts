// The validation + inventory engine. It replays every event in event-time order
// and rebuilds lots, custody, stock and findings from scratch (never accumulated),
// so a correction anywhere is reflected everywhere. Nothing is ever repaired
// automatically: problems become findings for a person to resolve.

import type {
  CollectionArea,
  DemoDB,
  Location,
  LocationKind,
  LotQty,
  ProductCode,
  ShipEvent,
  TraceEvent,
  TransformEvent,
  TransformKind,
} from '../data/types';
import { PRODUCTS } from '../data/types';
import { eventDate, fmtEventTime, fmtKg, mmddyy } from './format';

export type Severity = 'blocking' | 'review' | 'info';

export interface Finding {
  key: string;
  severity: Severity;
  rule: RuleId;
  message: string;
  eventId?: string;
  lotId?: string;
}

export type RuleId =
  | 'quantity'
  | 'product'
  | 'unknown-id'
  | 'duplicate-id'
  | 'duplicate-submission'
  | 'one-commission-per-day'
  | 'lot-id-pattern'
  | 'chronology'
  | 'future-time'
  | 'custody'
  | 'available-balance'
  | 'receipt-quantity'
  | 'discrepancy'
  | 'yield'
  | 'draw-norm'
  | 'sfcl-total'
  | 'sfcl-progress'
  | 'mass-balance'
  | 'route'
  | 'in-transit'
  | 'eligibility'
  | 'master-data';

export const RULES: Record<RuleId, string> = {
  quantity: 'Positive quantities',
  product: 'Valid product for the stage',
  'unknown-id': 'Known identifiers only',
  'duplicate-id': 'Unique business identifiers',
  'duplicate-submission': 'No duplicate submissions',
  'one-commission-per-day': 'One commission per collector per day',
  'lot-id-pattern': 'Lot ID matches collector and purchase date',
  chronology: 'Event chronology (full timestamps)',
  'future-time': 'Event time not in the future',
  custody: 'Custody / location continuity',
  'available-balance': 'No consumption beyond available balance',
  'receipt-quantity': 'Receipt matches shipment',
  discrepancy: 'Discrepancies resolved',
  yield: 'Conversion yield within proposed band',
  'draw-norm': 'LPO draw within usual 3,000 kg norm',
  'sfcl-total': 'SFCL finalized at exactly 21,000 kg',
  'sfcl-progress': 'SFCL aggregation status',
  'mass-balance': 'Aggregation mass balance',
  route: 'Product route rules',
  'in-transit': 'Shipments awaiting receipt',
  eligibility: 'Ready-for-pickup eligibility',
  'master-data': 'Master data references',
};

export type LotKind = 'purchase' | 'kernel-batch' | 'lpo' | 'sfcl' | 'refined' | 'filtered';

export interface LotRecord {
  lotId: string;
  product: ProductCode;
  kind: LotKind;
  createdBy: string;
  createdAt: string;
  createdQty: number;
  createdAtLocation: string;
  parents: { lotId: string; qty: number }[];
  children: { lotId: string; qty: number; eventId: string }[];
  collectorId?: string;
  collectionAreaId?: string;
  sfclStage?: 'in-progress' | 'finalized';
  demo?: boolean;
}

export interface Place {
  id: string;
  name: string;
  kind: LocationKind | 'collection-area';
  lat: number;
  lng: number;
  publicLabel: string;
  country: string;
  demo: boolean;
  publicPlace?: boolean;
}

export interface Analysis {
  sorted: TraceEvent[];
  byId: Map<string, TraceEvent>;
  lots: Map<string, LotRecord>;
  /** lot → location → kg on hand (accepted, not issued to a group) */
  stock: Map<string, Map<string, number>>;
  /** lot → group → kg issued and not yet consumed */
  allocated: Map<string, Map<string, number>>;
  openShipments: ShipEvent[];
  receiptOf: Map<string, string>; // ship id → receive id
  findings: Finding[];
  places: Map<string, Place>;
}

export const SFCL_TARGET = 21000;
export const DRAW_NORM = 3000;
export const YIELD_BANDS: Partial<Record<TransformKind, [number, number]>> = {
  kernel: [0.28, 0.4],
  butter: [0.3, 0.48],
  refine: [0.85, 1.0],
  filter: [0.9, 1.0],
};

const STAGE_RULES: Record<TransformKind, { in: ProductCode[]; out: ProductCode[]; at: LocationKind[]; label: string }> = {
  kernel: { in: ['OFN'], out: ['ODK'], at: ['phc'], label: 'OFN → ODK' },
  butter: { in: ['ODK'], out: ['OSB'], at: ['butter-centre'], label: 'ODK → OSB (LPO)' },
  aggregation: { in: ['OSB'], out: ['OSB'], at: ['warehouse'], label: 'LPOs → SFCL' },
  refine: { in: ['OSB'], out: ['ORSB'], at: ['refiner'], label: 'OSB → ORSB' },
  filter: { in: ['OSB', 'ORSB'], out: ['OFSB', 'OFSB-FFL'], at: ['filterer'], label: 'OSB → OFSB' },
};
export const TRANSFORM_LABEL = (k: TransformKind) => STAGE_RULES[k].label;
export const transformRule = (k: TransformKind) => STAGE_RULES[k];

const TYPE_ORDER: Record<TraceEvent['type'], number> = { commission: 0, ship: 1, receive: 2, issue: 3, transform: 4, ready: 5, deliver: 6 };

export const ms = (iso: string) => new Date(iso).getTime();

export function sortEvents(events: TraceEvent[]) {
  return [...events].sort(
    (a, b) => ms(a.eventTime) - ms(b.eventTime) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.recordedAt.localeCompare(b.recordedAt),
  );
}

export function areaCentroid(a: CollectionArea): [number, number] {
  const pts = a.polygon.slice(0, a.polygon.length > 1 && a.polygon[0][0] === a.polygon.at(-1)![0] && a.polygon[0][1] === a.polygon.at(-1)![1] ? -1 : undefined);
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lng, lat];
}

export function buildPlaces(db: Pick<DemoDB, 'locations' | 'collectionAreas'>): Map<string, Place> {
  const m = new Map<string, Place>();
  for (const a of db.collectionAreas) {
    const [lng, lat] = areaCentroid(a);
    m.set(a.id, {
      id: a.id,
      name: a.name,
      kind: 'collection-area',
      lat,
      lng,
      publicLabel: 'Certified forest-reserve collection area',
      country: 'Ghana',
      demo: a.demo,
    });
  }
  for (const l of db.locations as Location[]) {
    m.set(l.id, { id: l.id, name: l.name, kind: l.kind, lat: l.lat, lng: l.lng, publicLabel: l.publicLabel, country: l.country, demo: l.demo, publicPlace: l.publicPlace });
  }
  return m;
}

const add = (m: Map<string, Map<string, number>>, lot: string, key: string, q: number) => {
  let inner = m.get(lot);
  if (!inner) m.set(lot, (inner = new Map()));
  const v = (inner.get(key) ?? 0) + q;
  if (Math.abs(v) < 1e-9) inner.delete(key);
  else inner.set(key, v);
};
const get = (m: Map<string, Map<string, number>>, lot: string, key: string) => m.get(lot)?.get(key) ?? 0;

export function lotLocations(a: Analysis, lotId: string) {
  return [...(a.stock.get(lotId)?.entries() ?? [])].filter(([, q]) => q > 0);
}

export function analyze(db: DemoDB, now = Date.now()): Analysis {
  const places = buildPlaces(db);
  const sorted = sortEvents(db.events);
  const byId = new Map(db.events.map((e) => [e.id, e]));
  const lots = new Map<string, LotRecord>();
  const stock = new Map<string, Map<string, number>>();
  const allocated = new Map<string, Map<string, number>>();
  const transit = new Map<string, ShipEvent>();
  const receiptOf = new Map<string, string>();
  const findings: Finding[] = [];
  const signatures = new Map<string, string>();
  const commissionKeys = new Map<string, string>();
  const readyKeys = new Map<string, string>();
  const collectors = new Map(db.collectors.map((c) => [c.id, c]));
  const groups = new Map(db.groups.map((g) => [g.id, g]));

  // Live mode: lots created by events this user cannot see start with an opening balance.
  for (const x of db.externalLots ?? []) {
    lots.set(x.lotId, { lotId: x.lotId, product: x.product, kind: x.kind, createdBy: 'external', createdAt: x.createdAt, createdQty: x.qty, createdAtLocation: x.locationId, parents: [], children: [], sfclStage: x.kind === 'sfcl' ? 'finalized' : undefined });
    add(stock, x.lotId, x.locationId, x.qty);
  }
  const placeName = (id: string) => places.get(id)?.name ?? id;
  const push = (severity: Severity, rule: RuleId, message: string, e?: TraceEvent, lotId?: string) =>
    findings.push({ key: `${rule}|${e?.id ?? ''}|${lotId ?? ''}|${message}`, severity, rule, message, eventId: e?.id, lotId });

  const where = (lotId: string) => {
    const locs = lotLocations({ stock } as Analysis, lotId).map(([l, q]) => `${placeName(l)} (${fmtKg(q)})`);
    return locs.length ? locs.join(', ') : 'nowhere — fully used or in transit';
  };

  const checkQty = (e: TraceEvent, li: LotQty) => {
    if (!(li.qty > 0) || !Number.isFinite(li.qty)) {
      push('blocking', 'quantity', `Quantity for ${li.lotId || 'a line'} must be a positive number of kg.`, e, li.lotId);
      return false;
    }
    if (!PRODUCTS[li.product]) {
      push('blocking', 'product', `“${li.product}” is not a valid product code.`, e, li.lotId);
      return false;
    }
    return true;
  };

  /** A lot leaving a location's stock (ship, issue, non-butter transform input, deliver). */
  const drawFrom = (e: TraceEvent, li: LotQty, locId: string, verb: string) => {
    const lot = lots.get(li.lotId);
    if (!lot) {
      push('blocking', 'unknown-id', `${li.lotId} has no creating event (purchase or transformation). Identifiers are never guessed — check the ID.`, e, li.lotId);
      return;
    }
    if (lot.product !== li.product) push('blocking', 'product', `${li.lotId} is ${lot.product}, not ${li.product}.`, e, li.lotId);
    if (ms(e.eventTime) <= ms(lot.createdAt)) {
      push('blocking', 'chronology', `${verb} ${li.lotId} at ${fmtEventTime(e.eventTime)}, before or at the time it was created (${fmtEventTime(lot.createdAt)}).`, e, li.lotId);
    }
    const avail = get(stock, li.lotId, locId);
    if (avail <= 0) {
      push('blocking', 'custody', `${li.lotId} is not held at ${placeName(locId)} at this time. Currently: ${where(li.lotId)}.`, e, li.lotId);
      return;
    }
    if (li.qty > avail + 1e-9) {
      push('blocking', 'available-balance', `${verb} ${fmtKg(li.qty)} of ${li.lotId}, but only ${fmtKg(avail)} is available at ${placeName(locId)}.`, e, li.lotId);
    }
    add(stock, li.lotId, locId, -Math.min(avail, li.qty));
  };

  for (const e of sorted) {
    const t = ms(e.eventTime);
    if (Number.isNaN(t)) {
      push('blocking', 'chronology', 'Event time is missing or not a valid date/time.', e);
      continue;
    }
    if (t > now + 5 * 60_000) push('blocking', 'future-time', `Event time ${fmtEventTime(e.eventTime)} is in the future.`, e);
    if (!places.has(e.locationId)) push('blocking', 'master-data', `Location “${e.locationId}” is not in the location register.`, e);

    // duplicate submission signature (content identical to an earlier event)
    const lines = 'items' in e ? e.items : e.type === 'commission' ? e.outputs : e.type === 'transform' ? [...e.inputs, ...e.outputs] : [];
    const sig = [e.type, e.eventTime, e.locationId, 'toId' in e ? e.toId : '', ...lines.map((l) => `${l.lotId}:${l.qty}`).sort()].join('|');
    const prior = signatures.get(sig);
    if (prior) push('blocking', 'duplicate-submission', `Looks identical to an earlier ${e.type} event (same time, place, lots and quantities). Possible double submission.`, e);
    else signatures.set(sig, e.id);

    switch (e.type) {
      case 'commission': {
        const o = e.outputs[0];
        if (!o || !checkQty(e, o)) break;
        if (o.product !== 'OFN' && o.product !== 'ODK') push('blocking', 'product', `A purchase must be OFN or ODK (got ${o.product}).`, e, o.lotId);
        // 'withheld' = customer-facing payload where collector identity is deliberately removed
        const col = e.collectorId === 'withheld' ? undefined : collectors.get(e.collectorId);
        if (!col && e.collectorId !== 'withheld') push('blocking', 'master-data', 'Collector is not on the collector register.', e, o.lotId);
        else if (col && col.collectionAreaId !== e.locationId)
          push('blocking', 'master-data', `${col.name} (${col.code}) belongs to ${placeName(col.collectionAreaId)}, not ${placeName(e.locationId)}.`, e, o.lotId);
        if (places.get(e.locationId) && places.get(e.locationId)!.kind !== 'collection-area')
          push('blocking', 'master-data', 'Purchases must be recorded at a collection area.', e, o.lotId);
        if (lots.has(o.lotId)) {
          push('blocking', 'duplicate-id', `Lot ID ${o.lotId} already exists. Each purchase lot ID must be unique.`, e, o.lotId);
          break;
        }
        const ck = `${e.collectorId}|${e.purchaseDate}`;
        if (commissionKeys.has(ck)) {
          const other = byId.get(commissionKeys.get(ck)!) as TraceEvent & { outputs: LotQty[] };
          push('blocking', 'one-commission-per-day', `This collector already has a purchase on ${e.purchaseDate} (${other?.outputs?.[0]?.lotId}). Same collector + same date is one commission record — add to that record instead.`, e, o.lotId);
        } else commissionKeys.set(ck, e.id);
        if (col) {
          const expected = `${col.code}-${mmddyy(e.purchaseDate)}`;
          if (o.lotId !== expected)
            push('review', 'lot-id-pattern', `Lot ID “${o.lotId}” does not match the expected pattern “${expected}” (collector code + purchase date). Kept exactly as entered — please confirm.`, e, o.lotId);
        }
        if (eventDate(e.eventTime) !== e.purchaseDate)
          push('review', 'chronology', `Event date ${eventDate(e.eventTime)} differs from the purchase date ${e.purchaseDate}. Event time should be when the purchase happened.`, e, o.lotId);
        lots.set(o.lotId, {
          lotId: o.lotId,
          product: o.product,
          kind: 'purchase',
          createdBy: e.id,
          createdAt: e.eventTime,
          createdQty: o.qty,
          createdAtLocation: e.locationId,
          parents: [],
          children: [],
          collectorId: e.collectorId,
          collectionAreaId: e.locationId,
          demo: e.demo,
        });
        add(stock, o.lotId, e.locationId, o.qty);
        break;
      }

      case 'ship': {
        if (!places.has(e.toId)) push('blocking', 'master-data', `Destination “${e.toId}” is not in the location register.`, e);
        if (e.fromId === e.toId) push('blocking', 'custody', 'Origin and destination are the same location.', e);
        if (!e.items.length) push('blocking', 'quantity', 'A shipment needs at least one lot.', e);
        const dest = places.get(e.toId);
        for (const li of e.items) {
          if (!checkQty(e, li)) continue;
          const lot = lots.get(li.lotId);
          if (lot?.product === 'OFN' && dest && dest.kind !== 'phc')
            push('blocking', 'route', `${li.lotId} is fresh nut (OFN); it must go to a Post Harvest Centre before any other stage.`, e, li.lotId);
          if (lot?.kind === 'sfcl' && lot.sfclStage !== 'finalized')
            push('blocking', 'sfcl-total', `${li.lotId} is still in progress and cannot ship until finalized at ${fmtKg(SFCL_TARGET)}.`, e, li.lotId);
          drawFrom(e, li, e.fromId, 'Ships');
        }
        transit.set(e.id, e);
        break;
      }

      case 'receive': {
        const s = byId.get(e.shipEventId);
        if (!s || s.type !== 'ship') {
          push('blocking', 'unknown-id', 'This receipt does not reference a recorded shipment.', e);
          break;
        }
        if (receiptOf.has(s.id) && receiptOf.get(s.id) !== e.id) {
          push('blocking', 'duplicate-submission', `Shipment from ${placeName(s.fromId)} on ${fmtEventTime(s.eventTime, false)} has already been received.`, e);
          break;
        }
        receiptOf.set(s.id, e.id);
        if (e.locationId !== s.toId) push('blocking', 'custody', `Received at ${placeName(e.locationId)}, but the shipment was sent to ${placeName(s.toId)}.`, e);
        if (t <= ms(s.eventTime))
          push('blocking', 'chronology', `Receipt (${fmtEventTime(e.eventTime)}) must be after the shipment left (${fmtEventTime(s.eventTime)}).`, e);
        for (const li of e.items) {
          if (!(li.qty >= 0)) {
            push('blocking', 'quantity', `Received quantity for ${li.lotId} must be zero or more.`, e, li.lotId);
            continue;
          }
          const sent = s.items.find((x) => x.lotId === li.lotId);
          if (!sent) {
            push('blocking', 'unknown-id', `${li.lotId} was not on this shipment.`, e, li.lotId);
            continue;
          }
          if (li.qty > sent.qty) push('blocking', 'available-balance', `Received ${fmtKg(li.qty)} of ${li.lotId} but only ${fmtKg(sent.qty)} was shipped.`, e, li.lotId);
          else if (li.qty < sent.qty && e.outcome !== 'discrepancy')
            push('review', 'receipt-quantity', `Received ${fmtKg(li.qty)} of ${li.lotId}; ${fmtKg(sent.qty)} was shipped. Record this as a discrepancy.`, e, li.lotId);
          if (li.qty > 0) add(stock, li.lotId, e.locationId, Math.min(li.qty, sent.qty));
        }
        if (e.outcome === 'discrepancy' && !e.discrepancyResolution)
          push('review', 'discrepancy', `Discrepancy reported at ${placeName(e.locationId)}: ${e.discrepancyNote || 'no note given'}. Awaiting resolution.`, e);
        transit.delete(s.id);
        break;
      }

      case 'issue': {
        const g = groups.get(e.groupId);
        if (!g) push('blocking', 'master-data', 'Processing group is not registered.', e);
        else if (g.centreId !== e.locationId) push('blocking', 'master-data', `${g.name} belongs to ${placeName(g.centreId)}, not ${placeName(e.locationId)}.`, e);
        for (const li of e.items) {
          if (!checkQty(e, li)) continue;
          if (li.product !== 'ODK') push('blocking', 'product', `Only dried kernel (ODK) is issued to processing groups (${li.lotId} is ${li.product}).`, e, li.lotId);
          const before = get(stock, li.lotId, e.locationId);
          drawFrom(e, li, e.locationId, 'Issues');
          add(allocated, li.lotId, e.groupId, Math.min(before, li.qty));
        }
        break;
      }

      case 'transform': {
        const rule = STAGE_RULES[e.kind];
        const place = places.get(e.locationId);
        if (place && !rule.at.includes(place.kind as LocationKind))
          push('blocking', 'master-data', `${rule.label} must be recorded at a ${rule.at.join('/')} location, not ${place.name}.`, e);
        if (e.kind === 'butter') {
          const g = e.groupId ? groups.get(e.groupId) : undefined;
          if (!g) push('blocking', 'master-data', 'Butter processing needs the processing group.', e);
          else if (g.centreId !== e.locationId) push('blocking', 'master-data', `${g.name} is not a group at ${placeName(e.locationId)}.`, e);
        }
        if (!e.inputs.length) push('blocking', 'quantity', 'A transformation needs at least one Input row.', e);
        if (!e.outputs.length) push('blocking', 'quantity', 'A transformation needs at least one Output row (the batch ID supplied by the officer).', e);
        let inSum = 0;
        for (const li of e.inputs) {
          if (!checkQty(e, li)) continue;
          inSum += li.qty;
          if (!rule.in.includes(li.product)) push('blocking', 'product', `${rule.label} inputs must be ${rule.in.join('/')} (${li.lotId} is ${li.product}).`, e, li.lotId);
          const lot = lots.get(li.lotId);
          if (e.kind === 'aggregation') {
            if (lot && lot.kind !== 'lpo') push('review', 'product', `${li.lotId} is not an LPO crude-butter batch.`, e, li.lotId);
            if (li.qty > DRAW_NORM)
              push('review', 'draw-norm', `${li.lotId} contributes ${fmtKg(li.qty)}, above the usual ${fmtKg(DRAW_NORM)} draw. Allowed when it closes a shortfall from another LPO — confirm the reason. Not blocked.`, e, li.lotId);
          }
          if (e.kind === 'butter' && e.groupId) {
            if (!lot) {
              push('blocking', 'unknown-id', `${li.lotId} has no creating event. Identifiers are never guessed.`, e, li.lotId);
              continue;
            }
            if (t <= ms(lot.createdAt)) push('blocking', 'chronology', `Uses ${li.lotId} before it was created.`, e, li.lotId);
            const issued = get(allocated, li.lotId, e.groupId);
            if (issued <= 0) {
              const atCentre = get(stock, li.lotId, e.locationId);
              push('blocking', 'custody', atCentre > 0 ? `${li.lotId} is at the centre but has not been issued to this group.` : `${li.lotId} has not been issued to this group. Currently: ${where(li.lotId)}.`, e, li.lotId);
              continue;
            }
            if (li.qty > issued + 1e-9) push('blocking', 'available-balance', `Uses ${fmtKg(li.qty)} of ${li.lotId}, but only ${fmtKg(issued)} was issued to this group.`, e, li.lotId);
            add(allocated, li.lotId, e.groupId, -Math.min(issued, li.qty));
          } else {
            drawFrom(e, li, e.locationId, 'Uses');
          }
          if (lot) lot.children.push(...e.outputs.map((o) => ({ lotId: o.lotId, qty: li.qty, eventId: e.id })));
        }
        let outSum = 0;
        for (const o of e.outputs) {
          if (!checkQty(e, o)) continue;
          outSum += o.qty;
          if (!rule.out.includes(o.product)) push('blocking', 'product', `${rule.label} outputs must be ${rule.out.join('/')} (${o.lotId} is ${o.product}).`, e, o.lotId);
          if (lots.has(o.lotId)) {
            push('blocking', 'duplicate-id', `Output ID ${o.lotId} already exists. Output batch IDs must be new.`, e, o.lotId);
            continue;
          }
          const kind: LotKind = e.kind === 'kernel' ? 'kernel-batch' : e.kind === 'butter' ? 'lpo' : e.kind === 'aggregation' ? 'sfcl' : e.kind === 'refine' ? 'refined' : 'filtered';
          lots.set(o.lotId, {
            lotId: o.lotId,
            product: o.product,
            kind,
            createdBy: e.id,
            createdAt: e.eventTime,
            createdQty: o.qty,
            createdAtLocation: e.locationId,
            parents: e.inputs.map((i) => ({ lotId: i.lotId, qty: i.qty })),
            children: [],
            sfclStage: e.kind === 'aggregation' ? e.sfclStage ?? 'in-progress' : undefined,
            demo: e.demo,
          });
          add(stock, o.lotId, e.locationId, o.qty);
        }
        const band = YIELD_BANDS[e.kind];
        if (band && inSum > 0 && outSum > 0) {
          const y = outSum / inSum;
          if (y < band[0] || y > band[1])
            push('review', 'yield', `${rule.label} yield is ${(y * 100).toFixed(1)}% (${fmtKg(outSum)} from ${fmtKg(inSum)}); the proposed band is ${band[0] * 100}–${band[1] * 100}%.`, e);
        }
        if (e.kind === 'aggregation') checkAggregation(e, inSum, outSum, push);
        break;
      }

      case 'ready': {
        const place = places.get(e.locationId);
        // In Amsterdam a shipment is refined or filtered; it is ready for pickup there.
        if (place && !['refiner', 'filterer', 'destination-warehouse'].includes(place.kind))
          push('blocking', 'eligibility', `Ready for pickup is recorded at the refiner or filterer, not ${place.name}.`, e);
        for (const li of e.items) {
          if (!checkQty(e, li)) continue;
          const k = `${li.lotId}|${e.locationId}`;
          if (readyKeys.has(k)) push('blocking', 'duplicate-submission', `${li.lotId} is already marked ready for pickup at ${placeName(e.locationId)}.`, e, li.lotId);
          readyKeys.set(k, e.id);
          const held = get(stock, li.lotId, e.locationId);
          if (held <= 0) push('blocking', 'eligibility', `${li.lotId} has not been received at ${placeName(e.locationId)}. Currently: ${where(li.lotId)}.`, e, li.lotId);
          else if (li.qty > held + 1e-9) push('blocking', 'available-balance', `Ready quantity ${fmtKg(li.qty)} exceeds the ${fmtKg(held)} held here.`, e, li.lotId);
        }
        break;
      }

      case 'deliver': {
        const dest = places.get(e.toId);
        if (!dest || dest.kind !== 'client') push('blocking', 'master-data', 'Delivery destination must be a client location.', e);
        for (const li of e.items) {
          if (!checkQty(e, li)) continue;
          drawFrom(e, li, e.locationId, 'Delivers');
          add(stock, li.lotId, e.toId, li.qty);
        }
        break;
      }
    }
  }

  for (const s of transit.values()) {
    findings.push({
      key: `in-transit|${s.id}`,
      severity: 'info',
      rule: 'in-transit',
      message: `In transit from ${placeName(s.fromId)} to ${placeName(s.toId)} since ${fmtEventTime(s.eventTime)} — awaiting receipt (not an error).`,
      eventId: s.id,
    });
  }

  return { sorted, byId, lots, stock, allocated, openShipments: [...transit.values()], receiptOf, findings, places };
}

function checkAggregation(e: TransformEvent, inSum: number, outSum: number, push: (s: Severity, r: RuleId, m: string, e?: TraceEvent, lot?: string) => void) {
  if (e.outputs.length !== 1) push('blocking', 'mass-balance', 'An SFCL aggregation has exactly one Output row (the SFCL).', e);
  if (Math.abs(inSum - outSum) > 1e-6) push('blocking', 'mass-balance', `SFCL output ${fmtKg(outSum)} does not equal the LPO inputs ${fmtKg(inSum)}.`, e);
  const id = e.outputs[0]?.lotId;
  if (inSum > SFCL_TARGET) push('blocking', 'sfcl-total', `${id} totals ${fmtKg(inSum)}, over the ${fmtKg(SFCL_TARGET)} limit. Remove or reduce a draw.`, e, id);
  else if (e.sfclStage === 'finalized' && inSum !== SFCL_TARGET)
    push('blocking', 'sfcl-total', `${id} can only be finalized at exactly ${fmtKg(SFCL_TARGET)} (currently ${fmtKg(inSum)}).`, e, id);
  else if (e.sfclStage !== 'finalized')
    push('info', 'sfcl-progress', `${id} is in progress: ${fmtKg(inSum)} of ${fmtKg(SFCL_TARGET)} (${fmtKg(SFCL_TARGET - inSum)} to go).`, e, id);
}

/** Validate a draft against current data: findings on the draft plus new findings it causes elsewhere. */
export function validateDraft(db: DemoDB, draft: TraceEvent, replaceId?: string) {
  const base = analyze(db);
  const baseKeys = new Set(base.findings.map((f) => f.key));
  const events = replaceId ? db.events.map((e) => (e.id === replaceId ? draft : e)) : [...db.events, draft];
  const next = analyze({ ...db, events });
  const own = next.findings.filter((f) => f.eventId === draft.id);
  const knockOn = next.findings.filter((f) => f.eventId !== draft.id && !baseKeys.has(f.key) && f.severity !== 'info');
  return { own, knockOn, analysis: next };
}

/** Lots available (accepted, unissued) at a location. */
export function heldAt(a: Analysis, locationId: string, products?: ProductCode[]) {
  const out: (LotQty & { lot: LotRecord })[] = [];
  for (const [lotId, m] of a.stock) {
    const q = m.get(locationId) ?? 0;
    const lot = a.lots.get(lotId);
    if (q > 0 && lot && (!products || products.includes(lot.product))) out.push({ lotId, product: lot.product, qty: q, lot });
  }
  return out.sort((x, y) => ms(x.lot.createdAt) - ms(y.lot.createdAt) || x.lotId.localeCompare(y.lotId));
}

export function issuedTo(a: Analysis, groupId: string) {
  const out: (LotQty & { lot: LotRecord })[] = [];
  for (const [lotId, m] of a.allocated) {
    const q = m.get(groupId) ?? 0;
    const lot = a.lots.get(lotId);
    if (q > 0 && lot) out.push({ lotId, product: lot.product, qty: q, lot });
  }
  return out.sort((x, y) => x.lotId.localeCompare(y.lotId));
}

export function severityCounts(fs: Finding[]) {
  return {
    blocking: fs.filter((f) => f.severity === 'blocking').length,
    review: fs.filter((f) => f.severity === 'review').length,
    info: fs.filter((f) => f.severity === 'info').length,
  };
}
