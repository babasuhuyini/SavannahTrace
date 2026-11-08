import { CheckCircle2, Clock, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, type ReactNode } from 'react';
import { FindingList } from '../../components/ui';
import type { LotQty, ProductCode, RoleId, TraceEvent } from '../../data/types';
import { validateDraft, type Finding } from '../../domain/engine';
import { fmtKg, nowLocalFor, uid } from '../../domain/format';
import { useStore } from '../../domain/store';

export const OFFSETS = [
  { v: '+00:00', l: 'UTC+0 (Ghana)' },
  { v: '+01:00', l: 'UTC+1 (CET, Amsterdam winter)' },
  { v: '+02:00', l: 'UTC+2 (CEST, Amsterdam summer)' },
];

export const useIdem = () => useRef(uid('idem')).current;

export function base<T extends TraceEvent['type']>(type: T, locationId: string, eventTime: string, role: RoleId, idem: string) {
  return { id: `ev-${idem.slice(5)}`, type, locationId, eventTime, recordedAt: new Date().toISOString(), recordedBy: role, version: 1, idempotencyKey: idem };
}

/** Event time input. Starts empty on purpose: the officer must say when it happened. */
export function EventTime({ value, onChange, offset, setOffset, label = 'Event time', hint = 'when the activity actually happened' }: {
  value: string;
  onChange: (v: string) => void;
  offset: string;
  setOffset: (v: string) => void;
  label?: string;
  hint?: string;
}) {
  return (
    <div className="field" style={{ gridColumn: 'span 2' }}>
      <span>
        {label} <span className="hint">· {hint}</span>
      </span>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={{ flex: 1 }} />
        <select value={offset} onChange={(e) => setOffset(e.target.value)} aria-label="Time zone" style={{ width: 'auto' }}>
          {OFFSETS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" onClick={() => onChange(nowLocalFor(offset))} title="Explicitly use the current time">
          <Clock size={13} /> Now
        </button>
      </div>
      <span className="hint">The recorded time is captured separately and automatically — it is never used as the event time.</span>
    </div>
  );
}

export function useDraftCheck(draft: TraceEvent | null, replaceId?: string) {
  const { db } = useStore();
  return useMemo(() => {
    if (!draft) return { own: [] as Finding[], knockOn: [] as Finding[], blocking: true };
    const r = validateDraft(db, draft, replaceId);
    const blocking = r.own.some((f) => f.severity === 'blocking') || r.knockOn.some((f) => f.severity === 'blocking');
    return { own: r.own, knockOn: r.knockOn, blocking };
  }, [db, draft, replaceId]);
}

/** Form layout: fields on the left, live review panel on the right. */
export function FormShell({
  intro,
  children,
  draft,
  missing,
  submitLabel,
  onSubmit,
  replaceId,
  extraActions,
  preview,
}: {
  intro?: ReactNode;
  children: ReactNode;
  draft: TraceEvent | null;
  missing: string[];
  submitLabel: string;
  onSubmit: () => void;
  replaceId?: string;
  extraActions?: ReactNode;
  preview?: ReactNode;
}) {
  const check = useDraftCheck(missing.length ? null : draft, replaceId);
  return (
    <div className="form-layout">
      <div className="stack">
        {intro && <div className="small muted">{intro}</div>}
        {children}
      </div>
      <aside className="card form-review">
        <div className="card-head">
          <h3>Review before saving</h3>
        </div>
        <div className="card-body stack-sm">
          {missing.length > 0 ? (
            <div className="finding info">
              <Clock size={16} />
              <div>
                <div className="rule">Still needed</div>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <>
              <FindingList
                findings={check.own}
                empty={
                  <div className="ok-box">
                    <CheckCircle2 size={16} /> All checks pass for this entry.
                  </div>
                }
              />
              {check.knockOn.length > 0 && (
                <>
                  <div className="tiny muted" style={{ fontWeight: 700, marginTop: 6 }}>
                    EFFECT ON LATER EVENTS
                  </div>
                  <FindingList findings={check.knockOn} />
                </>
              )}
            </>
          )}
          {preview}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-primary" disabled={missing.length > 0 || check.blocking} onClick={onSubmit}>
              {submitLabel}
            </button>
            {extraActions}
          </div>
          {!missing.length && check.blocking && <div className="tiny" style={{ color: 'var(--danger)' }}>Blocking findings must be fixed before this can be saved.</div>}
          <div className="tiny muted">Identifiers are saved exactly as typed. Nothing is changed automatically.</div>
        </div>
      </aside>
    </div>
  );
}

export interface LineDraft {
  lotId: string;
  qty: string;
}

/** Choose lots from those available, with quantities. */
export function LinesEditor({
  title,
  lines,
  setLines,
  available,
  allowFree,
}: {
  title: string;
  lines: LineDraft[];
  setLines: (l: LineDraft[]) => void;
  available: (LotQty & { note?: string })[];
  allowFree?: boolean;
}) {
  const avail = new Map(available.map((a) => [a.lotId, a]));
  const used = new Set(lines.map((l) => l.lotId));
  const total = lines.reduce((s, l) => s + (parseFloat(l.qty) || 0), 0);
  return (
    <div className="lines">
      <div className="lines-head">
        <span>
          {title} · {fmtKg(total)}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {available.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setLines(available.map((a) => ({ lotId: a.lotId, qty: String(a.qty) })))}
              title="Add every available lot with its full available quantity"
            >
              Add all available
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { lotId: '', qty: '' }])}>
            <Plus size={13} /> Line
          </button>
        </span>
      </div>
      {lines.length === 0 && <div className="small muted" style={{ padding: '10px 12px' }}>{available.length ? 'No lines yet. Add a line or add all available lots.' : 'Nothing is available here right now.'}</div>}
      {lines.map((l, i) => {
        const a = avail.get(l.lotId);
        return (
          <div key={i} className="line-row">
            {allowFree ? (
              <>
                <input list={`avail-${title}`} value={l.lotId} placeholder="Lot / batch ID" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, lotId: e.target.value } : x)))} />
                <datalist id={`avail-${title}`}>
                  {available.map((a) => (
                    <option key={a.lotId} value={a.lotId} />
                  ))}
                </datalist>
              </>
            ) : (
              <select value={l.lotId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, lotId: e.target.value, qty: x.qty || String(avail.get(e.target.value)?.qty ?? '') } : x)))}>
                <option value="">Select lot…</option>
                {available
                  .filter((a) => a.lotId === l.lotId || !used.has(a.lotId))
                  .map((a) => (
                    <option key={a.lotId} value={a.lotId}>
                      {a.lotId} · {fmtKg(a.qty)} {a.product} available{a.note ? ` · ${a.note}` : ''}
                    </option>
                  ))}
              </select>
            )}
            <input type="number" min={0} step="any" inputMode="decimal" placeholder="kg" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity in kg" />
            <button type="button" className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">
              <Trash2 size={14} />
            </button>
            {a && parseFloat(l.qty) > a.qty && (
              <div className="tiny" style={{ gridColumn: '1 / -1', color: 'var(--danger)' }}>
                More than the {fmtKg(a.qty)} available.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const toLines = (lines: LineDraft[], productOf: (lotId: string) => ProductCode | undefined): LotQty[] =>
  lines.filter((l) => l.lotId.trim()).map((l) => ({ lotId: l.lotId.trim(), product: productOf(l.lotId.trim()) ?? 'ODK', qty: parseFloat(l.qty) }));
