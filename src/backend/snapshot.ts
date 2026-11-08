// Maps the RLS-scoped server snapshot (public.get_workspace_snapshot) into the
// front-end DemoDB shape so the same screens, engine and trace builder work in
// live mode. Pure functions — no network — so they are testable offline.

import type { DemoDB, LotQty, ProductCode, TraceEvent } from '../data/types';
import type { LotKind } from '../domain/engine';

export interface SnapshotLot {
  lotId: string;
  product: ProductCode;
  kind: string; // purchase | kernel-batch | lpo | sfcl | refined | filtered
  createdAt: string;
  locationId: string;
}

export interface Snapshot extends Omit<DemoDB, 'externalLots'> {
  lots?: SnapshotLot[];
}

export interface ExternalLot {
  lotId: string;
  product: ProductCode;
  kind: LotKind;
  createdAt: string;
  locationId: string;
  qty: number;
}

const createdIn = (e: TraceEvent): LotQty[] => (e.type === 'commission' ? e.outputs : e.type === 'transform' ? e.outputs : []);

/** Where (and how much of) a lot is drawn by an event, if it consumes stock. */
function draws(e: TraceEvent): { lotId: string; qty: number; at: string; locationId: string }[] {
  switch (e.type) {
    case 'ship':
      return e.items.map((i) => ({ lotId: i.lotId, qty: i.qty, at: e.eventTime, locationId: e.fromId }));
    case 'issue':
      return e.items.map((i) => ({ lotId: i.lotId, qty: i.qty, at: e.eventTime, locationId: e.locationId }));
    case 'deliver':
      return e.items.map((i) => ({ lotId: i.lotId, qty: i.qty, at: e.eventTime, locationId: e.locationId }));
    case 'transform':
      return e.kind === 'butter' ? [] : e.inputs.map((i) => ({ lotId: i.lotId, qty: i.qty, at: e.eventTime, locationId: e.locationId }));
    default:
      return [];
  }
}

/**
 * Lots used by visible events whose creating event is not visible to this user
 * (e.g. a butter officer sees an inbound lot but not the purchase that created it).
 * They become "external" lots with just enough opening stock at the place they are
 * first drawn from, so validation of the visible events is not falsely blocked.
 * This never reveals the hidden events — only what the visible ones already say.
 */
export function externalLotsFor(events: TraceEvent[], lots: SnapshotLot[] = []): ExternalLot[] {
  const created = new Set(events.flatMap((e) => createdIn(e).map((l) => l.lotId)));
  const meta = new Map(lots.map((l) => [l.lotId, l]));
  const byLot = new Map<string, { first: { at: string; locationId: string }; qty: number; product: ProductCode }>();
  const sorted = [...events].sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
  for (const e of sorted) {
    const lines = 'items' in e ? e.items : e.type === 'transform' ? e.inputs : [];
    for (const d of draws(e)) {
      if (created.has(d.lotId)) continue;
      const cur = byLot.get(d.lotId);
      const product = lines.find((l) => l.lotId === d.lotId)?.product ?? 'ODK';
      if (!cur) byLot.set(d.lotId, { first: { at: d.at, locationId: d.locationId }, qty: d.qty, product });
      else if (cur.first.locationId === d.locationId) cur.qty += d.qty;
    }
    // butter inputs come from issued kernel; the issue itself is the visible draw
  }
  return [...byLot.entries()].map(([lotId, v]) => {
    const m = meta.get(lotId);
    const createdAt = m?.createdAt ?? new Date(new Date(v.first.at).getTime() - 1000).toISOString();
    return {
      lotId,
      product: m?.product ?? v.product,
      kind: (m?.kind ?? 'purchase') as LotKind,
      createdAt: new Date(createdAt).getTime() < new Date(v.first.at).getTime() ? createdAt : new Date(new Date(v.first.at).getTime() - 1000).toISOString(),
      locationId: v.first.locationId,
      qty: v.qty,
    };
  });
}

export function snapshotToDb(s: Snapshot): DemoDB {
  const events = (s.events ?? []).map((e) => ({ ...e, demo: false, version: e.version ?? 1 })) as TraceEvent[];
  return {
    schemaVersion: s.schemaVersion,
    seededAt: s.seededAt,
    locations: s.locations ?? [],
    collectionAreas: s.collectionAreas ?? [],
    collectors: s.collectors ?? [],
    groups: s.groups ?? [],
    routes: s.routes ?? [],
    events,
    handoffs: s.handoffs ?? [],
    documents: s.documents ?? [],
    audit: s.audit ?? [],
    users: s.users ?? [],
    invitations: s.invitations ?? [],
    externalLots: externalLotsFor(events, s.lots),
  };
}
