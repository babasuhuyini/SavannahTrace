// CSV exports that open cleanly in Excel: UTF-8 with BOM, CRLF line endings,
// quoted fields, and leading = + - @ neutralised so a cell can never run as a
// formula. Every report is built from data the viewer can already see (the
// RLS-scoped snapshot in live mode, the scoped demo data in demo mode), and
// personal data / prices are included only when the viewer's role allows.

import { MARKER_META } from '../components/markers';
import { PRODUCTS, type DemoDB, type TraceEvent } from '../data/types';
import { RULES, TRANSFORM_LABEL, type Analysis, type Finding } from './engine';
import { STAGES, eventLines, lotStatus, markerKind, type Trace } from './trace';

export type Cell = string | number | boolean | null | undefined;
export interface Csv {
  filename: string;
  headers: string[];
  rows: Cell[][];
}

const cell = (v: Cell): string => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // formula-injection guard
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(c: Csv): string {
  return '﻿' + [c.headers, ...c.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCsv(c: Csv) {
  const blob = new Blob([toCsv(c)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: c.filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
const d = (iso?: string) => (iso ? iso.slice(0, 10) : '');
const t = (iso?: string) => (iso ? iso.slice(11, 16) : '');
const off = (iso?: string) => (iso ? (iso.endsWith('Z') ? '+00:00' : iso.slice(19)) : '');
const kg = (n: number) => Math.round(n * 1000) / 1000;

export interface Privacy {
  /** Collector names (IT Admin, Auditor, Nut FO for own areas). */
  pii: boolean;
  prices: boolean;
  /** Internal fields: recorded time/role, notes, evidence, findings. False for customers. */
  internal: boolean;
}

export const inRange = (e: TraceEvent, from?: string, to?: string) => (!from || d(e.eventTime) >= from) && (!to || d(e.eventTime) <= to);

// ── per-trace reports ───────────────────────────────────────────────────────
export function traceEventsCsv(trace: Trace, a: Analysis, db: DemoDB, p: Privacy): Csv {
  const place = (id?: string) => (id ? a.places.get(id) : undefined);
  const headers = [
    'Trace of', 'Step', 'Stage', 'Event', 'Event date', 'Event time', 'UTC offset',
    ...(p.internal ? ['Recorded at (UTC)', 'Recorded by role'] : []),
    'Place', 'Place type', 'Country', 'From', 'To', 'Lot / batch ID', 'Product code', 'Product', 'Line', 'Quantity (kg)',
    'Processing group', 'Shipment ref', 'Container', 'Vessel', 'ETA', 'Client', 'Order ref', 'Purchase date',
    ...(p.pii ? ['Collector'] : []), ...(p.prices ? ['Price per kg', 'Currency'] : []),
    ...(p.internal ? ['Notes', 'Evidence', 'Version', 'Demo record'] : []),
  ];
  const rows: Cell[][] = [];
  trace.steps.forEach((s, i) => {
    const stage = STAGES.find((x) => x.id === s.stage)?.label;
    for (const e of s.events) {
      const lines = eventLines(e).filter((l) => l.role !== 'item' || trace.lotSet.has(l.lotId));
      const ship = e.type === 'ship' ? e : undefined;
      const com = e.type === 'commission' ? e : undefined;
      const from = e.type === 'ship' || e.type === 'receive' ? e.fromId : undefined;
      const to = e.type === 'ship' || e.type === 'deliver' ? e.toId : undefined;
      const group = e.type === 'issue' ? e.groupId : e.type === 'transform' ? e.groupId : undefined;
      for (const l of lines) {
        rows.push([
          trace.target.lotId, i + 1, stage, MARKER_META[markerKind(e, a.places)].label, d(e.eventTime), t(e.eventTime), off(e.eventTime),
          ...(p.internal ? [e.recordedAt, e.recordedBy] : []),
          place(e.locationId)?.name, place(e.locationId)?.kind, place(e.locationId)?.country, place(from)?.name, place(to)?.name,
          l.lotId, l.product, PRODUCTS[l.product], l.role === 'in' ? 'Input' : l.role === 'out' ? 'Output' : 'Moved', kg(l.qty),
          db.groups.find((g) => g.id === group)?.name, ship?.shipmentRef, ship?.exportDetails?.containerNo, ship?.exportDetails?.vessel, ship?.exportDetails?.eta,
          ship?.exportDetails?.clientName, ship?.exportDetails?.orderRef, com?.purchaseDate,
          ...(p.pii ? [com ? db.collectors.find((c) => c.id === com.collectorId)?.name : ''] : []),
          ...(p.prices ? [com?.pricePerKg, com ? com.currency : ''] : []),
          ...(p.internal ? [e.notes, (e.evidence ?? []).join(' | '), e.version, !!e.demo] : []),
        ]);
      }
    }
  });
  return { filename: `trace-${safe(trace.target.lotId)}-events-${stamp()}.csv`, headers, rows };
}

export function lineageCsv(trace: Trace, a: Analysis): Csv {
  const rows: Cell[][] = [];
  for (const e of trace.events) {
    if (e.type !== 'transform') continue;
    for (const i of e.inputs)
      for (const o of e.outputs)
        if (trace.lotSet.has(i.lotId) && trace.lotSet.has(o.lotId))
          rows.push([i.lotId, i.product, o.lotId, o.product, kg(i.qty), kg(o.qty), TRANSFORM_LABEL(e.kind), d(e.eventTime), a.places.get(e.locationId)?.name]);
  }
  return {
    filename: `trace-${safe(trace.target.lotId)}-lineage-${stamp()}.csv`,
    headers: ['Input lot', 'Input product', 'Output lot', 'Output product', 'Input quantity used (kg)', 'Output quantity (kg)', 'Transformation', 'Date', 'Place'],
    rows,
  };
}

// ── registers (scoped to what the viewer can see) ───────────────────────────
export function purchasesCsv(db: DemoDB, a: Analysis, p: Privacy, from?: string, to?: string): Csv {
  const rows = db.events
    .filter((e) => e.type === 'commission' && inRange(e, from, to))
    .map((e) => {
      if (e.type !== 'commission') return [];
      const o = e.outputs[0];
      const col = db.collectors.find((c) => c.id === e.collectorId);
      const area = db.collectionAreas.find((x) => x.id === e.locationId);
      return [
        o.lotId, area?.code, area?.name, area?.operationalArea, col?.code ?? e.collectorId, ...(p.pii ? [col?.name] : []), o.product, kg(o.qty), e.purchaseDate,
        d(e.eventTime), t(e.eventTime), ...(p.prices ? [e.pricePerKg, e.currency, e.pricePerKg ? kg(e.pricePerKg * o.qty) : ''] : []), lotStatus(a, o.lotId).label, e.recordedAt, !!e.demo,
      ];
    });
  return {
    filename: `purchases-register-${stamp()}.csv`,
    headers: ['Lot ID', 'Collection area code', 'Collection area', 'Operational area', 'Collector code', ...(p.pii ? ['Collector'] : []), 'Product', 'Quantity (kg)', 'Purchase date', 'Event date', 'Event time', ...(p.prices ? ['Price per kg', 'Currency', 'Amount'] : []), 'Status now', 'Recorded at (UTC)', 'Demo record'],
    rows,
  };
}

export function shipmentsCsv(db: DemoDB, a: Analysis, from?: string, to?: string): Csv {
  const name = (id: string) => a.places.get(id)?.name ?? id;
  const rows: Cell[][] = [];
  for (const s of db.events) {
    if (s.type !== 'ship' || !inRange(s, from, to)) continue;
    const r = db.events.find((x) => x.type === 'receive' && x.shipEventId === s.id);
    for (const i of s.items) {
      const got = r && r.type === 'receive' ? r.items.find((x) => x.lotId === i.lotId)?.qty : undefined;
      rows.push([
        s.shipmentRef, name(s.fromId), name(s.toId), i.lotId, i.product, kg(i.qty), d(s.eventTime), t(s.eventTime), off(s.eventTime),
        r ? d(r.eventTime) : '', r ? t(r.eventTime) : '', got === undefined ? '' : kg(got), r ? (r.type === 'receive' ? r.outcome : '') : 'in transit',
        r && r.type === 'receive' ? r.discrepancyNote : '', s.exportDetails?.containerNo, s.exportDetails?.vessel, s.exportDetails?.eta, s.exportDetails?.clientName, s.exportDetails?.orderRef, !!s.demo,
      ]);
    }
  }
  return {
    filename: `shipments-and-receipts-${stamp()}.csv`,
    headers: ['Shipment ref', 'From', 'To', 'Lot / batch', 'Product', 'Shipped (kg)', 'Shipped date', 'Shipped time', 'UTC offset', 'Received date', 'Received time', 'Received (kg)', 'Receipt outcome', 'Discrepancy', 'Container', 'Vessel', 'ETA', 'Client', 'Order ref', 'Demo record'],
    rows,
  };
}

export function transformationsCsv(db: DemoDB, a: Analysis, from?: string, to?: string): Csv {
  const rows: Cell[][] = [];
  for (const e of db.events) {
    if (e.type !== 'transform' || !inRange(e, from, to)) continue;
    const inKg = e.inputs.reduce((s, x) => s + x.qty, 0);
    const outKg = e.outputs.reduce((s, x) => s + x.qty, 0);
    rows.push([
      TRANSFORM_LABEL(e.kind), e.outputs.map((o) => o.lotId).join(' | '), a.places.get(e.locationId)?.name, db.groups.find((g) => g.id === e.groupId)?.name, d(e.eventTime), t(e.eventTime),
      e.inputs.length, kg(inKg), kg(outKg), e.kind === 'aggregation' ? '' : inKg ? Math.round((outKg / inKg) * 1000) / 10 : '', e.kind === 'aggregation' ? e.sfclStage : '', e.inputs.map((i) => `${i.lotId} (${kg(i.qty)})`).join(' | '), !!e.demo,
    ]);
  }
  return {
    filename: `transformations-${stamp()}.csv`,
    headers: ['Transformation', 'Output batch(es)', 'Place', 'Processing group', 'Date', 'Time', 'Input rows', 'Input (kg)', 'Output (kg)', 'Yield %', 'SFCL stage', 'Inputs (lot and kg)', 'Demo record'],
    rows,
  };
}

export function sfclCsv(db: DemoDB, a: Analysis): Csv {
  const rows: Cell[][] = [];
  for (const e of db.events) {
    if (e.type !== 'transform' || e.kind !== 'aggregation') continue;
    const id = e.outputs[0]?.lotId;
    const total = e.inputs.reduce((s, x) => s + x.qty, 0);
    const lot = a.lots.get(id);
    const after = lot?.children.map((c) => c.lotId) ?? [];
    const h = db.handoffs.find((x) => x.lotId === id || after.includes(x.lotId));
    rows.push([
      id, e.sfclStage === 'finalized' ? 'Finalized' : 'In progress', kg(total), kg(21000 - total), e.inputs.length, Math.max(0, ...e.inputs.map((i) => i.qty)), e.inputs.filter((i) => i.qty > 3000).length,
      e.inputs.map((i) => `${i.lotId} (${kg(i.qty)})`).join(' | '), d(e.eventTime), a.places.get(e.locationId)?.name, lotStatus(a, id).label, after.join(' | '), h?.clientName, h?.orderRef, !!e.demo,
    ]);
  }
  return {
    filename: `sfcl-summary-${stamp()}.csv`,
    headers: ['SFCL', 'Stage', 'Total (kg)', 'Remaining to 21,000 kg', 'LPO draws', 'Largest draw (kg)', 'Draws above 3,000 kg', 'LPO draws (lot and kg)', 'Aggregation date', 'Warehouse', 'Status now', 'Refined / filtered into', 'Client', 'Order ref', 'Demo record'],
    rows,
  };
}

export function stockCsv(a: Analysis, keep: (locationId: string) => boolean): Csv {
  const rows: Cell[][] = [];
  for (const [lotId, m] of a.stock)
    for (const [loc, q] of m) if (q > 0 && keep(loc)) rows.push([lotId, a.lots.get(lotId)?.product, a.lots.get(lotId)?.kind, a.places.get(loc)?.name, 'On hand', kg(q)]);
  for (const [lotId, m] of a.allocated) for (const [g, q] of m) if (q > 0) rows.push([lotId, a.lots.get(lotId)?.product, a.lots.get(lotId)?.kind, g, 'Issued to group', kg(q)]);
  for (const s of a.openShipments) if (keep(s.toId) || keep(s.fromId)) for (const i of s.items) rows.push([i.lotId, i.product, a.lots.get(i.lotId)?.kind, `${a.places.get(s.fromId)?.name} → ${a.places.get(s.toId)?.name}`, 'In transit', kg(i.qty)]);
  return { filename: `stock-position-${stamp()}.csv`, headers: ['Lot / batch', 'Product', 'Lot type', 'Place / group', 'State', 'Quantity (kg)'], rows };
}

export function findingsCsv(fs: Finding[], a: Analysis): Csv {
  return {
    filename: `validation-findings-${stamp()}.csv`,
    headers: ['Severity', 'Rule', 'Message', 'Lot', 'Event date', 'Place'],
    rows: fs.map((f) => {
      const e = f.eventId ? a.byId.get(f.eventId) : undefined;
      return [f.severity, RULES[f.rule], f.message, f.lotId, e ? d(e.eventTime) : '', e ? a.places.get(e.locationId)?.name : ''];
    }),
  };
}

export function auditCsv(db: DemoDB): Csv {
  return {
    filename: `audit-history-${stamp()}.csv`,
    headers: ['When (UTC)', 'Action', 'Summary', 'Reason', 'Actor role', 'Target'],
    rows: [...db.audit].sort((x, y) => x.at.localeCompare(y.at)).map((e) => [e.at, e.action, e.summary, e.reason, e.actor, e.targetId]),
  };
}

export function handoffsCsv(db: DemoDB, a: Analysis): Csv {
  return {
    filename: `commercial-handoffs-${stamp()}.csv`,
    headers: ['Product lot', 'Product', 'Quantity (kg)', 'Ready at', 'Client', 'Order ref', 'Status', 'Acknowledged at', 'Invoice ref (illustrative)', 'Invoice status', 'Customer view', 'Created (UTC)'],
    rows: db.handoffs.map((h) => [h.lotId, h.product, kg(h.qty), a.places.get(h.locationId)?.name, h.clientName, h.orderRef, h.status, h.acknowledgedAt, h.invoiceRef, h.invoiceStatus, h.disclosure, h.createdAt]),
  };
}
