// ─────────────────────────────────────────────────────────────────────────────
//  DEMO SEED SCENARIO — every name, identifier, quantity, timestamp, client,
//  invoice reference and certificate here is fictional and illustrative.
//
//  Story (2026–27 season):
//   • Fresh nuts (OFN) bought in DEMO Kulaa → PHC → two ODK batches.
//   • Dried kernel (ODK) bought in DEMO Sabon and DEMO Tingbaa → straight to
//     butter centres (bypassing the PHC).
//   • ODK issued to four centre groups → seven LPO crude-butter batches.
//   • LPOs → warehouse → SFCL 26901 (21,000 kg, finalized) and SFCL 26902
//     (in progress, using LPO remaining balances).
//   • SFCL 26901 → Tema → Amsterdam terminal → refiner (in Amsterdam a shipment is
//     either refined or filtered) → ORSB 26901-R1 → ready for pickup (Commercial
//     handoff; the customer sees the full trace).
//   • One intentional review warning: LPO-90411 contributes 3,660 kg, above the
//     usual 3,000 kg norm, to close the shortfall left by LPO-90417.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEMO_COLLECTION_AREAS,
  DEMO_COLLECTORS,
  DEMO_GROUPS,
  DEMO_LOCATIONS,
  DEMO_ROUTES,
} from './geography';
import { DEMO_INVITATIONS, DEMO_USERS, demoActorFor } from './users';
import type {
  AuditEntry,
  CommissionEvent,
  DemoDB,
  DemoDocument,
  ExportDetails,
  Handoff,
  LotQty,
  ProductCode,
  ReceiveEvent,
  RoleId,
  ShipEvent,
  TraceEvent,
  TransformEvent,
} from './types';

export const SCHEMA_VERSION = 5;
export const DEMO_TRACE_LOT = 'ORSB 26901-R1';
export const DEMO_HANDOFF_TOKEN = 'demo-sfcl26901-k7q2';

const T = (date: string, time: string, tz = '+00:00') => `${date}T${time}:00${tz}`;
const mmddyy = (d: string) => d.slice(5, 7) + d.slice(8, 10) + d.slice(2, 4);
const later = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();

export function buildSeed(): DemoDB {
  let n = 0;
  const nextId = (p: string) => `${p}-${String(++n).padStart(4, '0')}`;
  const events: TraceEvent[] = [];

  const collectorByCode = new Map(DEMO_COLLECTORS.map((c) => [c.code, c]));

  // ── Purchases (Commission) ────────────────────────────────────────────────
  const times1 = ['07:42', '08:16', '08:53', '09:27', '10:05', '10:41'];
  const times2 = ['07:55', '08:31', '09:04', '09:46', '10:12', '10:58'];

  function purchase(caCode: string, caId: string, nums: string[], date: string, product: ProductCode, qtys: number[], times: string[]) {
    return nums.map((num, i) => {
      const col = collectorByCode.get(`${caCode}-${num}`)!;
      const lotId = `${col.code}-${mmddyy(date)}`;
      const eventTime = T(date, times[i]);
      const ev: CommissionEvent = {
        id: nextId('ev'),
        type: 'commission',
        eventTime,
        recordedAt: later(eventTime, 9),
        recordedBy: 'nut-fo',
        locationId: caId,
        collectorId: col.id,
        purchaseDate: date,
        pricePerKg: product === 'OFN' ? 1.85 : 5.4,
        currency: 'GHS',
        outputs: [{ lotId, product, qty: qtys[i] }],
        evidence: [`Purchase receipt book DEMO-PR-${mmddyy(date)}-${num} (illustrative)`],
        demo: true,
        version: 1,
      };
      events.push(ev);
      return ev;
    });
  }

  const nums1 = ['001', '002', '003', '004', '005', '006'];
  const nums2 = ['011', '012', '013', '014', '015', '016'];
  const nums3 = ['021', '022', '023', '024', '025', '026'];

  const kulaaD1 = purchase('DX01-CA9101', 'ca-kulaa', nums1, '2026-07-14', 'OFN', [2150, 2420, 1760, 2580, 1890, 2230], times1);
  const kulaaD2 = purchase('DX01-CA9101', 'ca-kulaa', nums1, '2026-07-21', 'OFN', [1980, 2260, 2040, 2310, 2120, 2060], times2);
  const sabonD1 = purchase('DX02-CA9204', 'ca-sabon', nums2, '2026-07-18', 'ODK', [2310, 2180, 2460, 2050, 2390, 2240], times1);
  const sabonD2 = purchase('DX02-CA9204', 'ca-sabon', nums2, '2026-08-01', 'ODK', [2280, 2350, 2120, 2410, 2190, 2430], times2);
  const tingD1 = purchase('DX03-CA9307', 'ca-tingbaa', nums3, '2026-07-24', 'ODK', [2240, 2410, 2180, 2350, 2290, 2330], times1);
  const tingD2 = purchase('DX03-CA9307', 'ca-tingbaa', nums3, '2026-08-07', 'ODK', [2300, 2260, 2420, 2150, 2370, 2300], times2);

  const lotsOf = (evs: CommissionEvent[]): LotQty[] => evs.map((e) => ({ ...e.outputs[0] }));

  // ── Movements ─────────────────────────────────────────────────────────────
  function ship(fromId: string, toId: string, items: LotQty[], eventTime: string, by: RoleId, extra: Partial<ShipEvent> = {}): ShipEvent {
    const ev: ShipEvent = {
      id: nextId('ev'),
      type: 'ship',
      eventTime,
      recordedAt: later(eventTime, 4),
      recordedBy: by,
      locationId: fromId,
      fromId,
      toId,
      items: items.map((i) => ({ ...i })),
      evidence: [`Waybill DEMO-WB-${eventTime.slice(5, 10).replace('-', '')}-${String(n).slice(-2)} (illustrative)`],
      demo: true,
      version: 1,
      ...extra,
    };
    events.push(ev);
    return ev;
  }
  function receive(s: ShipEvent, eventTime: string, by: RoleId, extra: Partial<ReceiveEvent> = {}): ReceiveEvent {
    const ev: ReceiveEvent = {
      id: nextId('ev'),
      type: 'receive',
      eventTime,
      recordedAt: later(eventTime, 3),
      recordedBy: by,
      locationId: s.toId,
      shipEventId: s.id,
      fromId: s.fromId,
      items: s.items.map((i) => ({ ...i })),
      outcome: 'accepted',
      evidence: [`Weighbridge ticket DEMO-WT-${eventTime.slice(5, 10).replace('-', '')} (illustrative)`],
      demo: true,
      version: 1,
      ...extra,
    };
    events.push(ev);
    return ev;
  }
  function transform(locationId: string, kind: TransformEvent['kind'], inputs: LotQty[], outputs: LotQty[], eventTime: string, by: RoleId, extra: Partial<TransformEvent> = {}) {
    const ev: TransformEvent = {
      id: nextId('ev'),
      type: 'transform',
      kind,
      eventTime,
      recordedAt: later(eventTime, 3),
      recordedBy: by,
      locationId,
      inputs,
      outputs,
      demo: true,
      version: 1,
      ...extra,
    };
    events.push(ev);
    return ev;
  }

  // Fresh nut route: Kulaa → PHC
  const s1 = ship('ca-kulaa', 'phc-nayiri', lotsOf(kulaaD1), T('2026-07-15', '10:10'), 'nut-fo');
  const r1 = receive(s1, T('2026-07-15', '15:30'), 'nut-fo', { version: 2 }); // corrected time, see audit
  const s2 = ship('ca-kulaa', 'phc-nayiri', lotsOf(kulaaD2), T('2026-07-22', '09:45'), 'nut-fo');
  receive(s2, T('2026-07-22', '14:20'), 'nut-fo');

  // Purchased dried kernel: straight to butter centres
  const s3 = ship('ca-sabon', 'bc-tamba', lotsOf(sabonD1), T('2026-07-19', '07:30'), 'nut-fo');
  receive(s3, T('2026-07-19', '12:50'), 'butter-fo');
  const s4 = ship('ca-tingbaa', 'bc-kalbe', lotsOf(tingD1), T('2026-07-25', '07:40'), 'nut-fo');
  receive(s4, T('2026-07-25', '13:10'), 'butter-fo');

  // PHC transformations OFN → ODK (batch IDs use the PHC's own account prefix)
  transform('phc-nayiri', 'kernel', lotsOf(kulaaD1), [{ lotId: 'DX01-CA9150-B001-073026', product: 'ODK', qty: 4340 }], T('2026-07-30', '16:30'), 'nut-fo', {
    evidence: ['Drying log DEMO-DL-B001 (illustrative)'],
  });

  const s5 = ship('ca-sabon', 'bc-tamba', lotsOf(sabonD2), T('2026-08-02', '07:15'), 'nut-fo');
  receive(s5, T('2026-08-02', '12:40'), 'butter-fo');
  const s6 = ship('phc-nayiri', 'bc-tamba', [{ lotId: 'DX01-CA9150-B001-073026', product: 'ODK', qty: 4340 }], T('2026-08-03', '08:20'), 'nut-fo');
  receive(s6, T('2026-08-03', '14:45'), 'butter-fo');

  transform('phc-nayiri', 'kernel', lotsOf(kulaaD2), [{ lotId: 'DX01-CA9150-B002-080626', product: 'ODK', qty: 4250 }], T('2026-08-06', '15:50'), 'nut-fo', {
    evidence: ['Drying log DEMO-DL-B002 (illustrative)'],
  });

  const s7 = ship('ca-tingbaa', 'bc-kalbe', lotsOf(tingD2), T('2026-08-08', '07:20'), 'nut-fo');
  receive(s7, T('2026-08-08', '12:55'), 'butter-fo');
  const s8 = ship('phc-nayiri', 'bc-tamba', [{ lotId: 'DX01-CA9150-B002-080626', product: 'ODK', qty: 4250 }], T('2026-08-10', '08:05'), 'nut-fo');
  receive(s8, T('2026-08-10', '13:30'), 'butter-fo');

  // ── Butter centres: issue to groups, ODK → OSB (LPO) ──────────────────────
  type PoolItem = LotQty & { remaining: number };
  const pool = (lots: LotQty[]): PoolItem[] => lots.map((l) => ({ ...l, remaining: l.qty }));
  const pools: Record<string, PoolItem[]> = {
    'bc-tamba': [
      ...pool(lotsOf(sabonD1)),
      ...pool(lotsOf(sabonD2)),
      ...pool([{ lotId: 'DX01-CA9150-B001-073026', product: 'ODK', qty: 4340 }]),
      ...pool([{ lotId: 'DX01-CA9150-B002-080626', product: 'ODK', qty: 4250 }]),
    ],
    'bc-kalbe': [...pool(lotsOf(tingD1)), ...pool(lotsOf(tingD2))],
  };
  function take(centre: string, qty: number): LotQty[] {
    const out: LotQty[] = [];
    let need = qty;
    for (const p of pools[centre]) {
      if (need <= 0) break;
      if (p.remaining <= 0) continue;
      const q = Math.min(p.remaining, need);
      p.remaining -= q;
      need -= q;
      out.push({ lotId: p.lotId, product: 'ODK', qty: q });
    }
    if (need > 0) throw new Error(`Seed plan short at ${centre}`);
    return out;
  }

  const lpoPlan = [
    { lpo: 'LPO-90411', centre: 'bc-kalbe', group: 'grp-kalbe-a', odk: 11200, out: 4400, issue: T('2026-08-09', '07:20'), tf: T('2026-08-11', '16:05') },
    { lpo: 'LPO-90412', centre: 'bc-tamba', group: 'grp-tamba-a', odk: 10800, out: 4200, issue: T('2026-08-10', '07:30'), tf: T('2026-08-12', '16:00') },
    { lpo: 'LPO-90413', centre: 'bc-tamba', group: 'grp-tamba-b', odk: 9300, out: 3600, issue: T('2026-08-11', '07:35'), tf: T('2026-08-14', '16:10') },
    { lpo: 'LPO-90414', centre: 'bc-kalbe', group: 'grp-kalbe-c', odk: 7800, out: 3000, issue: T('2026-08-13', '07:30'), tf: T('2026-08-16', '15:45') },
    { lpo: 'LPO-90415', centre: 'bc-kalbe', group: 'grp-kalbe-a', odk: 8600, out: 3300, issue: T('2026-08-18', '07:25'), tf: T('2026-08-20', '16:15') },
    { lpo: 'LPO-90416', centre: 'bc-tamba', group: 'grp-tamba-a', odk: 9000, out: 3500, issue: T('2026-08-20', '07:30'), tf: T('2026-08-24', '15:40') },
    { lpo: 'LPO-90417', centre: 'bc-tamba', group: 'grp-tamba-b', odk: 6500, out: 2340, issue: T('2026-08-22', '07:45'), tf: T('2026-08-26', '16:20') },
  ];
  const lpoQty = new Map<string, number>();
  for (const p of lpoPlan) {
    const items = take(p.centre, p.odk);
    events.push({
      id: nextId('ev'),
      type: 'issue',
      eventTime: p.issue,
      recordedAt: later(p.issue, 2),
      recordedBy: 'butter-fo',
      locationId: p.centre,
      groupId: p.group,
      items,
      evidence: [`Group issue sheet DEMO-IS-${p.lpo.slice(4)} (illustrative)`],
      demo: true,
      version: 1,
    });
    transform(p.centre, 'butter', items.map((i) => ({ ...i })), [{ lotId: p.lpo, product: 'OSB', qty: p.out }], p.tf, 'butter-fo', {
      groupId: p.group,
      evidence: [`Butter production card ${p.lpo} (illustrative)`],
    });
    lpoQty.set(p.lpo, p.out);
  }
  const lpo = (id: string): LotQty => ({ lotId: id, product: 'OSB', qty: lpoQty.get(id)! });

  // ── LPOs to the warehouse ─────────────────────────────────────────────────
  const w1 = ship('bc-kalbe', 'wh-central', [lpo('LPO-90411')], T('2026-08-14', '06:50'), 'butter-fo');
  receive(w1, T('2026-08-14', '15:20'), 'butter-fo');
  const w2 = ship('bc-tamba', 'wh-central', [lpo('LPO-90412'), lpo('LPO-90413')], T('2026-08-17', '06:30'), 'butter-fo');
  receive(w2, T('2026-08-17', '13:40'), 'butter-fo');
  const w3 = ship('bc-kalbe', 'wh-central', [lpo('LPO-90414'), lpo('LPO-90415')], T('2026-08-22', '06:40'), 'butter-fo');
  receive(w3, T('2026-08-22', '14:50'), 'butter-fo');
  const w4 = ship('bc-tamba', 'wh-central', [lpo('LPO-90416'), lpo('LPO-90417')], T('2026-08-28', '06:30'), 'butter-fo');
  receive(w4, T('2026-08-28', '13:20'), 'butter-fo');

  // ── SFCL aggregation (Transform: LPO inputs → one SFCL output) ────────────
  const draw = (id: string, qty: number): LotQty => ({ lotId: id, product: 'OSB', qty });
  transform(
    'wh-central',
    'aggregation',
    [
      draw('LPO-90411', 3660),
      draw('LPO-90412', 3000),
      draw('LPO-90413', 3000),
      draw('LPO-90414', 3000),
      draw('LPO-90415', 3000),
      draw('LPO-90416', 3000),
      draw('LPO-90417', 2340),
    ],
    [{ lotId: 'SFCL 26901', product: 'OSB', qty: 21000 }],
    T('2026-09-14', '10:30'),
    'butter-fo',
    {
      sfclStage: 'finalized',
      notes: 'LPO-90411 draw of 3,660 kg closes the 660 kg shortfall left by LPO-90417 (2,340 kg total output).',
      evidence: ['Aggregation sheet DEMO-AG-26901 (illustrative)'],
    },
  );
  transform('wh-central', 'aggregation', [draw('LPO-90412', 1200), draw('LPO-90411', 740)], [{ lotId: 'SFCL 26902', product: 'OSB', qty: 1940 }], T('2026-09-21', '11:15'), 'butter-fo', {
    sfclStage: 'in-progress',
    notes: 'Started from LPO remaining balances; more LPOs needed to reach 21,000 kg.',
  });

  // ── Export journey for SFCL 26901 ─────────────────────────────────────────
  const sf = (qty: number): LotQty => ({ lotId: 'SFCL 26901', product: 'OSB', qty });
  const container = 'DMOU 482913 0';
  const x1 = ship('wh-central', 'port-tema', [sf(21000)], T('2026-09-23', '05:30'), 'butter-fo', {
    shipmentRef: 'DEMO-TRK-260923',
    exportDetails: { containerNo: container },
  });
  receive(x1, T('2026-09-24', '13:45'), 'supply-chain', { evidence: ['Port gate-in slip DEMO-GI-0924 (illustrative)'] });
  const exportToNl: ExportDetails = { containerNo: container, vessel: 'MV Demo Harmattan', eta: '2026-10-26' };
  const x2 = ship('port-tema', 'nl-terminal', [sf(21000)], T('2026-10-03', '18:00'), 'supply-chain', {
    shipmentRef: 'DEMO-BL-26-0917',
    exportDetails: exportToNl,
    evidence: ['Bill of lading DEMO-BL-26-0917 (illustrative)'],
  });
  receive(x2, T('2026-10-28', '09:40', '+01:00'), 'supply-chain', { evidence: ['Terminal discharge report DEMO-TD-1028 (illustrative)'] });
  // In Amsterdam a shipment is either refined or filtered (Supply Chain). SFCL 26901 goes to the refiner.
  const x3 = ship('nl-terminal', 'nl-zaan', [sf(21000)], T('2026-10-30', '08:00', '+01:00'), 'supply-chain', {
    shipmentRef: 'DEMO-NL-TRK-1030A',
    exportDetails: { clientName: 'DEMO Lumière Naturals B.V.', orderRef: 'DEMO-PO-4471' },
  });
  receive(x3, T('2026-10-30', '11:05', '+01:00'), 'supply-chain');
  transform('nl-zaan', 'refine', [sf(21000)], [{ lotId: 'ORSB 26901-R1', product: 'ORSB', qty: 20160 }], T('2026-11-01', '16:00', '+01:00'), 'supply-chain', {
    evidence: ['Refinery batch report DEMO-ZR-0117 (illustrative)'],
  });

  const readyTime = T('2026-11-03', '10:00', '+01:00');
  const readyId = nextId('ev');
  events.push({
    id: readyId,
    type: 'ready',
    eventTime: readyTime,
    recordedAt: later(readyTime, 0.25),
    recordedBy: 'supply-chain',
    locationId: 'nl-zaan',
    items: [{ lotId: 'ORSB 26901-R1', product: 'ORSB', qty: 20160 }],
    handoffId: 'ho-0001',
    evidence: ['Refinery release note DEMO-RN-1103 (illustrative)'],
    demo: true,
    version: 1,
  });

  // ── Open work so each role has something to do ────────────────────────────
  const pend1 = purchase('DX03-CA9307', 'ca-tingbaa', ['021', '024'], '2026-11-05', 'ODK', [1180, 1240], ['08:20', '09:05']);
  ship('ca-tingbaa', 'bc-kalbe', lotsOf(pend1), T('2026-11-06', '07:35'), 'nut-fo', { shipmentRef: 'DEMO-TRK-261106' });
  purchase('DX02-CA9204', 'ca-sabon', ['015'], '2026-11-06', 'ODK', [980], ['08:40']);

  // ── Commercial handoff, documents, audit history ──────────────────────────
  const handoffs: Handoff[] = [
    {
      id: 'ho-0001',
      lotId: 'ORSB 26901-R1',
      qty: 20160,
      product: 'ORSB',
      locationId: 'nl-zaan',
      readyEventId: readyId,
      token: DEMO_HANDOFF_TOKEN,
      clientName: 'DEMO Lumière Naturals B.V.',
      orderRef: 'DEMO-PO-4471',
      createdAt: later(readyTime, 0.25),
      status: 'new',
      invoiceStatus: 'not-started',
      disclosure: 'full',
      demo: true,
    },
  ];

  const documents: DemoDocument[] = [
    { id: 'doc-organic', title: 'DEMO Organic certificate (illustrative only — not a real certificate)', kind: 'certificate', appliesTo: '*', public: true, demo: true },
    { id: 'doc-coa-26901', title: 'DEMO Certificate of analysis, SFCL 26901 (illustrative)', kind: 'analysis', appliesTo: ['SFCL 26901', 'ORSB 26901-R1'], public: true, demo: true },
    { id: 'doc-bl-26901', title: 'DEMO Bill of lading DEMO-BL-26-0917 (internal)', kind: 'shipping', appliesTo: ['SFCL 26901'], public: false, demo: true },
    { id: 'doc-refine', title: 'DEMO Refinery batch report DEMO-ZR-0117 (illustrative)', kind: 'analysis', appliesTo: ['ORSB 26901-R1'], public: true, demo: true },
  ];

  const seededAt = new Date().toISOString();
  const audit: AuditEntry[] = [
    {
      id: 'au-0001',
      at: '2026-07-16T09:12:00.000Z',
      actor: 'it-admin',
      actorId: 'u-admin',
      action: 'event.corrected',
      targetId: r1.id,
      summary: `Receive at DEMO Nayiri PHC: event time corrected 15:00 → 15:30 (version 1 → 2)`,
      reason: 'Weighbridge ticket DEMO-WT-0715 shows arrival at 15:30; officer had entered the planned time.',
      before: { eventTime: T('2026-07-15', '15:00') },
      after: { eventTime: T('2026-07-15', '15:30') },
      demo: true,
    },
    {
      id: 'au-0002',
      at: later(readyTime, 0.25),
      actor: 'supply-chain',
      actorId: 'u-supply',
      action: 'handoff.created',
      targetId: 'ho-0001',
      summary: 'ORSB 26901-R1 (20,160 kg, refined from SFCL 26901) marked Arrived and ready for pickup at DEMO Zaan Refining. Trace link and Commercial handoff created.',
      demo: true,
    },
    {
      id: 'au-0003',
      at: seededAt,
      actor: 'system',
      action: 'demo.reset',
      summary: 'Demo data seeded in this browser (fictional sample scenario).',
    },
  ];

  // who recorded each event (by role + location) — drives own-entry visibility
  for (const e of events) e.actorId = demoActorFor(e.recordedBy, e.locationId);

  return {
    schemaVersion: SCHEMA_VERSION,
    seededAt,
    locations: structuredClone(DEMO_LOCATIONS),
    collectionAreas: structuredClone(DEMO_COLLECTION_AREAS),
    collectors: structuredClone(DEMO_COLLECTORS),
    groups: structuredClone(DEMO_GROUPS),
    routes: structuredClone(DEMO_ROUTES),
    events,
    handoffs,
    documents,
    audit,
    users: structuredClone(DEMO_USERS),
    invitations: structuredClone(DEMO_INVITATIONS),
  };
}
