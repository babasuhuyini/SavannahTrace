import { ArrowLeftRight, Download, ExternalLink, FileText, GitBranch, Lock, Search } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { EventCard } from '../components/EventCard';
import { Genealogy } from '../components/Genealogy';
import { Timeline } from '../components/Timeline';
import { DemoBadge, FindingList, LotLink, Seg } from '../components/ui';
import { DEMO_TRACE_LOT } from '../data/seed';
import { PRODUCTS, type TransformEvent } from '../data/types';
import { eventVisible, findingsFor } from '../domain/access';
import type { MapMode } from '../domain/disclosure';
import { TRANSFORM_LABEL } from '../domain/engine';
import { fmtDate, fmtEventTime, fmtKg, pct } from '../domain/format';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { buildTrace, eventLines, type Direction } from '../domain/trace';
import { downloadCsv, lineageCsv, traceEventsCsv } from '../domain/reports';
import { go, traceHref, useRoute } from '../router';

const TraceMap = lazy(() => import('../components/TraceMap'));

const KIND_LABEL: Record<string, string> = {
  purchase: 'Purchase lot',
  'kernel-batch': 'ODK batch (PHC)',
  lpo: 'LPO crude-butter batch',
  sfcl: 'SFCL export batch',
  refined: 'Refined product',
  filtered: 'Filtered product',
};

export function TraceExplorer() {
  const { db, analysis, viewer, user, traceLink } = useSession();
  const route = useRoute();
  const can = ROLES[user.role].can;
  const restricted = can.trace === 'restricted';
  const lotId = route.path[1] ?? DEMO_TRACE_LOT;
  const dir = (route.query.get('dir') as Direction) || 'backward';
  const [mode, setMode] = useState<MapMode>('internal');
  const [selected, setSelected] = useState<string | undefined>();
  const [hlWp, setHlWp] = useState<string | undefined>();
  const [focus, setFocus] = useState<{ ids: string[]; n: number } | undefined>();
  const [query, setQuery] = useState('');
  const [link, setLink] = useState<string | null>(null);

  // Restricted roles (Supply Chain) may trace only lots that passed through their own locations.
  const inScope = useMemo(() => {
    if (!restricted) return () => true;
    const lots = new Set<string>();
    for (const e of db.events) if (eventVisible(viewer, e) && viewer.locations.has(e.locationId)) eventLines(e).forEach((l) => lots.add(l.lotId));
    return (id: string) => lots.has(id);
  }, [restricted, db, viewer]);

  const trace = useMemo(() => (inScope(lotId) ? buildTrace(analysis, db, lotId, dir) : null), [analysis, db, lotId, dir, inScope]);
  useEffect(() => {
    setSelected(undefined);
    setHlWp(undefined);
  }, [lotId, dir]);
  const handoff = db.handoffs.find((h) => h.lotId === lotId);
  useEffect(() => {
    let live = true;
    setLink(null);
    if (handoff) traceLink(handoff).then((u) => live && setLink(u));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.id, handoff?.token]);

  const allLots = useMemo(() => [...analysis.lots.values()].filter((l) => inScope(l.lotId)).sort((a, b) => a.kind.localeCompare(b.kind) || a.lotId.localeCompare(b.lotId)), [analysis, inScope]);
  const quick = ['SFCL 26901', 'ORSB 26901-R1', 'SFCL 26902', 'LPO-90411', 'DX01-CA9150-B002-080626', 'DX02-CA9204-013-071826'].filter((id) => analysis.lots.has(id) && inScope(id));

  if (!trace) {
    const exists = analysis.lots.has(lotId);
    return (
      <div className="stack">
        <Header query={query} setQuery={setQuery} lots={allLots.map((l) => l.lotId)} quick={quick} />
        <div className="card card-pad">
          {exists && !inScope(lotId) ? (
            <>
              <h3 className="row" style={{ gap: 8 }}>
                <Lock size={16} /> Outside your scope
              </h3>
              <p className="muted" style={{ marginTop: 6 }}>
                {lotId} did not pass through your assigned locations, so its trace is not available to your role.
              </p>
            </>
          ) : (
            <>
              <h3>No lot found for “{lotId}”</h3>
              <p className="muted" style={{ marginTop: 6 }}>
                Identifiers are matched exactly and never guessed. Check the ID or pick one of the suggestions above.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const step = trace.steps.find((s) => s.id === selected);
  const siblings = step ? trace.steps.filter((s) => s.waypointId === step.waypointId) : [];
  const t = trace.target;
  const statusPlace = trace.status.locationId ? analysis.places.get(trace.status.locationId)?.name : '';
  const traceFindings = findingsFor(viewer, analysis).filter((f) => trace.events.some((e) => e.id === f.eventId));
  const transforms = trace.events.filter((e): e is TransformEvent => e.type === 'transform');
  const purchases = trace.events.filter((e) => e.type === 'commission');
  const docs = db.documents.filter((d) => (d.appliesTo === '*' || d.appliesTo.some((x) => trace.lotSet.has(x))) && (d.public || !restricted));

  const selectWaypoint = (wpId: string) => {
    const wp = trace.waypoints.find((w) => w.id === wpId);
    if (!wp) return;
    setHlWp(wpId);
    setSelected(wp.stepIds[0]);
  };

  return (
    <div className="stack">
      <Header query={query} setQuery={setQuery} lots={allLots.map((l) => l.lotId)} quick={quick} current={lotId} />

      <div className="lot-bar">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="lot-id">{t.lotId}</span>
            <DemoBadge show={!!t.demo} />
            <span className="chip">{KIND_LABEL[t.kind]}</span>
            <span className={`status ${trace.status.tone === 'done' ? 'ok' : trace.status.tone === 'transit' ? 'info' : 'wait'}`}>{trace.status.label}</span>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {PRODUCTS[t.product]} · {fmtKg(t.createdQty)} · created {fmtDate(t.createdAt)} at {analysis.places.get(t.createdAtLocation)?.name}
            {t.kind === 'sfcl' && (t.sfclStage === 'finalized' ? ' · finalized at 21,000 kg' : ' · aggregation in progress')}
          </div>
        </div>
        <div className="row">
          <Seg<Direction>
            label="Trace direction"
            value={dir}
            onChange={(d) => go(traceHref(lotId, d))}
            options={[
              { v: 'backward', l: '← Back to source' },
              { v: 'forward', l: 'Forward →' },
              { v: 'full', l: 'Both' },
            ]}
          />
          <button className="btn btn-sm" onClick={() => downloadCsv(traceEventsCsv(trace, analysis, db, { pii: can.collectorPersonalData, prices: can.prices, internal: true }))} title="Every step of this trace as a CSV for Excel">
            <Download size={14} /> Trace CSV
          </button>
          <button className="btn btn-sm" onClick={() => downloadCsv(lineageCsv(trace, analysis))} title="Input → output lineage as a CSV">
            <Download size={14} /> Lineage CSV
          </button>
          {link && (
            <a className="btn btn-sm" href={link} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Customer page
            </a>
          )}
        </div>
      </div>

      <div className="trace-layout">
        <Suspense fallback={<div className="map-loading">Loading map…</div>}>
          <TraceMap
            trace={trace}
            db={db}
            analysis={analysis}
            mode={restricted ? 'generalized' : mode}
            modeOptions={restricted ? undefined : ['internal', 'generalized', 'masked']}
            onModeChange={setMode}
            selectedStepId={selected}
            highlightWaypointId={hlWp}
            onSelectWaypoint={selectWaypoint}
            focusRequest={focus}
            endpoint={{ title: trace.status.label, detail: [statusPlace, trace.status.at ? fmtDate(trace.status.at) : ''].filter(Boolean).join(' · '), locationId: trace.status.locationId }}
          >
            {step && (
              <EventCard
                step={step}
                analysis={analysis}
                db={db}
                siblings={siblings}
                onStep={(id) => setSelected(id)}
                onClose={() => {
                  setSelected(undefined);
                  setHlWp(undefined);
                }}
              />
            )}
          </TraceMap>
        </Suspense>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3>Journey by stage</h3>
            <span className="tiny muted">{trace.steps.length} recorded steps · open a stage to see each event</span>
          </div>
          <Timeline
            trace={trace}
            analysis={analysis}
            db={db}
            selectedStepId={selected}
            highlightWaypointId={hlWp}
            onFocusStage={(ids) => setFocus((f) => ({ ids, n: (f?.n ?? 0) + 1 }))}
            onSelect={(id) => {
              setSelected(id);
              setHlWp(trace.steps.find((s) => s.id === id)?.waypointId);
            }}
          />
        </div>
      </div>

      {restricted && (
        <div className="notice info small">
          <Lock size={16} style={{ flex: 'none' }} /> Your role sees lot codes, quantities and stages, a generalized origin, and no collector names, prices or exact collection boundaries.
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="row" style={{ gap: 8 }}>
            <GitBranch size={16} /> Genealogy — inputs and outputs
          </h3>
          <span className="tiny muted">Line width = kg. Hover a node to isolate its lineage; click to trace it.</span>
        </div>
        <div className="card-body">
          <Genealogy trace={trace} analysis={analysis} db={db} />
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3 className="row" style={{ gap: 8 }}>
              <ArrowLeftRight size={16} /> Transformations
            </h3>
          </div>
          <div className="card-body stack">
            {transforms.length === 0 && <div className="muted">No transformations in this direction.</div>}
            {transforms.map((e) => {
              const inSum = e.inputs.reduce((s, i) => s + i.qty, 0);
              const outSum = e.outputs.reduce((s, i) => s + i.qty, 0);
              return (
                <details key={e.id} style={{ borderLeft: '3px solid var(--line-strong)', paddingLeft: 12 }}>
                  <summary style={{ cursor: 'pointer' }}>
                    <b>{TRANSFORM_LABEL(e.kind)}</b> → {e.outputs.map((o) => o.lotId).join(', ')}{' '}
                    <span className="tiny muted">
                      · {e.inputs.length} inputs · {fmtEventTime(e.eventTime)} · {analysis.places.get(e.locationId)?.name.replace(/^DEMO /, '')}
                    </span>
                  </summary>
                  <table className="table" style={{ marginTop: 6 }}>
                    <tbody>
                      {e.inputs.map((i) => (
                        <tr key={'i' + i.lotId}>
                          <td style={{ width: 64 }}>
                            <span className="tag-in">INPUT</span>
                          </td>
                          <td>
                            <LotLink id={i.lotId} />
                          </td>
                          <td className="num">{fmtKg(i.qty)}</td>
                        </tr>
                      ))}
                      {e.outputs.map((o) => (
                        <tr key={'o' + o.lotId}>
                          <td>
                            <span className="tag-out">OUTPUT</span>
                          </td>
                          <td>
                            <LotLink id={o.lotId} />
                          </td>
                          <td className="num">
                            <b>{fmtKg(o.qty)}</b>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="tiny muted">{e.kind === 'aggregation' ? `Mass balance: ${fmtKg(inSum)} in = ${fmtKg(outSum)} out` : `Yield ${pct(outSum, inSum)}`}</div>
                </details>
              );
            })}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3>Validation findings</h3>
            </div>
            <div className="card-body">
              <FindingList findings={traceFindings} />
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="row" style={{ gap: 8 }}>
                <FileText size={16} /> Documents (demo)
              </h3>
            </div>
            <div className="card-body stack-sm">
              {docs.map((d) => (
                <div key={d.id} className="row-between">
                  <span>{d.title}</span>
                  <span className={`chip ${d.public ? 'chip-forest' : ''}`}>{d.public ? 'Customer-visible' : 'Internal'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {purchases.length > 0 && can.collectorPersonalData && (
        <details className="card">
          <summary className="card-head" style={{ cursor: 'pointer' }}>
            <h3>Source purchases — {purchases.length} lots (restricted)</h3>
            <span className="tiny muted">Collector names and prices: IT Admin and Auditor only; never on the customer page</span>
          </summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Lot ID</th>
                  <th>Collector</th>
                  <th>Collection area</th>
                  <th>Purchase date</th>
                  <th className="num">Quantity</th>
                  {can.prices && <th className="num">Demo price</th>}
                </tr>
              </thead>
              <tbody>
                {purchases.map((e) => {
                  if (e.type !== 'commission') return null;
                  const c = db.collectors.find((x) => x.id === e.collectorId);
                  const o = e.outputs[0];
                  return (
                    <tr key={e.id}>
                      <td>
                        <LotLink id={o.lotId} demo={e.demo} />
                      </td>
                      <td>{c?.name}</td>
                      <td>{analysis.places.get(e.locationId)?.name}</td>
                      <td>{fmtDate(e.purchaseDate)}</td>
                      <td className="num">
                        {fmtKg(o.qty)} {o.product}
                      </td>
                      {can.prices && <td className="num">{e.pricePerKg ? `${e.currency} ${(e.pricePerKg * o.qty).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function Header({ query, setQuery, lots, quick, current }: { query: string; setQuery: (s: string) => void; lots: string[]; quick: string[]; current?: string }) {
  return (
    <div className="page-head">
      <div>
        <h1>Trace explorer</h1>
        <p>Follow an SFCL or batch back to its source, or a source lot forward to everything made from it.</p>
      </div>
      <div className="stack-sm" style={{ minWidth: 280, flex: '0 1 460px' }}>
        <form
          className="row"
          style={{ flexWrap: 'nowrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) go(traceHref(query.trim()));
          }}
        >
          <input list="lot-ids" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. SFCL 26901 or LPO-90412" aria-label="Lot or batch identifier" />
          <datalist id="lot-ids">
            {lots.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <button className="btn btn-primary" type="submit">
            <Search size={15} /> Trace
          </button>
        </form>
        <div className="row" style={{ gap: 6 }}>
          {quick.map((q) => (
            <a key={q} className={`chip chip-btn ${q === current ? 'on' : 'chip-outline'}`} href={traceHref(q)}>
              {q}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
