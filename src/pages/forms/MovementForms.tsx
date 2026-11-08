import { useMemo, useState } from 'react';
import { Field } from '../../components/ui';
import type { CommissionEvent, DeliverEvent, ExportDetails, IssueEvent, LotQty, ProductCode, ReceiveEvent, ShipEvent } from '../../data/types';
import { heldAt } from '../../domain/engine';
import { fmtEventTime, fmtKg, mmddyy, toEventIso } from '../../domain/format';
import { useStore } from '../../domain/store';
import { EventTime, FormShell, LinesEditor, base, toLines, useIdem, type LineDraft } from './kit';

const EXPORT_KINDS = new Set(['warehouse', 'port', 'terminal', 'destination-warehouse', 'refiner', 'filterer']);

/* ── Purchase / Commission ──────────────────────────────────────────────── */
export function CommissionForm({ areas, onDone }: { areas: string[]; onDone: () => void }) {
  const { db, role, recordEvent } = useStore();
  const idem = useIdem();
  const [caId, setCa] = useState('');
  const [colId, setCol] = useState('');
  const [product, setProduct] = useState<ProductCode>('OFN');
  const [qty, setQty] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [time, setTime] = useState('');
  const [offset, setOffset] = useState('+00:00');
  const [price, setPrice] = useState('');
  const [lotId, setLotId] = useState('');
  const [evidence, setEvidence] = useState('');

  const col = db.collectors.find((c) => c.id === colId);
  const expected = col && purchaseDate ? `${col.code}-${mmddyy(purchaseDate)}` : '';
  const missing = [
    !caId && 'Collection area',
    !colId && 'Collector',
    !qty && 'Quantity (kg)',
    !purchaseDate && 'Purchase date',
    !time && 'Event time',
    !lotId.trim() && 'Lot ID (supplied by the officer)',
  ].filter(Boolean) as string[];

  const draft: CommissionEvent | null = missing.length
    ? null
    : {
        ...base('commission', caId, toEventIso(time, offset), role, idem),
        collectorId: colId,
        purchaseDate,
        pricePerKg: price ? parseFloat(price) : undefined,
        currency: 'GHS',
        outputs: [{ lotId: lotId.trim(), product, qty: parseFloat(qty) }],
        evidence: evidence ? [evidence] : [],
      };

  return (
    <FormShell
      intro="One commission record per collector per purchase date. Purchases on different dates are separate lots. The lot ID is the officer's identifier and is saved exactly as typed."
      draft={draft}
      missing={missing}
      submitLabel="Record purchase"
      onSubmit={async () => { if (draft && (await recordEvent(draft, `Purchase recorded: ${draft.outputs[0].lotId} (${fmtKg(draft.outputs[0].qty)} ${product})`)).ok) onDone(); }}
    >
      <div className="card card-pad form-grid">
        <Field label="Collection area">
          <select
            value={caId}
            onChange={(e) => {
              setCa(e.target.value);
              setCol('');
            }}
          >
            <option value="">Select…</option>
            {db.collectionAreas.filter((a) => areas.includes(a.id)).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Collector" hint="registered on the master list">
          <select value={colId} onChange={(e) => setCol(e.target.value)} disabled={!caId}>
            <option value="">{caId ? 'Select…' : 'Choose an area first'}</option>
            {db.collectors
              .filter((c) => c.collectionAreaId === caId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Product">
          <select value={product} onChange={(e) => setProduct(e.target.value as ProductCode)}>
            <option value="OFN">OFN · Organic Shea Fresh Nuts (goes to a PHC)</option>
            <option value="ODK">ODK · Organic Shea Dried Kernel (bypasses the PHC)</option>
          </select>
        </Field>
        <Field label="Quantity" hint="kg">
          <input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Purchase date">
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </Field>
        <Field label="Price" hint="GHS per kg (demo)">
          <input type="number" min={0} step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="time of the purchase" />
        <Field
          label="Lot ID"
          hint={
            expected ? (
              <>
                expected pattern <code>{expected}</code>{' '}
                {lotId !== expected && (
                  <button type="button" className="link-btn" onClick={() => setLotId(expected)}>
                    use it
                  </button>
                )}
              </>
            ) : (
              'collector code + purchase date MMDDYY'
            )
          }
          span={2}
        >
          <input value={lotId} onChange={(e) => setLotId(e.target.value)} placeholder="e.g. DX01-CA9101-004-110726" className="mono" />
        </Field>
        <Field label="Evidence reference" hint="optional" span={2}>
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Purchase receipt book page, photo reference…" />
        </Field>
      </div>
    </FormShell>
  );
}

/* ── Ship ───────────────────────────────────────────────────────────────── */
export function ShipForm({ fromChoices, toChoices, presetFrom, presetItems, onDone }: { fromChoices: string[]; toChoices: string[]; presetFrom?: string; presetItems?: LotQty[]; onDone: () => void }) {
  const { db, analysis, role, recordEvent } = useStore();
  const idem = useIdem();
  const [from, setFrom] = useState(presetFrom ?? '');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(presetItems?.map((i) => ({ lotId: i.lotId, qty: String(i.qty) })) ?? []);
  const [time, setTime] = useState('');
  const fromPlace = analysis.places.get(from);
  const [offset, setOffset] = useState(fromPlace && fromPlace.lat > 30 ? '+01:00' : '+00:00');
  const [ref, setRef] = useState('');
  const [exp, setExp] = useState<ExportDetails>({});
  const available = useMemo(() => (from ? heldAt(analysis, from) : []), [analysis, from]);
  const isExport = !!fromPlace && EXPORT_KINDS.has(fromPlace.kind);
  const name = (id: string) => analysis.places.get(id)?.name ?? id;

  const routeHint = useMemo(() => {
    for (const r of db.routes) {
      const i = r.stops.indexOf(from);
      if (i >= 0 && i < r.stops.length - 1) return { route: r, next: r.stops[i + 1] };
    }
    return null;
  }, [db.routes, from]);

  const items = toLines(lines, (id) => analysis.lots.get(id)?.product);
  const missing = [!from && 'Ship from', !to && 'Ship to', !items.length && 'At least one lot', items.some((i) => !(i.qty > 0)) && 'A quantity for every line', !time && 'Event time'].filter(Boolean) as string[];
  const draft: ShipEvent | null = missing.length
    ? null
    : {
        ...base('ship', from, toEventIso(time, offset), role, idem),
        fromId: from,
        toId: to,
        items,
        shipmentRef: ref || undefined,
        exportDetails: isExport && Object.values(exp).some(Boolean) ? exp : undefined,
      };

  return (
    <FormShell
      intro="A shipment moves lots between locations; it never changes the lot IDs. The destination records its own receipt."
      draft={draft}
      missing={missing}
      submitLabel="Record shipment"
      onSubmit={async () => { if (draft && (await recordEvent(draft, `Shipment recorded: ${items.length} lot(s), ${name(from)} → ${name(to)}`)).ok) onDone(); }}
    >
      <div className="card card-pad form-grid">
        <Field label="Ship from" hint="where the lots are held now">
          <select
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setLines([]);
              const p = analysis.places.get(e.target.value);
              setOffset(p && p.lat > 30 ? '+01:00' : '+00:00');
            }}
          >
            <option value="">Select…</option>
            {fromChoices.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Ship to"
          hint={
            routeHint && to !== routeHint.next ? (
              <>
                planned next stop: {name(routeHint.next)}{' '}
                <button type="button" className="link-btn" onClick={() => setTo(routeHint.next)}>
                  use
                </button>
              </>
            ) : undefined
          }
        >
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Select…</option>
            {toChoices
              .filter((id) => id !== from)
              .map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Shipment / waybill reference" hint="optional">
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="when it left" />
      </div>
      {isExport && (
        <div className="card card-pad">
          <h4 style={{ marginBottom: 10 }}>Export details (Supply Chain)</h4>
          <div className="form-grid">
            <Field label="Container no.">
              <input value={exp.containerNo ?? ''} onChange={(e) => setExp({ ...exp, containerNo: e.target.value })} />
            </Field>
            <Field label="Vessel">
              <input value={exp.vessel ?? ''} onChange={(e) => setExp({ ...exp, vessel: e.target.value })} />
            </Field>
            <Field label="ETA">
              <input type="date" value={exp.eta ?? ''} onChange={(e) => setExp({ ...exp, eta: e.target.value })} />
            </Field>
            <Field label="Client" hint="fictional">
              <input value={exp.clientName ?? ''} onChange={(e) => setExp({ ...exp, clientName: e.target.value })} />
            </Field>
            <Field label="Client order reference">
              <input value={exp.orderRef ?? ''} onChange={(e) => setExp({ ...exp, orderRef: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
      <LinesEditor title="Lots on this shipment" lines={lines} setLines={setLines} available={available} />
    </FormShell>
  );
}

/* ── Receive (accept or flag discrepancy) ───────────────────────────────── */
export function ReceiveForm({ locations, presetShipId, onDone }: { locations: string[]; presetShipId?: string; onDone: () => void }) {
  const { analysis, role, recordEvent } = useStore();
  const idem = useIdem();
  const open = analysis.openShipments.filter((s) => locations.includes(s.toId));
  const [shipId, setShipId] = useState(presetShipId ?? (open.length === 1 ? open[0].id : ''));
  const ship = open.find((s) => s.id === shipId);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<'accepted' | 'discrepancy'>('accepted');
  const [note, setNote] = useState('');
  const [time, setTime] = useState('');
  const dest = ship ? analysis.places.get(ship.toId) : undefined;
  const [offset, setOffset] = useState('+00:00');
  const name = (id: string) => analysis.places.get(id)?.name ?? id;
  const q = (lotId: string, def: number) => qtys[lotId] ?? String(def);

  const missing = [!ship && 'Choose an incoming consignment', !time && 'Event time', outcome === 'discrepancy' && !note.trim() && 'Describe the discrepancy'].filter(Boolean) as string[];
  const draft: ReceiveEvent | null =
    missing.length || !ship
      ? null
      : {
          ...base('receive', ship.toId, toEventIso(time, offset), role, idem),
          shipEventId: ship.id,
          fromId: ship.fromId,
          items: ship.items.map((i) => ({ ...i, qty: parseFloat(q(i.lotId, i.qty)) })),
          outcome,
          discrepancyNote: outcome === 'discrepancy' ? note : undefined,
        };

  return (
    <FormShell
      intro="Check the consignment against the shipment. Accept it, or flag a discrepancy — accepted quantity becomes available for issue or processing at this location."
      draft={draft}
      missing={missing}
      submitLabel={outcome === 'accepted' ? 'Record receipt' : 'Record receipt with discrepancy'}
      onSubmit={async () => { if (draft && (await recordEvent(draft, `Receipt recorded at ${name(draft.locationId)}${outcome === 'discrepancy' ? ' (discrepancy flagged)' : ''}`)).ok) onDone(); }}
    >
      <div className="card">
        <div className="card-head">
          <h3>Incoming consignments</h3>
          <span className="chip chip-info">{open.length}</span>
        </div>
        <div className="card-body stack-sm">
          {open.length === 0 && <div className="muted">Nothing is in transit to your locations.</div>}
          {open.map((s) => (
            <label key={s.id} className="task" style={{ cursor: 'pointer', borderColor: s.id === shipId ? 'var(--forest-2)' : undefined }}>
              <input
                type="radio"
                name="ship"
                checked={s.id === shipId}
                onChange={() => {
                  setShipId(s.id);
                  setQtys({});
                  const p = analysis.places.get(s.toId);
                  setOffset(p && p.lat > 30 ? '+01:00' : '+00:00');
                }}
              />
              <div className="body">
                <div className="title">
                  {name(s.fromId)} → {name(s.toId)}
                </div>
                <div className="small muted">
                  {s.items.length} lot(s) · {fmtKg(s.items.reduce((t, i) => t + i.qty, 0))} · shipped {fmtEventTime(s.eventTime)}
                  {s.shipmentRef ? ` · ${s.shipmentRef}` : ''}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>
      {ship && (
        <>
          <div className="lines">
            <div className="lines-head">
              <span>Weighed on arrival at {dest?.name}</span>
              <span className="tiny muted">pre-filled with shipped kg — confirm or change</span>
            </div>
            {ship.items.map((i) => (
              <div key={i.lotId} className="line-row">
                <span className="id">
                  {i.lotId} <span className="muted tiny">shipped {fmtKg(i.qty)}</span>
                </span>
                <input type="number" min={0} step="any" value={q(i.lotId, i.qty)} onChange={(e) => setQtys({ ...qtys, [i.lotId]: e.target.value })} aria-label={`Received kg for ${i.lotId}`} />
                <span />
              </div>
            ))}
          </div>
          <div className="card card-pad form-grid">
            <Field label="Outcome">
              <select value={outcome} onChange={(e) => setOutcome(e.target.value as 'accepted' | 'discrepancy')}>
                <option value="accepted">Accept consignment</option>
                <option value="discrepancy">Flag a discrepancy</option>
              </select>
            </Field>
            {outcome === 'discrepancy' && (
              <Field label="Discrepancy note" span={2}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 bags short; moisture high on one bag" />
              </Field>
            )}
            <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="when it arrived" />
          </div>
        </>
      )}
    </FormShell>
  );
}

/* ── Issue ODK to a processing group ────────────────────────────────────── */
export function IssueForm({ centres, presetCentre, onDone }: { centres: string[]; presetCentre?: string; onDone: () => void }) {
  const { db, analysis, role, recordEvent } = useStore();
  const idem = useIdem();
  const [centre, setCentre] = useState(presetCentre ?? (centres.length === 1 ? centres[0] : ''));
  const [groupId, setGroup] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [time, setTime] = useState('');
  const [offset, setOffset] = useState('+00:00');
  const available = useMemo(() => (centre ? heldAt(analysis, centre, ['ODK']) : []), [analysis, centre]);
  const items = toLines(lines, (id) => analysis.lots.get(id)?.product);
  const missing = [!centre && 'Butter centre', !groupId && 'Processing group', !items.length && 'At least one ODK lot', items.some((i) => !(i.qty > 0)) && 'A quantity for every line', !time && 'Event time'].filter(Boolean) as string[];
  const draft: IssueEvent | null = missing.length ? null : { ...base('issue', centre, toEventIso(time, offset), role, idem), groupId, items };
  const group = db.groups.find((g) => g.id === groupId);

  return (
    <FormShell
      intro="Allocate accepted dried kernel to a named centre group. Only issued kernel can be used in that group's processing."
      draft={draft}
      missing={missing}
      submitLabel="Issue to group"
      onSubmit={async () => { if (draft && (await recordEvent(draft, `Issued ${fmtKg(items.reduce((s, i) => s + i.qty, 0))} ODK to ${group?.name}`)).ok) onDone(); }}
    >
      <div className="card card-pad form-grid">
        <Field label="Butter centre">
          <select
            value={centre}
            onChange={(e) => {
              setCentre(e.target.value);
              setGroup('');
              setLines([]);
            }}
          >
            <option value="">Select…</option>
            {centres.map((id) => (
              <option key={id} value={id}>
                {analysis.places.get(id)?.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Processing group">
          <select value={groupId} onChange={(e) => setGroup(e.target.value)} disabled={!centre}>
            <option value="">Select…</option>
            {db.groups
              .filter((g) => g.centreId === centre)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · {g.members} members (demo)
                </option>
              ))}
          </select>
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="when the kernel was handed to the group" />
      </div>
      <LinesEditor title="ODK issued" lines={lines} setLines={setLines} available={available} />
    </FormShell>
  );
}

/* ── Deliver direct to a client ─────────────────────────────────────────── */
export function DeliverForm({ fromChoices, onDone }: { fromChoices: string[]; onDone: () => void }) {
  const { db, analysis, role, recordEvent } = useStore();
  const idem = useIdem();
  const clients = db.locations.filter((l) => l.kind === 'client');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(clients.length === 1 ? clients[0].id : '');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [time, setTime] = useState('');
  const [offset, setOffset] = useState('+01:00');
  const available = useMemo(() => (from ? heldAt(analysis, from) : []), [analysis, from]);
  const items = toLines(lines, (id) => analysis.lots.get(id)?.product);
  const missing = [!from && 'Deliver from', !to && 'Client', !items.length && 'At least one lot', items.some((i) => !(i.qty > 0)) && 'A quantity for every line', !time && 'Event time'].filter(Boolean) as string[];
  const draft: DeliverEvent | null = missing.length ? null : { ...base('deliver', from, toEventIso(time, offset), role, idem), toId: to, items };
  return (
    <FormShell
      intro="Record a direct hand-over to the client (for example crude butter that bypasses refining)."
      draft={draft}
      missing={missing}
      submitLabel="Record delivery"
      onSubmit={async () => { if (draft && (await recordEvent(draft, `Delivery recorded to ${analysis.places.get(to)?.name}`)).ok) onDone(); }}
    >
      <div className="card card-pad form-grid">
        <Field label="Deliver from">
          <select
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setLines([]);
            }}
          >
            <option value="">Select…</option>
            {fromChoices.map((id) => (
              <option key={id} value={id}>
                {analysis.places.get(id)?.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Client location">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Select…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} />
      </div>
      <LinesEditor title="Delivered" lines={lines} setLines={setLines} available={available} />
    </FormShell>
  );
}
