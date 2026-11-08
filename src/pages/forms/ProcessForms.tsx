import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TraceLinkPanel } from '../../components/QrCode';
import { Field, Meter } from '../../components/ui';
import type { Handoff, LotQty, ProductCode, ReadyEvent, TraceEvent, TransformEvent, TransformKind } from '../../data/types';
import { DRAW_NORM, SFCL_TARGET, YIELD_BANDS, heldAt, issuedTo, transformRule, validateDraft } from '../../domain/engine';
import { fmtKg, mmddyy, pct, toEventIso, uid } from '../../domain/format';
import { useStore } from '../../domain/store';
import { eventLines } from '../../domain/trace';
import { EventTime, FormShell, LinesEditor, base, toLines, useIdem, type LineDraft } from './kit';

/* ── Transform (OFN→ODK, ODK→OSB, refine, filter) ───────────────────────── */
export function TransformForm({ kind, locations, presetLocation, presetGroup, onDone }: { kind: Exclude<TransformKind, 'aggregation'>; locations: string[]; presetLocation?: string; presetGroup?: string; onDone: () => void }) {
  const { db, analysis, role, recordEvent } = useStore();
  const idem = useIdem();
  const rule = transformRule(kind);
  const locs = locations.filter((id) => rule.at.includes(analysis.places.get(id)?.kind as never));
  const [loc, setLoc] = useState(presetLocation ?? (locs.length === 1 ? locs[0] : ''));
  const [groupId, setGroup] = useState(presetGroup ?? '');
  const [inputs, setInputs] = useState<LineDraft[]>([]);
  const [outputs, setOutputs] = useState<{ lotId: string; product: ProductCode; qty: string }[]>([{ lotId: '', product: rule.out[0], qty: '' }]);
  const [time, setTime] = useState('');
  const place = analysis.places.get(loc);
  const [offset, setOffset] = useState(place && place.lat > 30 ? '+01:00' : '+00:00');
  const available = useMemo(() => (kind === 'butter' ? (groupId ? issuedTo(analysis, groupId) : []) : loc ? heldAt(analysis, loc, rule.in) : []), [analysis, kind, groupId, loc, rule.in]);
  const ins = toLines(inputs, (id) => analysis.lots.get(id)?.product);
  const outs: LotQty[] = outputs.filter((o) => o.lotId.trim()).map((o) => ({ lotId: o.lotId.trim(), product: o.product, qty: parseFloat(o.qty) }));
  const inSum = ins.reduce((s, i) => s + (i.qty || 0), 0);
  const outSum = outs.reduce((s, i) => s + (i.qty || 0), 0);
  const band = YIELD_BANDS[kind];
  const loc0 = db.locations.find((l) => l.id === loc);
  const datePart = time ? time.slice(0, 10) : '';
  const idHint =
    kind === 'kernel'
      ? `PHC account + batch no. + processing date, e.g. ${loc0?.accountCode ?? 'DX01-CA9150'}-B003-${datePart ? mmddyy(datePart) : 'MMDDYY'}`
      : kind === 'butter'
        ? 'LPO number assigned by the Butter Field Officer, e.g. LPO-90418'
        : 'New ID for the refined/filtered product, e.g. ORSB 26901-R2';

  const missing = [
    !loc && 'Location',
    kind === 'butter' && !groupId && 'Processing group',
    !ins.length && 'At least one Input row',
    ins.some((i) => !(i.qty > 0)) && 'A quantity for every input',
    !outs.length && 'At least one Output row with its batch ID',
    outs.some((o) => !(o.qty > 0)) && 'A quantity for every output',
    !time && 'Event time',
  ].filter(Boolean) as string[];
  const draft: TransformEvent | null = missing.length ? null : { ...base('transform', loc, toEventIso(time, offset), role, idem), kind, groupId: kind === 'butter' ? groupId : undefined, inputs: ins, outputs: outs };

  return (
    <FormShell
      intro={`Record a ${rule.label} transformation. Input rows are consumed; Output rows are new batches whose IDs you supply. One input can be split across several runs, and several inputs can merge into one output.`}
      draft={draft}
      missing={missing}
      submitLabel="Record transformation"
      onSubmit={async () => { if (draft && (await recordEvent(draft, `${rule.label} recorded: ${outs.map((o) => o.lotId).join(', ')}`)).ok) onDone(); }}
      preview={
        inSum > 0 && outSum > 0 ? (
          <div className="review-box">
            Yield <b>{pct(outSum, inSum)}</b> ({fmtKg(outSum)} from {fmtKg(inSum)}){band && <span className="muted"> · proposed band {band[0] * 100}–{band[1] * 100}%</span>}
          </div>
        ) : undefined
      }
    >
      <div className="card card-pad form-grid">
        <Field label="Location">
          <select
            value={loc}
            onChange={(e) => {
              setLoc(e.target.value);
              setGroup('');
              setInputs([]);
            }}
          >
            <option value="">Select…</option>
            {locs.map((id) => (
              <option key={id} value={id}>
                {analysis.places.get(id)?.name}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'butter' && (
          <Field label="Processing group" hint="inputs come from kernel issued to this group">
            <select
              value={groupId}
              onChange={(e) => {
                setGroup(e.target.value);
                setInputs([]);
              }}
              disabled={!loc}
            >
              <option value="">Select…</option>
              {db.groups
                .filter((g) => g.centreId === loc)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.members} members (demo)
                  </option>
                ))}
            </select>
          </Field>
        )}
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="when the output batch came out" />
      </div>
      <LinesEditor title={`Input rows (${rule.in.join('/')}) — consumed`} lines={inputs} setLines={setInputs} available={available} />
      <div className="lines">
        <div className="lines-head">
          <span>
            Output rows ({rule.out.join('/')}) — created · {fmtKg(outSum)}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setOutputs([...outputs, { lotId: '', product: rule.out[0], qty: '' }])}>
            <Plus size={13} /> Output
          </button>
        </div>
        {outputs.map((o, i) => (
          <div key={i} className="line-row wide">
            <input className="mono" value={o.lotId} placeholder="Output batch ID (typed by officer)" onChange={(e) => setOutputs(outputs.map((x, j) => (j === i ? { ...x, lotId: e.target.value } : x)))} />
            <select value={o.product} onChange={(e) => setOutputs(outputs.map((x, j) => (j === i ? { ...x, product: e.target.value as ProductCode } : x)))}>
              {rule.out.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <input type="number" min={0} step="any" placeholder="kg" value={o.qty} onChange={(e) => setOutputs(outputs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <button type="button" className="icon-btn" onClick={() => setOutputs(outputs.filter((_, j) => j !== i))} aria-label="Remove output">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="tiny muted" style={{ padding: '6px 12px' }}>
          {idHint}. Saved exactly as typed.
        </div>
      </div>
    </FormShell>
  );
}

/* ── SFCL aggregation (Transform: LPO inputs → one SFCL output) ─────────── */
export function AggregationForm({ warehouses, presetEventId, onDone }: { warehouses: string[]; presetEventId?: string; onDone: () => void }) {
  const { db, analysis, role, recordEvent, updateAggregation, toast } = useStore();
  const idem = useIdem();
  const inProgress = db.events.filter((e): e is TransformEvent => e.type === 'transform' && e.kind === 'aggregation' && e.sfclStage !== 'finalized');
  const [target, setTarget] = useState<string>(presetEventId ?? 'new');
  const existing = inProgress.find((e) => e.id === target);
  const wh = existing?.locationId ?? warehouses[0];
  const [sfclId, setSfclId] = useState('');
  const [draws, setDraws] = useState<Record<string, string>>(() => Object.fromEntries((existing?.inputs ?? []).map((i) => [i.lotId, String(i.qty)])));
  const [time, setTime] = useState('');
  const [offset, setOffset] = useState('+00:00');

  const lpos = useMemo(() => {
    const held = heldAt(analysis, wh, ['OSB']).filter((l) => l.lot.kind === 'lpo');
    const map = new Map(held.map((h) => [h.lotId, { lotId: h.lotId, produced: h.lot.createdQty, available: h.qty }]));
    for (const i of existing?.inputs ?? []) {
      const lot = analysis.lots.get(i.lotId);
      const m = map.get(i.lotId);
      if (m) m.available += i.qty;
      else if (lot) map.set(i.lotId, { lotId: i.lotId, produced: lot.createdQty, available: i.qty });
    }
    return [...map.values()].sort((a, b) => a.lotId.localeCompare(b.lotId));
  }, [analysis, wh, existing]);

  const inputs: LotQty[] = Object.entries(draws)
    .filter(([, v]) => v !== '' && parseFloat(v) !== 0)
    .map(([lotId, v]) => ({ lotId, product: 'OSB' as ProductCode, qty: parseFloat(v) }));
  const total = inputs.reduce((s, i) => s + (i.qty || 0), 0);
  const outId = existing ? existing.outputs[0].lotId : sfclId.trim();
  const missing = [!existing && !sfclId.trim() && 'SFCL number (supplied at the warehouse)', !inputs.length && 'At least one LPO draw', !time && (existing ? 'Event time of this update' : 'Event time')].filter(Boolean) as string[];

  const make = (stage: 'in-progress' | 'finalized'): TransformEvent | null => {
    if (missing.length) return null;
    const outputs: LotQty[] = [{ lotId: outId, product: 'OSB', qty: total }];
    if (existing) return { ...existing, eventTime: toEventIso(time, offset), inputs, outputs, sfclStage: stage };
    return { ...base('transform', wh, toEventIso(time, offset), role, idem), kind: 'aggregation', inputs, outputs, sfclStage: stage };
  };
  const draft = make('in-progress');

  const save = async (stage: 'in-progress' | 'finalized') => {
    const d = make(stage);
    if (!d) return;
    if (stage === 'finalized') {
      const r = validateDraft(db, d, existing?.id);
      if ([...r.own, ...r.knockOn].some((f) => f.severity === 'blocking')) {
        toast('Cannot finalize — fix the blocking findings first.', 'error');
        return;
      }
    }
    const summary = stage === 'finalized' ? `${outId} finalized at ${fmtKg(total)}` : `${outId} saved in progress (${fmtKg(total)} of ${fmtKg(SFCL_TARGET)})`;
    if (existing) {
      if (!(await updateAggregation(existing.id, d, summary, stage === 'finalized')).ok) return;
    }
    else if (!(await recordEvent(d, summary)).ok) return;
    onDone();
  };

  const status = total > SFCL_TARGET ? 'over' : total === SFCL_TARGET ? 'exact' : 'under';

  return (
    <FormShell
      intro="Aggregation is recorded as a Transform: each LPO draw is an Input row and the SFCL is the single Output row. Draws above 3,000 kg are flagged for review but allowed to close a shortfall; no draw may exceed the LPO's available balance. An SFCL can only be finalized at exactly 21,000 kg."
      draft={draft}
      replaceId={existing?.id}
      missing={missing}
      submitLabel="Save as in progress"
      onSubmit={() => save('in-progress')}
      extraActions={
        <button className="btn btn-amber" disabled={status !== 'exact' || missing.length > 0} onClick={() => save('finalized')} title="Enabled only at exactly 21,000 kg">
          <CheckCircle2 size={15} /> Finalize at 21,000 kg
        </button>
      }
      preview={
        <div className="stack-sm review-box">
          <div className="row-between small">
            <b>{outId || 'New SFCL'}</b>
            <span>
              {fmtKg(total)} / {fmtKg(SFCL_TARGET)}
            </span>
          </div>
          <Meter value={total} max={SFCL_TARGET} label="SFCL total" />
          <div className="small" style={{ color: status === 'over' ? 'var(--danger)' : status === 'exact' ? 'var(--forest-2)' : 'var(--amber-ink)' }}>
            {status === 'over' && `Blocked: ${fmtKg(total - SFCL_TARGET)} over 21,000 kg.`}
            {status === 'exact' && 'Exactly 21,000 kg — can be finalized.'}
            {status === 'under' && `In progress: ${fmtKg(SFCL_TARGET - total)} still needed.`}
          </div>
        </div>
      }
    >
      <div className="card card-pad form-grid">
        <Field label="Aggregation">
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              const ex = inProgress.find((x) => x.id === e.target.value);
              setDraws(Object.fromEntries((ex?.inputs ?? []).map((i) => [i.lotId, String(i.qty)])));
            }}
          >
            <option value="new">Start a new SFCL</option>
            {inProgress.map((e) => (
              <option key={e.id} value={e.id}>
                Continue {e.outputs[0].lotId} ({fmtKg(e.outputs[0].qty)} so far)
              </option>
            ))}
          </select>
        </Field>
        {!existing && (
          <Field label="SFCL number" hint="season + sequence, e.g. SFCL 26903">
            <input className="mono" value={sfclId} onChange={(e) => setSfclId(e.target.value)} />
          </Field>
        )}
        <Field label="Warehouse">
          <input value={analysis.places.get(wh)?.name ?? ''} disabled />
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} label={existing ? 'Event time of this update' : 'Event time'} />
      </div>
      <div className="lines">
        <div className="lines-head">
          <span>LPO draws (Input rows)</span>
          <span className="tiny muted">usual draw {fmtKg(DRAW_NORM)} per LPO</span>
        </div>
        {lpos.length === 0 && <div className="small muted" style={{ padding: '10px 12px' }}>No LPO balances at this warehouse.</div>}
        {lpos.map((l) => {
          const v = parseFloat(draws[l.lotId] ?? '') || 0;
          return (
            <div key={l.lotId} className="line-row wide">
              <span>
                <span className="id">{l.lotId}</span>
                <div className="tiny muted">
                  produced {fmtKg(l.produced)} · available {fmtKg(l.available)}
                </div>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setDraws({ ...draws, [l.lotId]: String(Math.min(DRAW_NORM, l.available)) })} title="Draw the usual amount (or all if less)">
                {l.available < DRAW_NORM ? 'All' : '3,000'}
              </button>
              <input type="number" min={0} step="any" placeholder="kg drawn" value={draws[l.lotId] ?? ''} onChange={(e) => setDraws({ ...draws, [l.lotId]: e.target.value })} aria-label={`Draw from ${l.lotId}`} />
              <span />
              {v > l.available && (
                <div className="tiny" style={{ gridColumn: '1/-1', color: 'var(--danger)' }}>
                  Blocked: more than the {fmtKg(l.available)} this LPO has available.
                </div>
              )}
              {v > DRAW_NORM && v <= l.available && (
                <div className="tiny" style={{ gridColumn: '1/-1', color: 'var(--amber-ink)', display: 'flex', gap: 5 }}>
                  <AlertTriangle size={12} /> Above the usual 3,000 kg — allowed to close a shortfall; will be flagged for review.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FormShell>
  );
}

/* ── Arrived and ready for pickup → trace URL + QR + Commercial handoff ─── */
export function ReadyForm({ locations, onDone }: { locations: string[]; onDone: () => void }) {
  const { db, analysis, role, markReady } = useStore();
  const idem = useIdem();
  const eligibleLocs = locations.filter((id) => ['refiner', 'filterer', 'destination-warehouse'].includes(analysis.places.get(id)?.kind ?? ''));
  const [loc, setLoc] = useState('');
  const [lotId, setLotId] = useState('');
  const [qty, setQty] = useState('');
  const [client, setClient] = useState('');
  const [order, setOrder] = useState('');
  const [time, setTime] = useState('');
  const [offset, setOffset] = useState('+01:00');
  const [done, setDone] = useState<Handoff | null>(null);
  const lots = useMemo(() => (loc ? heldAt(analysis, loc).filter((l) => !db.handoffs.some((h) => h.lotId === l.lotId && h.locationId === loc)) : []), [analysis, db.handoffs, loc]);
  const name = (id: string) => analysis.places.get(id)?.name ?? id;

  const pickLot = (id: string) => {
    setLotId(id);
    const held = lots.find((l) => l.lotId === id);
    setQty(held ? String(held.qty) : '');
    // client/order from the most recent recorded shipment of this lot (or its parents) that carried them
    const related = new Set([id, ...(analysis.lots.get(id)?.parents.map((p) => p.lotId) ?? [])]);
    const ship = [...analysis.sorted].reverse().find((e) => e.type === 'ship' && e.exportDetails?.clientName && e.items.some((i) => related.has(i.lotId)));
    if (ship && ship.type === 'ship') {
      setClient(ship.exportDetails?.clientName ?? '');
      setOrder(ship.exportDetails?.orderRef ?? '');
    }
  };

  const product = analysis.lots.get(lotId)?.product ?? 'OSB';
  const missing = [!loc && 'Destination location', !lotId && 'Lot / batch', !(parseFloat(qty) > 0) && 'Quantity ready', !client.trim() && 'Client', !order.trim() && 'Client order reference', !time && 'Event time'].filter(Boolean) as string[];
  const handoffId = useMemo(() => uid('ho'), []);
  const draft: ReadyEvent | null = missing.length ? null : { ...base('ready', loc, toEventIso(time, offset), role, idem), items: [{ lotId, product, qty: parseFloat(qty) }], handoffId };

  if (done) {
    return (
      <div className="stack">
        <div className="ok-box">
          <CheckCircle2 size={16} style={{ flex: 'none' }} />
          <span>
            {done.lotId} is marked <b>Arrived and ready for pickup</b> at {name(done.locationId)} — a customer trace link, QR and a Commercial handoff were created.
          </span>
        </div>
        <div className="card card-pad">
          <TraceLinkPanel handoff={done} />
        </div>
        <div className="card card-pad">
          <h3>Commercial handoff</h3>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Batch</dt>
            <dd className="id">{done.lotId}</dd>
            <dt>Quantity</dt>
            <dd>{fmtKg(done.qty)}</dd>
            <dt>Client</dt>
            <dd>{done.clientName}</dd>
            <dt>Order ref</dt>
            <dd>{done.orderRef}</dd>
            <dt>Status</dt>
            <dd>
              <span className="chip chip-amber">New — awaiting Commercial</span>
            </dd>
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn" href="#/handoffs" onClick={onDone}>
              Open Commercial handoffs
            </a>
            <button className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <FormShell
      intro="Supply Chain marks the refined or filtered product Arrived and ready for pickup at the refiner or filterer. This creates one customer trace link + QR and one Commercial handoff; repeating it reuses the same handoff."
      draft={draft}
      missing={missing}
      submitLabel="Mark arrived & ready for pickup"
      onSubmit={async () => {
        if (!draft) return;
        const r = await markReady(draft, { lotId, qty: parseFloat(qty), product, locationId: loc, clientName: client.trim(), orderRef: order.trim() });
        if (r.ok && r.handoff) setDone(r.handoff);
      }}
    >
      <div className="card card-pad form-grid">
        <Field label="Destination">
          <select
            value={loc}
            onChange={(e) => {
              setLoc(e.target.value);
              setLotId('');
            }}
          >
            <option value="">Select…</option>
            {eligibleLocs.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lot / batch held here">
          <select value={lotId} onChange={(e) => pickLot(e.target.value)} disabled={!loc}>
            <option value="">{loc ? (lots.length ? 'Select…' : 'Nothing eligible here') : 'Choose destination first'}</option>
            {lots.map((l) => (
              <option key={l.lotId} value={l.lotId}>
                {l.lotId} · {fmtKg(l.qty)} {l.product}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity ready" hint="kg">
          <input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Client" hint="fictional">
          <input value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        <Field label="Client order reference">
          <input value={order} onChange={(e) => setOrder(e.target.value)} />
        </Field>
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} hint="when it became ready for pickup" />
      </div>
    </FormShell>
  );
}

/* ── Correction (never silent: creates a history entry) ─────────────────── */
export function CorrectionForm({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const { db, correctEvent } = useStore();
  const ev = db.events.find((e) => e.id === eventId)!;
  const [time, setTime] = useState(ev.eventTime.slice(0, 16));
  const [offset, setOffset] = useState(ev.eventTime.slice(19) || '+00:00');
  const [notes, setNotes] = useState(ev.notes ?? '');
  const [qtys, setQtys] = useState<string[]>(eventLines(ev).map((l) => String(l.qty)));
  const [exp, setExp] = useState(ev.type === 'ship' ? { ...(ev.exportDetails ?? {}) } : {});
  const [reason, setReason] = useState('');
  const lines = eventLines(ev);

  const apply = (): TraceEvent => {
    const q = (i: number) => parseFloat(qtys[i]);
    const eventTime = toEventIso(time, offset);
    switch (ev.type) {
      case 'commission':
        return { ...ev, eventTime, notes: notes || undefined, outputs: [{ ...ev.outputs[0], qty: q(0) }] };
      case 'transform':
        return { ...ev, eventTime, notes: notes || undefined, inputs: ev.inputs.map((l, i) => ({ ...l, qty: q(i) })), outputs: ev.outputs.map((l, i) => ({ ...l, qty: q(ev.inputs.length + i) })) };
      case 'ship':
        return { ...ev, eventTime, notes: notes || undefined, items: ev.items.map((l, i) => ({ ...l, qty: q(i) })), exportDetails: Object.values(exp).some(Boolean) ? exp : undefined };
      default:
        return { ...ev, eventTime, notes: notes || undefined, items: ev.items.map((l, i) => ({ ...l, qty: q(i) })) } as TraceEvent;
    }
  };
  const changed = JSON.stringify(apply()) !== JSON.stringify(ev);
  const missing = [!changed && 'Change at least one value', !reason.trim() && 'Reason for the correction', !time && 'Event time'].filter(Boolean) as string[];
  const draft = missing.length ? null : apply();

  return (
    <FormShell
      intro="Corrections never overwrite silently. The original version is kept in the correction history with who, when and why, and the event's version number increases. Identifiers cannot be edited here: a wrong ID is handled as a superseding entry (outside this prototype)."
      draft={draft}
      replaceId={ev.id}
      missing={missing}
      submitLabel="Record correction"
      onSubmit={async () => { if (draft && (await correctEvent(ev.id, draft, reason.trim(), `Corrected ${ev.type} event`)).ok) onDone(); }}
    >
      <div className="card card-pad form-grid">
        <EventTime value={time} onChange={setTime} offset={offset} setOffset={setOffset} />
        <Field label="Notes" span={2}>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {ev.type === 'ship' && (
          <>
            <Field label="Container no.">
              <input value={(exp as { containerNo?: string }).containerNo ?? ''} onChange={(e) => setExp({ ...exp, containerNo: e.target.value })} />
            </Field>
            <Field label="Vessel">
              <input value={(exp as { vessel?: string }).vessel ?? ''} onChange={(e) => setExp({ ...exp, vessel: e.target.value })} />
            </Field>
            <Field label="ETA">
              <input type="date" value={(exp as { eta?: string }).eta ?? ''} onChange={(e) => setExp({ ...exp, eta: e.target.value })} />
            </Field>
          </>
        )}
      </div>
      <div className="lines">
        <div className="lines-head">
          <span>Quantities</span>
          <span className="tiny muted">identifiers are read-only</span>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="line-row">
            <span>
              {l.role === 'in' && <span className="tag-in">IN </span>}
              {l.role === 'out' && <span className="tag-out">OUT </span>}
              <span className="id">{l.lotId}</span> <span className="tiny muted">{l.product}</span>
            </span>
            <input type="number" min={0} step="any" value={qtys[i]} onChange={(e) => setQtys(qtys.map((x, j) => (j === i ? e.target.value : x)))} />
            <span />
          </div>
        ))}
      </div>
      <div className="card card-pad">
        <Field label="Reason for correction" hint="required, kept in the audit history">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Weighbridge ticket shows 4,230 kg; officer typed 4,320." />
        </Field>
      </div>
    </FormShell>
  );
}
