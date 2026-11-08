import { AlertTriangle, ChevronDown, Combine, Droplet, FileSpreadsheet, FlaskConical, Funnel, Handshake, Inbox, Nut, Plus, ShieldCheck, ShoppingBasket, Truck, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BulkImport } from '../components/BulkImport';
import { Drawer, FindingList, MarkerGlyph, Meter } from '../components/ui';
import { eventKindsFor, type ImportKind } from '../domain/import/specs';
import type { DemoDB, LotQty, ReceiveEvent, TransformEvent } from '../data/types';
import { findingsFor, type Viewer } from '../domain/access';
import { SFCL_TARGET, heldAt, type Analysis } from '../domain/engine';
import { fmtDate, fmtEventTime, fmtKg, fmtRecorded } from '../domain/format';
import { describeEvent } from '../domain/describe';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { lotStatus, markerKind, type MarkerKind } from '../domain/trace';
import { CommissionForm, DeliverForm, IssueForm, ReceiveForm, ShipForm } from './forms/MovementForms';
import { AggregationForm, ReadyForm, TransformForm } from './forms/ProcessForms';

export type FormSpec =
  | { f: 'commission' }
  | { f: 'ship'; from?: string; items?: LotQty[]; fromChoices: string[]; toChoices: string[]; title: string }
  | { f: 'receive'; shipId?: string; locations: string[]; title: string }
  | { f: 'issue'; centre?: string }
  | { f: 'transform'; kind: 'kernel' | 'butter' | 'refine' | 'filter'; location?: string; group?: string; title: string }
  | { f: 'aggregate'; eventId?: string }
  | { f: 'ready' }
  | { f: 'deliver' }
  | { f: 'resolve'; eventId: string }
  | { f: 'bulk'; kind?: ImportKind };

/** The bulk upload that matches each single-entry form. */
const BULK_FOR: Partial<Record<FormSpec['f'], ImportKind>> = { commission: 'purchases', ship: 'shipments', receive: 'receipts', issue: 'issues', transform: 'processing', aggregate: 'aggregation', ready: 'ready', deliver: 'deliveries' };

interface Task {
  key: string;
  order: number;
  icon: ReactNode;
  title: ReactNode;
  facts: { label: string; value: ReactNode }[];
  status: { text: string; tone: 'wait' | 'bad' | 'info' | 'ok' };
  action: string;
  open: FormSpec;
}

const SEASON_START = '2026-07-01';
const placesOfKind = (a: Analysis, kinds: string[]) => [...a.places.values()].filter((p) => kinds.includes(p.kind)).map((p) => p.id);
const mine = (v: Viewer, a: Analysis, kinds: string[]) => [...v.locations].filter((id) => kinds.includes(a.places.get(id)?.kind ?? ''));
const sum = (xs: { qty: number }[]) => xs.reduce((s, x) => s + x.qty, 0);

export function tasksFor(v: Viewer, a: Analysis, db: DemoDB): Task[] {
  const name = (id: string) => a.places.get(id)?.name.replace(/^DEMO /, '') ?? id;
  const role = v.user.role;
  const can = ROLES[role].can;
  const t: Task[] = [];
  const inbound = (locs: string[]) => a.openShipments.filter((s) => locs.includes(s.toId));

  for (const d of db.events.filter((e): e is ReceiveEvent => e.type === 'receive' && e.outcome === 'discrepancy' && !e.discrepancyResolution && v.locations.has(e.locationId)))
    t.push({
      key: 'd' + d.id,
      order: 0,
      icon: <AlertTriangle size={19} />,
      title: `Resolve receipt discrepancy at ${name(d.locationId)}`,
      facts: [{ label: 'Note', value: d.discrepancyNote }],
      status: { text: 'Needs your decision', tone: 'bad' },
      action: 'Resolve',
      open: { f: 'resolve', eventId: d.id },
    });

  const allPhc = placesOfKind(a, ['phc']);
  const allBc = placesOfKind(a, ['butter-centre']);
  const allWh = placesOfKind(a, ['warehouse']);
  const allPort = placesOfKind(a, ['port']);

  if (role === 'nut-fo') {
    const cas = mine(v, a, ['collection-area']);
    const phc = mine(v, a, ['phc']);
    for (const s of inbound(phc))
      t.push({
        key: 'r' + s.id,
        order: 1,
        icon: <Inbox size={19} />,
        title: `Receive fresh nut at ${name(s.toId)}`,
        facts: [
          { label: 'From', value: name(s.fromId) },
          { label: 'Lots', value: s.items.length },
          { label: 'Qty', value: fmtKg(sum(s.items)) },
          { label: 'Left', value: fmtEventTime(s.eventTime) },
        ],
        status: { text: 'In transit', tone: 'info' },
        action: 'Receive',
        open: { f: 'receive', shipId: s.id, locations: phc, title: 'Receive at PHC' },
      });
    for (const ca of cas) {
      const held = heldAt(a, ca);
      if (held.length)
        t.push({
          key: 'ship' + ca,
          order: 2,
          icon: <Truck size={19} />,
          title: `Ship ${held.length} purchased lot${held.length > 1 ? 's' : ''} from ${name(ca)}`,
          facts: [
            { label: 'Qty', value: `${fmtKg(sum(held))} ${[...new Set(held.map((h) => h.product))].join('/')}` },
            { label: 'Oldest purchase', value: fmtDate(held[0].lot.createdAt) },
            { label: 'Goes to', value: held.some((h) => h.product === 'OFN') ? 'Post Harvest Centre' : 'Butter centre (ODK bypasses the PHC)' },
          ],
          status: { text: 'Awaiting shipment', tone: 'wait' },
          action: 'Ship',
          open: { f: 'ship', from: ca, items: held.map(({ lotId, product, qty }) => ({ lotId, product, qty })), fromChoices: [...cas, ...phc], toChoices: [...allPhc, ...allBc], title: 'Ship purchased lots' },
        });
    }
    for (const p of phc) {
      const ofn = heldAt(a, p, ['OFN']);
      if (ofn.length)
        t.push({
          key: 'k' + p,
          order: 3,
          icon: <Nut size={19} />,
          title: `Record OFN → ODK processing at ${name(p)}`,
          facts: [
            { label: 'Fresh nut on hand', value: fmtKg(sum(ofn)) },
            { label: 'Lots', value: ofn.length },
          ],
          status: { text: 'Awaiting processing', tone: 'wait' },
          action: 'Record output',
          open: { f: 'transform', kind: 'kernel', location: p, title: 'Transform OFN → ODK' },
        });
      const odk = heldAt(a, p, ['ODK']);
      if (odk.length)
        t.push({
          key: 'sp' + p,
          order: 4,
          icon: <Truck size={19} />,
          title: `Ship ${odk.length} ODK batch${odk.length > 1 ? 'es' : ''} from ${name(p)} to a butter centre`,
          facts: [{ label: 'Qty', value: fmtKg(sum(odk)) }],
          status: { text: 'Ready to ship', tone: 'wait' },
          action: 'Ship',
          open: { f: 'ship', from: p, fromChoices: [...cas, ...phc], toChoices: allBc, title: 'Ship ODK to butter centre' },
        });
    }
  }

  if (role === 'butter-fo') {
    const bcs = mine(v, a, ['butter-centre']);
    const whs = mine(v, a, ['warehouse']);
    const here = [...bcs, ...whs];
    for (const s of inbound(here))
      t.push({
        key: 'r' + s.id,
        order: 1,
        icon: <Inbox size={19} />,
        title: `Incoming consignment to ${name(s.toId)}`,
        facts: [
          { label: 'From', value: name(s.fromId) },
          { label: 'Lots', value: s.items.length },
          { label: 'Qty', value: `${fmtKg(sum(s.items))} ${[...new Set(s.items.map((i) => i.product))].join('/')}` },
          { label: 'Left', value: fmtEventTime(s.eventTime) },
        ],
        status: { text: 'Awaiting receipt', tone: 'info' },
        action: 'Receive or flag',
        open: { f: 'receive', shipId: s.id, locations: here, title: 'Receive consignment' },
      });
    for (const c of bcs) {
      const odk = heldAt(a, c, ['ODK']);
      if (odk.length)
        t.push({
          key: 'i' + c,
          order: 2,
          icon: <Users size={19} />,
          title: `Issue accepted ODK to a group at ${name(c)}`,
          facts: [
            { label: 'Available', value: fmtKg(sum(odk)) },
            { label: 'Lots', value: odk.length },
          ],
          status: { text: 'Accepted, not issued', tone: 'wait' },
          action: 'Issue',
          open: { f: 'issue', centre: c },
        });
      for (const g of db.groups.filter((g) => g.centreId === c)) {
        const issued = [...a.allocated].reduce((s, [, m]) => s + (m.get(g.id) ?? 0), 0);
        if (issued > 0)
          t.push({
            key: 'b' + g.id,
            order: 3,
            icon: <Droplet size={19} />,
            title: `${g.name} at ${name(c)} is processing`,
            facts: [{ label: 'Issued ODK', value: fmtKg(issued) }],
            status: { text: 'Awaiting LPO output', tone: 'wait' },
            action: 'Record LPO',
            open: { f: 'transform', kind: 'butter', location: c, group: g.id, title: 'Group processing ODK → OSB' },
          });
      }
      const osb = heldAt(a, c, ['OSB']);
      if (osb.length)
        t.push({
          key: 'so' + c,
          order: 4,
          icon: <Truck size={19} />,
          title: `Ship ${osb.length} LPO batch${osb.length > 1 ? 'es' : ''} from ${name(c)} to the warehouse`,
          facts: [
            { label: 'Qty', value: fmtKg(sum(osb)) },
            { label: 'LPOs', value: osb.map((o) => o.lotId).join(', ') },
          ],
          status: { text: 'Ready to ship', tone: 'wait' },
          action: 'Ship',
          open: { f: 'ship', from: c, fromChoices: here, toChoices: allWh, title: 'Ship OSB to warehouse' },
        });
    }
    if (can.aggregateSfcl)
      for (const w of whs) {
        for (const e of db.events.filter((e): e is TransformEvent => e.type === 'transform' && e.kind === 'aggregation' && e.sfclStage !== 'finalized' && e.locationId === w))
          t.push({
            key: 'ag' + e.id,
            order: 5,
            icon: <Combine size={19} />,
            title: `Continue ${e.outputs[0].lotId}`,
            facts: [
              { label: 'So far', value: `${fmtKg(e.outputs[0].qty)} of ${fmtKg(SFCL_TARGET)}` },
              { label: 'Still needed', value: fmtKg(SFCL_TARGET - e.outputs[0].qty) },
            ],
            status: { text: 'In progress', tone: 'wait' },
            action: 'Add LPO draws',
            open: { f: 'aggregate', eventId: e.id },
          });
        const sfcl = heldAt(a, w, ['OSB']).filter((l) => l.lot.kind === 'sfcl' && l.lot.sfclStage === 'finalized');
        if (sfcl.length)
          t.push({
            key: 'st' + w,
            order: 6,
            icon: <Truck size={19} />,
            title: `Dispatch ${sfcl.map((s) => s.lotId).join(', ')} to Tema`,
            facts: [{ label: 'Qty', value: fmtKg(sum(sfcl)) }],
            status: { text: 'Finalized', tone: 'ok' },
            action: 'Ship',
            open: { f: 'ship', from: w, fromChoices: whs, toChoices: allPort, title: 'Ship SFCL to Tema' },
          });
      }
  }

  if (role === 'supply-chain') {
    const here = [...v.locations];
    const onward = placesOfKind(a, ['port', 'terminal', 'destination-warehouse', 'refiner', 'filterer']);
    for (const s of inbound(here))
      t.push({
        key: 'r' + s.id,
        order: 1,
        icon: <Inbox size={19} />,
        title: `Receive ${s.items.map((i) => i.lotId).join(', ')} at ${name(s.toId)}`,
        facts: [
          { label: 'From', value: name(s.fromId) },
          { label: 'Qty', value: fmtKg(sum(s.items)) },
          { label: 'Left', value: fmtEventTime(s.eventTime) },
          ...(s.exportDetails?.eta ? [{ label: 'ETA', value: fmtDate(s.exportDetails.eta) }] : []),
        ],
        status: { text: 'In transit', tone: 'info' },
        action: 'Receive',
        open: { f: 'receive', shipId: s.id, locations: here, title: 'Receive export leg' },
      });
    for (const l of mine(v, a, ['refiner'])) {
      const osb = heldAt(a, l, ['OSB']);
      if (osb.length)
        t.push({
          key: 'rf' + l,
          order: 2,
          icon: <FlaskConical size={19} />,
          title: `Record refining at ${name(l)}`,
          facts: [{ label: 'Crude butter', value: `${fmtKg(sum(osb))} · ${osb.map((o) => o.lotId).join(', ')}` }],
          status: { text: 'Awaiting refining', tone: 'wait' },
          action: 'Record',
          open: { f: 'transform', kind: 'refine', location: l, title: 'Refining OSB → ORSB' },
        });
    }
    for (const l of mine(v, a, ['filterer'])) {
      const b = heldAt(a, l, ['OSB', 'ORSB']);
      if (b.length)
        t.push({
          key: 'fl' + l,
          order: 2,
          icon: <Funnel size={19} />,
          title: `Record filtering at ${name(l)}`,
          facts: [{ label: 'Butter', value: fmtKg(sum(b)) }],
          status: { text: 'Awaiting filtering', tone: 'wait' },
          action: 'Record',
          open: { f: 'transform', kind: 'filter', location: l, title: 'Filtering' },
        });
    }
    for (const l of mine(v, a, ['destination-warehouse', 'refiner', 'filterer'])) {
      for (const h of heldAt(a, l)) {
        if (db.handoffs.some((x) => x.lotId === h.lotId && x.locationId === l)) continue;
        if (a.places.get(l)?.kind === 'refiner' && h.product === 'OSB') continue;
        t.push({
          key: 'rd' + l + h.lotId,
          order: 3,
          icon: <ShieldCheck size={19} />,
          title: `Mark ${h.lotId} arrived and ready for pickup`,
          facts: [
            { label: 'At', value: name(l) },
            { label: 'Qty', value: `${fmtKg(h.qty)} ${h.product}` },
          ],
          status: { text: 'At destination', tone: 'ok' },
          action: 'Mark ready',
          open: { f: 'ready' },
        });
      }
    }
    for (const l of mine(v, a, ['port', 'terminal'])) {
      const held = heldAt(a, l);
      if (held.length)
        t.push({
          key: 'x' + l,
          order: 4,
          icon: <Truck size={19} />,
          title: `Ship ${held.map((h) => h.lotId).join(', ')} onward from ${name(l)}`,
          facts: [{ label: 'Qty', value: fmtKg(sum(held)) }],
          status: { text: 'Held at port', tone: 'wait' },
          action: 'Record leg',
          open: { f: 'ship', from: l, fromChoices: onward.filter((x) => v.locations.has(x)), toChoices: onward, title: 'Export leg' },
        });
    }
  }
  return t.sort((x, y) => x.order - y.order);
}

export function useWorkCount() {
  const { viewer, analysis, db } = useSession();
  return useMemo(() => tasksFor(viewer, analysis, db).length, [viewer, analysis, db]);
}

interface ActionDef {
  label: string;
  sub: string;
  icon: ReactNode;
  open: FormSpec;
}

function actionsFor(v: Viewer, a: Analysis): { primary: ActionDef | null; secondary: ActionDef[] } {
  const role = v.user.role;
  const all = (k: string[]) => placesOfKind(a, k);
  if (role === 'nut-fo')
    return {
      primary: { label: 'Record purchase', sub: 'OFN or ODK from a registered collector', icon: <ShoppingBasket size={18} />, open: { f: 'commission' } },
      secondary: [
        { label: 'Ship lots', sub: 'To the PHC (OFN) or a butter centre (ODK)', icon: <Truck size={18} />, open: { f: 'ship', fromChoices: mine(v, a, ['collection-area', 'phc']), toChoices: all(['phc', 'butter-centre']), title: 'Ship lots' } },
        { label: 'Receive at PHC', sub: 'Confirm fresh-nut arrival', icon: <Inbox size={18} />, open: { f: 'receive', locations: mine(v, a, ['phc']), title: 'Receive at PHC' } },
        { label: 'Record OFN → ODK', sub: 'PHC drying run and output batch', icon: <Nut size={18} />, open: { f: 'transform', kind: 'kernel', title: 'Transform OFN → ODK' } },
      ],
    };
  if (role === 'butter-fo') {
    const here = mine(v, a, ['butter-centre', 'warehouse']);
    const hasWh = mine(v, a, ['warehouse']).length > 0;
    return {
      primary: { label: 'Receive consignment', sub: 'Accept or flag a discrepancy', icon: <Inbox size={18} />, open: { f: 'receive', locations: here, title: 'Receive consignment' } },
      secondary: [
        { label: 'Issue ODK to a group', sub: 'Allocate accepted kernel', icon: <Users size={18} />, open: { f: 'issue' } },
        { label: 'Record group processing', sub: 'ODK → OSB with LPO number', icon: <Droplet size={18} />, open: { f: 'transform', kind: 'butter', title: 'Group processing ODK → OSB' } },
        { label: 'Ship', sub: hasWh ? 'LPOs to warehouse, SFCL to Tema' : 'LPOs to the warehouse', icon: <Truck size={18} />, open: { f: 'ship', fromChoices: here, toChoices: hasWh ? all(['warehouse', 'port']) : all(['warehouse']), title: 'Ship' } },
        ...(hasWh ? [{ label: 'SFCL aggregation', sub: 'LPO inputs → one SFCL output', icon: <Combine size={18} />, open: { f: 'aggregate' } as FormSpec }] : []),
      ],
    };
  }
  if (role === 'supply-chain')
    return {
      primary: { label: 'Mark arrived & ready for pickup', sub: 'Creates the trace link, QR and Commercial handoff', icon: <ShieldCheck size={18} />, open: { f: 'ready' } },
      secondary: [
        { label: 'Receive export leg', sub: 'Tema, Amsterdam, destination', icon: <Inbox size={18} />, open: { f: 'receive', locations: [...v.locations], title: 'Receive export leg' } },
        { label: 'Record export movement', sub: 'Container, vessel, ETA, client', icon: <Truck size={18} />, open: { f: 'ship', fromChoices: mine(v, a, ['port', 'terminal', 'destination-warehouse', 'refiner', 'filterer']), toChoices: all(['terminal', 'destination-warehouse', 'refiner', 'filterer']), title: 'Export movement' } },
        { label: 'Refining', sub: 'OSB → ORSB', icon: <FlaskConical size={18} />, open: { f: 'transform', kind: 'refine', title: 'Refining' } },
        { label: 'Filtering', sub: 'OSB → OFSB / OFSB-FFL', icon: <Funnel size={18} />, open: { f: 'transform', kind: 'filter', title: 'Filtering' } },
        { label: 'Deliver to client', sub: 'Direct-to-client hand-over', icon: <Handshake size={18} />, open: { f: 'deliver' } },
      ],
    };
  return { primary: null, secondary: [] };
}

export function Home() {
  const { viewer, analysis, db, resolveDiscrepancy, user } = useSession();
  const [form, setForm] = useState<FormSpec | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const tasks = useMemo(() => tasksFor(viewer, analysis, db), [viewer, analysis, db]);
  const { primary, secondary } = actionsFor(viewer, analysis);
  const exceptions = useMemo(() => findingsFor(viewer, analysis).filter((f) => f.severity !== 'info'), [viewer, analysis]);
  const close = () => setForm(null);
  const all = (k: string[]) => placesOfKind(analysis, k);
  const myLocs = [...viewer.locations];

  const bulkKinds = eventKindsFor(user.role);
  const bulkFor = form ? BULK_FOR[form.f] : undefined;
  const formTitle = (s: FormSpec) =>
    s.f === 'bulk' ? 'Bulk upload' : s.f === 'commission' ? 'Record purchase' : s.f === 'issue' ? 'Issue ODK to processing group' : s.f === 'aggregate' ? 'SFCL aggregation' : s.f === 'ready' ? 'Arrived and ready for pickup' : s.f === 'deliver' ? 'Deliver to client' : s.f === 'resolve' ? 'Resolve discrepancy' : s.title;
  const formKind: MarkerKind = form
    ? form.f === 'commission'
      ? 'purchase'
      : form.f === 'aggregate'
        ? 'aggregate'
        : form.f === 'ready'
          ? 'ready'
          : form.f === 'issue'
            ? 'issue'
            : form.f === 'receive'
              ? 'receive'
              : form.f === 'deliver'
                ? 'delivery'
                : form.f === 'transform'
                  ? form.kind === 'kernel'
                    ? 'kernel'
                    : form.kind === 'butter'
                      ? 'butter'
                      : form.kind
                  : 'ship'
    : 'ship';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My work</h1>
          <p>
            {ROLES[user.role].label} · {myLocs.map((id) => analysis.places.get(id)?.name.replace(/^DEMO /, '')).join(', ')}
          </p>
        </div>
        {primary && (
          <div className="actions">
            {bulkKinds.length > 0 && (
              <button className="btn btn-lg" onClick={() => setForm({ f: 'bulk' })} title="Upload many entries at once from a CSV or Excel file">
                <FileSpreadsheet size={16} /> Bulk upload
              </button>
            )}
            <OtherActions actions={secondary} onPick={setForm} />
            <button className="btn btn-primary" onClick={() => setForm(primary.open)}>
              {primary.icon} {primary.label}
            </button>
          </div>
        )}
      </header>

      <div className="home-grid">
        <section className="stack">
          <div className="panel">
            <div className="panel-head">
              <h2>Queue</h2>
              <span className="meta">{tasks.length ? `${tasks.length} open · most urgent first` : 'Nothing open'}</span>
            </div>
            {tasks.length === 0 ? (
              <p className="empty">Nothing is waiting. Incoming consignments and stock that needs action appear here.</p>
            ) : (
              <table className="table worklist">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>Status</th>
                    <th>Task</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.key}>
                      <td className="c-status">
                        <span className={`status ${t.status.tone}`}>{t.status.text}</span>
                      </td>
                      <td>
                        <span className="task-title">{t.title}</span>
                        <span className="task-facts">
                          {t.facts.map((f, i) => (
                            <span key={f.label}>
                              {i > 0 && ' · '}
                              {f.label} <b>{f.value}</b>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="actions">
                        <button className="btn btn-sm" onClick={() => setForm(t.open)}>
                          {t.action}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <RecentEntries />
        </section>
        <aside>
          <RoleContext />
          <div className="ctx-card">
            <h3>Exceptions</h3>
            <FindingList findings={exceptions.slice(0, 4)} empty={<p className="small muted">No exceptions on your entries or locations.</p>} />
            {exceptions.length > 4 && <p className="tiny muted" style={{ marginTop: 6 }}>+ {exceptions.length - 4} more</p>}
          </div>
        </aside>
      </div>

      {form && (
        <Drawer title={formTitle(form)} subtitle={`${ROLES[user.role].label} · ${myLocs.length} assigned location${myLocs.length === 1 ? '' : 's'}`} onClose={close} icon={<MarkerGlyph kind={formKind} size={30} />}>
          {bulkFor && bulkKinds.includes(bulkFor) && (
            <p className="small" style={{ marginBottom: 12 }}>
              Many to record?{' '}
              <button className="link-btn" onClick={() => setForm({ f: 'bulk', kind: bulkFor })}>
                Upload a CSV or Excel file instead
              </button>
            </p>
          )}
          {form.f === 'bulk' && <BulkImport kinds={bulkKinds} initial={form.kind} onDone={close} />}
          {form.f === 'commission' && <CommissionForm areas={mine(viewer, analysis, ['collection-area'])} onDone={close} />}
          {form.f === 'ship' && <ShipForm fromChoices={form.fromChoices} toChoices={form.toChoices} presetFrom={form.from} presetItems={form.items} onDone={close} />}
          {form.f === 'receive' && <ReceiveForm locations={form.locations} presetShipId={form.shipId} onDone={close} />}
          {form.f === 'issue' && <IssueForm centres={mine(viewer, analysis, ['butter-centre'])} presetCentre={form.centre} onDone={close} />}
          {form.f === 'transform' && (
            <TransformForm
              kind={form.kind}
              locations={(form.kind === 'kernel' ? all(['phc']) : form.kind === 'butter' ? all(['butter-centre']) : all(['refiner', 'filterer'])).filter((id) => viewer.locations.has(id))}
              presetLocation={form.location}
              presetGroup={form.group}
              onDone={close}
            />
          )}
          {form.f === 'aggregate' && <AggregationForm warehouses={mine(viewer, analysis, ['warehouse'])} presetEventId={form.eventId} onDone={close} />}
          {form.f === 'ready' && <ReadyForm locations={myLocs} onDone={close} />}
          {form.f === 'deliver' && <DeliverForm fromChoices={mine(viewer, analysis, ['terminal', 'destination-warehouse', 'refiner', 'filterer'])} onDone={close} />}
          {form.f === 'resolve' && (
            <div className="card card-pad stack-sm" style={{ maxWidth: 560 }}>
              <p>Record how the discrepancy was settled. The original receipt stays unchanged; the resolution is added to its history.</p>
              <textarea rows={3} value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="e.g. Re-weighed with the driver present; shortage confirmed on the waybill." />
              <div>
                <button
                  className="btn btn-primary"
                  disabled={!resolveNote.trim()}
                  onClick={async () => {
                    await resolveDiscrepancy(form.eventId, resolveNote.trim());
                    setResolveNote('');
                    close();
                  }}
                >
                  Record resolution
                </button>
              </div>
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}

/** The user's own most recent entries (own-entry visibility). */
function RecentEntries() {
  const { db, analysis, user } = useSession();
  const mineEv = db.events.filter((e) => e.actorId === user.id).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 6);
  if (!mineEv.length) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Your recent entries</h2>
        <span className="meta">Event time · recorded time</span>
      </div>
      <div className="table-wrap">
        <table className="table recent">
          <tbody>
            {mineEv.map((e) => (
              <tr key={e.id}>
                <td style={{ width: 28 }}>
                  <MarkerGlyph kind={markerKind(e, analysis.places)} size={20} />
                </td>
                <td>
                  {describeEvent(e, analysis, db)}
                  {e.demo && <span className="demo-badge">DEMO</span>}
                </td>
                <td className="small nowrap">{fmtEventTime(e.eventTime)}</td>
                <td className="tiny muted nowrap">{fmtRecorded(e.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OtherActions({ actions, onPick }: { actions: ActionDef[]; onPick: (f: FormSpec) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (!actions.length) return null;
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-lg" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <Plus size={16} /> Record another event <ChevronDown size={15} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(a.open);
              }}
            >
              <span style={{ color: 'var(--forest-2)', marginTop: 2 }}>{a.icon}</span>
              <span>
                <b>{a.label}</b>
                <small>{a.sub}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Role-specific context: only facts about the user's own scope. */
function RoleContext() {
  const { viewer, analysis, db } = useSession();
  const role = viewer.user.role;
  const name = (id: string) => analysis.places.get(id)?.name.replace(/^DEMO /, '') ?? id;

  if (role === 'nut-fo') {
    const cas = mine(viewer, analysis, ['collection-area']);
    const purchases = db.events.filter((e) => e.type === 'commission' && cas.includes(e.locationId));
    const season = purchases.filter((e) => e.eventTime >= SEASON_START);
    const last30 = purchases.filter((e) => Date.now() - new Date(e.eventTime).getTime() < 30 * 86400_000);
    const kg = (es: typeof purchases) => es.reduce((s, e) => s + (e.type === 'commission' ? e.outputs[0].qty : 0), 0);
    const awaiting = cas.flatMap((c) => heldAt(analysis, c));
    return (
      <div className="ctx-card">
        <h3>Your areas</h3>
        <div className="kv-row">
          <span>Assigned</span>
          <span className="v">{[...viewer.locations].map(name).join(', ')}</span>
        </div>
        <div className="kv-row">
          <span>Purchases this season</span>
          <span className="v">
            {season.length} · {fmtKg(kg(season))}
          </span>
        </div>
        <div className="kv-row">
          <span>Last 30 days</span>
          <span className="v">
            {last30.length} · {fmtKg(kg(last30))}
          </span>
        </div>
        <div className="kv-row">
          <span>Lots awaiting shipment</span>
          <span className="v">{awaiting.length}</span>
        </div>
      </div>
    );
  }
  if (role === 'butter-fo') {
    const bcs = mine(viewer, analysis, ['butter-centre']);
    const whs = mine(viewer, analysis, ['warehouse']);
    const odk = bcs.flatMap((c) => heldAt(analysis, c, ['ODK']));
    const groups = db.groups.filter((g) => bcs.includes(g.centreId));
    const issued = groups.reduce((s, g) => s + [...analysis.allocated].reduce((t, [, m]) => t + (m.get(g.id) ?? 0), 0), 0);
    const lpos = db.events.filter((e) => e.type === 'transform' && e.kind === 'butter' && bcs.includes(e.locationId) && e.eventTime >= SEASON_START);
    const inProg = db.events.filter((e): e is TransformEvent => e.type === 'transform' && e.kind === 'aggregation' && e.sfclStage !== 'finalized' && whs.includes(e.locationId));
    const lpoBal = whs.flatMap((w) => heldAt(analysis, w, ['OSB']).filter((l) => l.lot.kind === 'lpo'));
    return (
      <>
        <div className="ctx-card">
          <h3>Your centre{bcs.length > 1 ? 's' : ''}</h3>
          <div className="kv-row">
            <span>Assigned</span>
            <span className="v">{[...viewer.locations].map(name).join(', ')}</span>
          </div>
          <div className="kv-row">
            <span>Accepted ODK not issued</span>
            <span className="v">{fmtKg(odk.reduce((s, x) => s + x.qty, 0))}</span>
          </div>
          <div className="kv-row">
            <span>Issued to {groups.length} groups</span>
            <span className="v">{fmtKg(issued)}</span>
          </div>
          <div className="kv-row">
            <span>LPOs this season</span>
            <span className="v">{lpos.length}</span>
          </div>
        </div>
        {whs.length > 0 && (
          <div className="ctx-card">
            <h3>Warehouse · SFCL</h3>
            {inProg.map((e) => (
              <div key={e.id} style={{ marginBottom: 10 }}>
                <div className="row-between small">
                  <b className="id">{e.outputs[0].lotId}</b>
                  <span>
                    {fmtKg(e.outputs[0].qty)} / {fmtKg(SFCL_TARGET)}
                  </span>
                </div>
                <Meter value={e.outputs[0].qty} max={SFCL_TARGET} />
              </div>
            ))}
            <div className="kv-row">
              <span>LPO balances available</span>
              <span className="v">
                {lpoBal.length} · {fmtKg(lpoBal.reduce((s, x) => s + x.qty, 0))}
              </span>
            </div>
          </div>
        )}
      </>
    );
  }
  if (role === 'supply-chain') {
    // SFCL / product lots with movements in the user's route scope
    const lots = new Map<string, string>();
    for (const e of db.events) if ((e.type === 'ship' || e.type === 'receive') && (viewer.locations.has(e.locationId) || (e.type === 'ship' && viewer.locations.has(e.toId)))) for (const i of e.items) lots.set(i.lotId, e.id);
    // SFCLs moving through the user's route. In Amsterdam each is refined or filtered, then made ready.
    const sfcls = [...lots.keys()].filter((l) => analysis.lots.get(l)?.kind === 'sfcl');
    const route = ['Warehouse', 'Tema', 'Amsterdam', 'Refined / filtered', 'Ready'];
    return (
      <div className="ctx-card">
        <h3>Export batches in your scope</h3>
        {sfcls.length === 0 && <p className="small muted">No SFCL is on its way to your locations.</p>}
        {sfcls.map((lot) => {
          const evs = analysis.sorted.filter((e) => 'items' in e && e.items.some((i) => i.lotId === lot));
          const reached = (k: string[]) => evs.some((e) => e.type === 'receive' && k.includes(analysis.places.get(e.locationId)?.kind ?? ''));
          const products = analysis.lots.get(lot)?.children.map((c) => c.lotId) ?? [];
          const processed = products.length > 0;
          const readyH = db.handoffs.find((h) => h.lotId === lot || products.includes(h.lotId));
          const done = [true, reached(['port']), reached(['terminal']), processed, !!readyH];
          const now = done.lastIndexOf(true);
          return (
            <div key={lot} style={{ padding: '10px 0', borderTop: '1px solid var(--rule)' }}>
              <div className="row-between">
                <a className="id" href={`#/trace/${encodeURIComponent(lot)}`}>
                  {lot}
                </a>
                <span className="tiny muted">{processed ? `→ ${products.join(', ')}` : lotStatus(analysis, lot).label}</span>
              </div>
              <div className="route-steps" style={{ marginTop: 6 }}>
                {route.map((r, i) => (
                  <span key={r} className="row" style={{ gap: 4 }}>
                    {i > 0 && <span className="arr">›</span>}
                    <span className={`st ${i === now ? 'now' : done[i] ? 'done' : ''}`}>{r}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return null;
}
