import { CheckCircle2, History, Pencil, Route as RouteIcon, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Drawer, FindingList, MarkerGlyph, DemoBadge, Seg, SevIcon } from '../components/ui';
import type { AuditEntry, TraceEvent } from '../data/types';
import { describeEvent, EVENT_TYPE_LABEL } from '../domain/describe';
import { RULES, severityCounts, type RuleId, type Severity } from '../domain/engine';
import { fmtEventTime, fmtRecorded } from '../domain/format';
import { ROLES } from '../domain/roles';
import { eventVisible, findingsFor } from '../domain/access';
import { useSession } from '../domain/store';
import { ancestors, eventLines, markerKind } from '../domain/trace';
import { traceHref } from '../router';
import { CorrectionForm } from './forms/ProcessForms';

type Tab = 'log' | 'findings' | 'history' | 'quality';

export function Audit() {
  const { db, analysis, user, viewer } = useSession();
  const [tab, setTab] = useState<Tab>('log');
  const [correct, setCorrect] = useState<string | null>(null);
  const counts = severityCounts(findingsFor(viewer, analysis));
  const canCorrect = ROLES[user.role].can.correctEvents;
  const visibleCount = db.events.filter((e) => eventVisible(viewer, e)).length;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p>
            Every event with its event time and recorded time, every validation finding, and every correction as a history entry. Nothing is changed silently.
            {user.role === 'auditor' && ' Read-only: your access is limited to your assigned audit scope and is itself logged.'}
          </p>
        </div>
        <div className="row">
          <span className="chip chip-danger">{counts.blocking} blocking</span>
          <span className="chip chip-amber">{counts.review} needs review</span>
          <span className="chip chip-info">{counts.info} information</span>
        </div>
      </div>
      <div className="tabs">
        {(
          [
            ['log', `Event log (${visibleCount})`],
            ['findings', `Validation findings (${counts.blocking + counts.review + counts.info})`],
            ['history', `Correction & audit history (${db.audit.length})`],
            ['quality', 'Data-quality status'],
          ] as [Tab, string][]
        ).map(([t, l]) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'log' && <EventLog onCorrect={canCorrect ? setCorrect : undefined} />}
      {tab === 'findings' && <Findings />}
      {tab === 'history' && <HistoryList entries={user.role === 'it-admin' ? db.audit : db.audit.filter((a) => !a.action.startsWith('user.'))} />}
      {tab === 'quality' && <Quality />}
      {correct && (
        <Drawer title="Record a correction" subtitle="Creates a new history entry; the original is preserved" onClose={() => setCorrect(null)} icon={<Pencil size={22} />}>
          <CorrectionForm eventId={correct} onDone={() => setCorrect(null)} />
        </Drawer>
      )}
    </div>
  );
}

function EventLog({ onCorrect }: { onCorrect?: (id: string) => void }) {
  const { db, analysis, viewer } = useSession();
  const [type, setType] = useState<'all' | TraceEvent['type']>('all');
  const [q, setQ] = useState('');
  const findingCount = useMemo(() => {
    const m = new Map<string, Severity[]>();
    for (const f of analysis.findings) if (f.eventId) m.set(f.eventId, [...(m.get(f.eventId) ?? []), f.severity]);
    return m;
  }, [analysis]);
  const rows = analysis.sorted.filter((e) => eventVisible(viewer, e) && (type === 'all' || e.type === type) && (!q || eventLines(e).some((l) => l.lotId.toLowerCase().includes(q.toLowerCase())))).reverse();
  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={{ width: 'auto' }} aria-label="Event type">
            <option value="all">All event types</option>
            {Object.entries(EVENT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by lot / batch ID" style={{ width: 240 }} />
        </div>
        <span className="tiny muted">{rows.length} events · newest event time first · {onCorrect ? 'corrections create a new history entry' : 'read-only'}</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: 640, overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Event time</th>
              <th>Type</th>
              <th>Detail</th>
              <th>Recorded</th>
              <th>Ver.</th>
              <th>Checks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const fs = findingCount.get(e.id) ?? [];
              const worst: Severity | undefined = fs.includes('blocking') ? 'blocking' : fs.includes('review') ? 'review' : fs.includes('info') ? 'info' : undefined;
              const firstLot = eventLines(e)[0]?.lotId;
              return (
                <tr key={e.id}>
                  <td className="nowrap">{fmtEventTime(e.eventTime)}</td>
                  <td className="nowrap">
                    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <MarkerGlyph kind={markerKind(e, analysis.places)} size={20} /> {EVENT_TYPE_LABEL[e.type]}
                    </span>
                  </td>
                  <td>
                    {describeEvent(e, analysis, db)}
                    <DemoBadge show={!!e.demo} />
                  </td>
                  <td className="nowrap small">
                    {fmtRecorded(e.recordedAt)}
                    <div className="tiny muted">{ROLES[e.recordedBy].label}</div>
                  </td>
                  <td>{e.version > 1 ? <span className="chip chip-amber">v{e.version}</span> : <span className="muted">v1</span>}</td>
                  <td>
                    {worst ? (
                      <span className={`chip ${worst === 'blocking' ? 'chip-danger' : worst === 'review' ? 'chip-amber' : 'chip-info'}`}>
                        <SevIcon s={worst} size={12} /> {fs.length}
                      </span>
                    ) : (
                      <CheckCircle2 size={15} color="#2d6a4a" aria-label="All checks pass" />
                    )}
                  </td>
                  <td className="nowrap">
                    {firstLot && (
                      <a className="btn btn-sm btn-ghost" href={traceHref(firstLot)} title="Trace">
                        <RouteIcon size={13} />
                      </a>
                    )}
                    {onCorrect && (
                      <button className="btn btn-sm btn-ghost" onClick={() => onCorrect(e.id)}>
                        <Pencil size={13} /> Correct
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Findings() {
  const { analysis, viewer } = useSession();
  const [sev, setSev] = useState<'all' | Severity>('all');
  const list = findingsFor(viewer, analysis).filter((f) => sev === 'all' || f.severity === sev);
  return (
    <div className="card">
      <div className="card-head">
        <Seg
          value={sev}
          onChange={setSev}
          options={[
            { v: 'all', l: 'All' },
            { v: 'blocking', l: 'Blocking' },
            { v: 'review', l: 'Needs review' },
            { v: 'info', l: 'Information' },
          ]}
        />
        <span className="tiny muted">Rebuilt from all events on every change — never accumulated</span>
      </div>
      <div className="card-body">
        <FindingList
          findings={list}
          onSelect={(f) => {
            const lot = f.lotId ?? (f.eventId ? eventLines(analysis.byId.get(f.eventId)!)[0]?.lotId : undefined);
            if (lot) window.location.hash = traceHref(lot);
          }}
        />
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Select a finding to open its lot in the Trace explorer. The 3,000 kg LPO draw is a review norm, not a limit; the only hard SFCL checks are the exact 21,000 kg total and no draw beyond an LPO's available balance.
        </p>
      </div>
    </div>
  );
}

function diff(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const out: string[] = [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (['version', 'recordedAt'].includes(k)) continue;
    const x = JSON.stringify(b[k]);
    const y = JSON.stringify(a[k]);
    if (x !== y) out.push(`${k}: ${x === undefined ? '—' : x.length > 80 ? x.slice(0, 77) + '…' : x} → ${y === undefined ? '—' : y.length > 80 ? y.slice(0, 77) + '…' : y}`);
  }
  return out;
}

function HistoryList({ entries }: { entries: AuditEntry[] }) {
  const list = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="card">
      <div className="card-body stack-sm">
        {list.map((e) => {
          const d = diff(e.before, e.after);
          return (
            <div key={e.id} className="task" style={{ alignItems: 'flex-start' }}>
              <div className="ic">
                <History size={17} />
              </div>
              <div className="body">
                <div className="row-between">
                  <span className="title">{e.summary}</span>
                  <span className="tiny muted nowrap">
                    {fmtRecorded(e.at)} · {e.actor === 'system' ? 'System' : ROLES[e.actor]?.label ?? e.actor}
                  </span>
                </div>
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  <span className="chip">{e.action}</span>
                  {e.demo && <DemoBadge />}
                </div>
                {e.reason && (
                  <div className="small" style={{ marginTop: 6 }}>
                    <b>Reason:</b> {e.reason}
                  </div>
                )}
                {d.length > 0 && (
                  <ul className="mono tiny" style={{ margin: '6px 0 0', paddingLeft: 16, color: 'var(--ink-2)' }}>
                    {d.slice(0, 6).map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CHECKS: RuleId[] = [
  'chronology',
  'future-time',
  'custody',
  'available-balance',
  'quantity',
  'product',
  'route',
  'unknown-id',
  'duplicate-id',
  'duplicate-submission',
  'one-commission-per-day',
  'lot-id-pattern',
  'receipt-quantity',
  'discrepancy',
  'yield',
  'mass-balance',
  'draw-norm',
  'sfcl-total',
  'eligibility',
  'master-data',
];

function Quality() {
  const { db, analysis } = useSession();
  const sfcls = [...analysis.lots.values()].filter((l) => l.kind === 'sfcl');
  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-head">
          <h3>Rule checks across all {db.events.length} events</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Check</th>
              <th className="num">Blocking</th>
              <th className="num">Review</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {CHECKS.map((r) => {
              const fs = analysis.findings.filter((f) => f.rule === r);
              const b = fs.filter((f) => f.severity === 'blocking').length;
              const v = fs.filter((f) => f.severity === 'review').length;
              return (
                <tr key={r}>
                  <td>{RULES[r]}</td>
                  <td className="num">{b || '—'}</td>
                  <td className="num">{v || '—'}</td>
                  <td>
                    {b ? (
                      <span className="chip chip-danger">
                        <XCircle size={12} /> Fail
                      </span>
                    ) : v ? (
                      <span className="chip chip-amber">Review</span>
                    ) : (
                      <span className="chip chip-forest">
                        <CheckCircle2 size={12} /> Pass
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3>Chain completeness by SFCL</h3>
          </div>
          <div className="card-body stack-sm">
            {sfcls.map((s) => {
              const anc = [...ancestors(analysis, s.lotId)];
              const purchases = anc.filter((id) => analysis.lots.get(id)?.kind === 'purchase').length;
              const complete = anc.every((id) => analysis.lots.has(id)) && purchases > 0;
              return (
                <div key={s.lotId} className="row-between">
                  <a className="id" href={traceHref(s.lotId)}>
                    {s.lotId}
                  </a>
                  <span className="small">
                    {anc.length} ancestor lots · {purchases} purchases · {s.sfclStage === 'finalized' ? 'finalized' : 'in progress'}
                  </span>
                  <span className={`chip ${complete ? 'chip-forest' : 'chip-danger'}`}>{complete ? 'Traceable to source' : 'Gap'}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card card-pad small">
          <h3 style={{ marginBottom: 6 }}>How checks work in this prototype</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>All events are replayed in event-time order on every change; mass balance and custody are rebuilt from scratch.</li>
            <li>Every adjacent pair is compared on full timestamps: purchase &lt; ship &lt; receive &lt; issue &lt; transform &lt; onward ship.</li>
            <li>Identifiers are never repaired. Unknown or mismatched IDs become findings.</li>
            <li>Duplicate submissions are blocked by an idempotency key and by content comparison.</li>
            <li>Corrections create a new history entry with the reason, before and after.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
