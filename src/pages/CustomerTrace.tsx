import { Award, Download, FileText, MapPin, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { LIVE } from '../backend/config';
import { BrandMark, Wordmark } from '../components/Brand';
import { Genealogy } from '../components/Genealogy';
import { MARKER_META } from '../components/markers';
import { Timeline } from '../components/Timeline';
import { LotLink, MarkerGlyph } from '../components/ui';
import { PRODUCTS, type DemoDB, type Handoff } from '../data/types';
import { displayPlace, type MapMode } from '../domain/disclosure';
import { analyze, type Analysis } from '../domain/engine';
import { fmtDate, fmtDateRange, fmtEventTime, fmtKg } from '../domain/format';
import { downloadCsv, lineageCsv, traceEventsCsv } from '../domain/reports';
import { useStore } from '../domain/store';
import { STAGES, ancestors, buildTrace, stepTitle, type MarkerKind, type Step } from '../domain/trace';

/**
 * Customer trace page (public, read-only).
 *  full (default)        – the client sees the entire SFCL trace: every step, place, lot ID,
 *                          quantity and the genealogy.
 *  generalized / masked  – reduced views Commercial can choose per client.
 * Never shown in any mode: collector names, prices, internal notes, findings, user identities.
 */
const TraceMap = lazy(() => import('../components/TraceMap'));

/** Live mode: the page is public, so it gets a server-sanitised payload (never table access). */
function useLiveTrace(token: string) {
  const [state, setState] = useState<{ db?: DemoDB; handoff?: Handoff; error?: string; loading: boolean }>({ loading: LIVE });
  useEffect(() => {
    if (!LIVE) return;
    let alive = true;
    import('../backend/publicTrace')
      .then((m) => m.fetchPublicTrace(token))
      .then((r) => alive && setState({ ...r, loading: false }))
      .catch(() => alive && setState({ loading: false, error: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [token]);
  return state;
}

export function CustomerTrace({ token }: { token: string }) {
  const store = useStore();
  const live = useLiveTrace(token);
  const db = LIVE ? live.db : store.db;
  const handoff = LIVE ? live.handoff : store.db.handoffs.find((h) => h.token === token);
  const analysis = useMemo(() => (LIVE ? (db ? analyze(db) : null) : store.analysis), [db, store.analysis]);
  if (LIVE && live.loading) return <p className="empty" style={{ paddingTop: 100 }}>Loading trace…</p>;
  if (!db || !analysis || !handoff) return <NotFound live={LIVE} />;
  return <CustomerView db={db} analysis={analysis} handoff={handoff} />;
}

function NotFound({ live }: { live: boolean }) {
  return (
    <div className="cust">
      <ProtoBanner />
      <div className="auth-brand" style={{ marginTop: 28, marginBottom: 0 }}>
        <BrandMark size={28} />
        <Wordmark />
      </div>
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-body">
          <h2>Trace link not available</h2>
          <p className="muted" style={{ marginTop: 8 }}>
            {live
              ? 'This link is invalid, has expired or was revoked. Ask your Savannah Fruits contact for a current link.'
              : 'This prototype keeps its data only in the browser where it was created, so links created during a demo session open only in that same browser. The seeded sample link works on any device.'}
          </p>
        </div>
      </div>
    </div>
  );
}

const STAGE_ICON: Record<string, MarkerKind> = { origin: 'purchase', 'post-harvest': 'kernel', butter: 'butter', warehouse: 'aggregate', export: 'export', destination: 'arrival', refining: 'refine' };

function CustomerView({ db, analysis, handoff }: { db: DemoDB; analysis: Analysis; handoff: Handoff }) {
  const [selected, setSelected] = useState<string | undefined>();
  const [hlWp, setHlWp] = useState<string | undefined>();
  const full = handoff.disclosure === 'full';
  const mode: MapMode = handoff.disclosure === 'full' ? 'internal' : handoff.disclosure;
  const trace = useMemo(() => buildTrace(analysis, db, handoff.lotId, 'backward', handoff.locationId), [analysis, db, handoff]);
  if (!trace) return <NotFound live={false} />;

  const place = analysis.places.get(handoff.locationId)!;
  const endPlace = displayPlace(place, mode);
  const ready = analysis.byId.get(handoff.readyEventId);
  const purchases = trace.events.filter((e) => e.type === 'commission');
  const collectors = new Set(purchases.map((e) => (e.type === 'commission' ? e.collectorId : '')));
  const anc = ancestors(analysis, handoff.lotId);
  const sfcl = [handoff.lotId, ...anc].find((id) => analysis.lots.get(id)?.kind === 'sfcl');
  const lpos = [...anc].filter((id) => analysis.lots.get(id)?.kind === 'lpo');
  const exportStep = trace.steps.find((s) => s.kind === 'export' && analysis.places.get(s.locationId)?.kind === 'port');
  const docs = db.documents.filter((d) => d.public && (d.appliesTo === '*' || d.appliesTo.some((x) => trace.lotSet.has(x))));
  const step = trace.steps.find((s) => s.id === selected);
  const stageGroups = STAGES.map((st) => ({ ...st, steps: trace.steps.filter((s) => s.stage === st.id) })).filter((g) => g.steps.length);
  const safe = { pii: false, prices: false, internal: false };

  return (
    <div style={{ background: 'var(--paper)', minHeight: '100%' }}>
      <ProtoBanner />
      <div className="cust">
        <header className="cust-hero">
          <div className="cust-brand">
            <BrandMark size={24} tile={false} />
            <Wordmark reversed />
            <span className="cust-issuer">Savannah Fruits Company</span>
          </div>
          <div className="eyebrow">Traceability record · ready for pickup</div>
          <h1 style={{ marginTop: 8 }}>{PRODUCTS[handoff.product]}</h1>
          <p style={{ marginTop: 6, color: '#d9e4dc' }}>
            <span className="mono" style={{ color: '#fff' }}>{handoff.lotId}</span> · {fmtKg(handoff.qty)}
            {sfcl && sfcl !== handoff.lotId && (
              <>
                {' '}
                · from export batch <span className="mono" style={{ color: '#fff' }}>{sfcl}</span>
              </>
            )}{' '}
            · prepared for {handoff.clientName}
          </p>
          <div className="cust-facts">
            <div>
              <div className="l">Origin</div>
              <div className="v">{trace.areaIds.length} forest-reserve areas</div>
              <div className="s">Northern Ghana{full ? '' : ' (generalised)'}</div>
            </div>
            <div>
              <div className="l">Collected</div>
              <div className="v">{purchases.length ? fmtDateRange(purchases[0].eventTime, purchases.at(-1)!.eventTime) : '—'}</div>
              <div className="s">
                {purchases.length} lots · {collectors.size} registered collectors
              </div>
            </div>
            <div>
              <div className="l">Processed</div>
              <div className="v">{lpos.length} butter batches</div>
              <div className="s">{sfcl ? `aggregated into ${sfcl}` : ''}</div>
            </div>
            <div>
              <div className="l">Exported</div>
              <div className="v">{exportStep ? fmtDate(exportStep.start) : '—'}</div>
              <div className="s">via Tema Port</div>
            </div>
            <div>
              <div className="l">Ready for pickup</div>
              <div className="v">{ready ? fmtDate(ready.eventTime) : '—'}</div>
              <div className="s">{endPlace.name.replace(/^DEMO /, '')}</div>
            </div>
          </div>
        </header>

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => downloadCsv(traceEventsCsv(trace, analysis, db, safe))}>
            <Download size={15} /> Download trace (CSV)
          </button>
          {full && (
            <button className="btn" onClick={() => downloadCsv(lineageCsv(trace, analysis))}>
              <Download size={15} /> Download lineage (CSV)
            </button>
          )}
        </div>

        <section className="cust-section">
          <div className="cust-grid">
            <Suspense fallback={<div className="map-loading">Loading map…</div>}>
              <TraceMap
                trace={trace}
                db={db}
                analysis={analysis}
                mode={mode}
                selectedStepId={selected}
                highlightWaypointId={hlWp}
                onSelectWaypoint={(wp) => {
                  setHlWp(wp);
                  setSelected(trace.waypoints.find((w) => w.id === wp)?.stepIds[0]);
                }}
                endpoint={{ title: 'Ready for pickup', detail: endPlace.name, locationId: handoff.locationId }}
              >
                {step && <CustomerEventCard step={step} mode={mode} analysis={analysis} db={db} full={full} onClose={() => setSelected(undefined)} />}
              </TraceMap>
            </Suspense>
            <div className="panel">
              <div className="panel-head">
                <h2>Journey</h2>
                <span className="meta">{full ? `${trace.steps.length} recorded steps` : 'Summary by stage'}</span>
              </div>
              {full ? (
                <Timeline
                  trace={trace}
                  analysis={analysis}
                  db={db}
                  selectedStepId={selected}
                  highlightWaypointId={hlWp}
                  onSelect={(id) => {
                    setSelected(id);
                    setHlWp(trace.steps.find((s) => s.id === id)?.waypointId);
                  }}
                />
              ) : (
                <div style={{ padding: '0 16px' }}>
                  {stageGroups.map((g) => {
                    const kinds = [...new Set(g.steps.map((s) => s.kind))];
                    const places = [...new Set(g.steps.map((s) => displayPlace(analysis.places.get(s.locationId)!, mode).name))];
                    return (
                      <div key={g.id} className="cust-step">
                        <MarkerGlyph kind={kinds.includes('ready') ? 'ready' : STAGE_ICON[g.id]} size={26} />
                        <div>
                          <div className="strong">{g.publicLabel}</div>
                          <div className="small muted">
                            {fmtDateRange(g.steps[0].start, g.steps.at(-1)!.end)} · {g.id === 'origin' ? `${trace.areaIds.length} collection areas, northern Ghana` : places.join(' · ')}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Lines on the map join recorded custody locations in order; they are not transport routes.
            {full ? '' : ' Locations are generalised to protect sourcing sites.'}
          </p>
        </section>

        {full && (
          <section className="cust-section">
            <div className="panel">
              <div className="panel-head">
                <h2>Genealogy</h2>
                <span className="meta">Every purchase, kernel batch and butter batch that went into {handoff.lotId}. Line width shows kilograms.</span>
              </div>
              <div className="panel-body">
                <Genealogy trace={trace} analysis={analysis} db={db} readOnly />
              </div>
            </div>
          </section>
        )}

        <section className="cust-section">
          <div className="panel">
            <div className="panel-head">
              <h2>Certificates and documents</h2>
            </div>
            <table className="table">
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td style={{ width: 28 }}>{d.kind === 'certificate' ? <Award size={16} /> : <FileText size={16} />}</td>
                    <td>{d.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="tiny muted" style={{ marginTop: 24 }}>
          Issued by Savannah Fruits Company Limited through Savannah Trace. Collector names and commercial terms are never shown.
          {!LIVE && ' This demonstration uses fictional data and the local link has no production security.'}
        </p>
      </div>
    </div>
  );
}

function CustomerEventCard({ step, mode, analysis, db, full, onClose }: { step: Step; mode: MapMode; analysis: Analysis; db: DemoDB; full: boolean; onClose: () => void }) {
  const p = displayPlace(analysis.places.get(step.locationId)!, mode);
  return (
    <div className="event-card">
      <div className="event-card-head">
        <MarkerGlyph kind={step.kind} size={24} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tiny muted">{MARKER_META[step.kind].label}</div>
          <div className="strong">{full ? stepTitle(step, analysis, db) : STAGES.find((s) => s.id === step.stage)?.publicLabel}</div>
        </div>
        <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="event-card-body">
        <dl>
          <dt>When</dt>
          <dd>{step.events.length > 1 ? fmtDateRange(step.start, step.end) : full ? fmtEventTime(step.start) : fmtDate(step.start)}</dd>
          <dt>Where</dt>
          <dd>
            <MapPin size={12} style={{ verticalAlign: -1 }} /> {p.name.replace(/^DEMO /, '')}
            {p.approximate && ' (approximate)'}
          </dd>
        </dl>
        {full && (
          <>
            <hr className="sep" />
            {step.lines.slice(0, 12).map((l, i) => (
              <div key={i} className="row-between">
                <span>
                  {l.role === 'in' && <span className="tag-in">IN </span>}
                  {l.role === 'out' && <span className="tag-out">OUT </span>}
                  <span className="id">{l.lotId}</span>
                </span>
                <span className="mono">{fmtKg(l.qty)}</span>
              </div>
            ))}
            {step.lines.length > 12 && <div className="tiny muted">+ {step.lines.length - 12} more lines in the CSV</div>}
          </>
        )}
      </div>
    </div>
  );
}

function ProtoBanner() {
  if (LIVE) return null;
  return (
    <div className="demo-strip">
      <strong>PROTOTYPE</strong> Local demo link · fictional data · no production security
    </div>
  );
}

// keep LotLink referenced for future linking of lot IDs within the public page
void LotLink;
