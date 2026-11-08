import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DemoDB } from '../data/types';
import type { Analysis } from '../domain/engine';
import { fmtEventTime, fmtKg, fmtRecorded } from '../domain/format';
import { ROLES } from '../domain/roles';
import { STAGES, stepTitle, type Step } from '../domain/trace';
import { MARKER_META } from './markers';
import { DemoBadge, FindingList, LotLink, MarkerGlyph } from './ui';

/** Internal (staff) event card: full detail incl. quantities, references, evidence, findings. */
export function EventCard({
  step,
  analysis,
  db,
  onClose,
  siblings,
  onStep,
}: {
  step: Step;
  analysis: Analysis;
  db: DemoDB;
  onClose: () => void;
  siblings: Step[];
  onStep: (id: string) => void;
}) {
  const place = analysis.places.get(step.locationId);
  const idx = siblings.findIndex((s) => s.id === step.id);
  const findings = analysis.findings.filter((f) => step.events.some((e) => e.id === f.eventId));
  const evidence = [...new Set(step.events.flatMap((e) => e.evidence ?? []))];
  const first = step.events[0];
  const lines = step.lines;
  const shown = lines.slice(0, 14);
  const exp = first.type === 'ship' ? first.exportDetails : undefined;
  const group = step.groupId ? db.groups.find((g) => g.id === step.groupId) : undefined;
  const demo = step.events.some((e) => e.demo);

  return (
    <div className="event-card" role="region" aria-label="Selected event details">
      <div className="event-card-head">
        <MarkerGlyph kind={step.kind} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {MARKER_META[step.kind].label}
          </div>
          <div style={{ fontWeight: 650, lineHeight: 1.3 }}>{stepTitle(step, analysis, db)}</div>
        </div>
        <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="Close event card">
          <X size={14} />
        </button>
      </div>
      <div className="event-card-body">
        <dl>
          <dt>Event time</dt>
          <dd>
            {step.events.length > 1 ? (
              <>
                {fmtEventTime(step.start)} → {fmtEventTime(step.end)} <span className="muted">({step.events.length} events)</span>
              </>
            ) : (
              fmtEventTime(step.start)
            )}
            {demo && (
              <div className="tiny" style={{ color: 'var(--amber-ink)' }}>
                Demo timestamp — illustrative, not a real record.
              </div>
            )}
          </dd>
          <dt>Recorded</dt>
          <dd>
            {fmtRecorded(first.recordedAt)} by {ROLES[first.recordedBy].label}
            {first.version > 1 && <span className="chip chip-amber" style={{ marginLeft: 6 }}>v{first.version} · corrected</span>}
          </dd>
          <dt>Place</dt>
          <dd>
            {place?.name ?? step.locationId}
            <DemoBadge show={!!place?.demo && !place.publicPlace} title="Fictional facility / coordinates" />
            {step.fromId && step.kind !== 'ship' && step.kind !== 'export' && <div className="muted tiny">from {analysis.places.get(step.fromId)?.name}</div>}
            {step.toId && <div className="muted tiny">to {analysis.places.get(step.toId)?.name}</div>}
          </dd>
          <dt>Stage</dt>
          <dd>{STAGES.find((s) => s.id === step.stage)?.label}</dd>
          {group && (
            <>
              <dt>Group</dt>
              <dd>
                {group.name} · {group.members} members (demo)
              </dd>
            </>
          )}
          {exp && (exp.containerNo || exp.vessel || exp.orderRef) && (
            <>
              <dt>Shipment</dt>
              <dd>
                {[exp.containerNo && `Container ${exp.containerNo}`, exp.vessel, exp.eta && `ETA ${exp.eta}`, exp.clientName, exp.orderRef].filter(Boolean).join(' · ')}
              </dd>
            </>
          )}
        </dl>
        <hr className="sep" />
        <div className="stack-sm">
          {shown.map((l, i) => (
            <div key={i} className="row-between" style={{ gap: 6 }}>
              <span className="row" style={{ gap: 6 }}>
                {l.role === 'in' && <span className="tag-in">IN</span>}
                {l.role === 'out' && <span className="tag-out">OUT</span>}
                <LotLink id={l.lotId} />
              </span>
              <span className="nowrap">
                {fmtKg(l.qty)} <span className="muted">{l.product}</span>
              </span>
            </div>
          ))}
          {lines.length > shown.length && <div className="muted tiny">+ {lines.length - shown.length} more lines</div>}
        </div>
        {first.notes && (
          <>
            <hr className="sep" />
            <div className="small">{first.notes}</div>
          </>
        )}
        {evidence.length > 0 && (
          <>
            <hr className="sep" />
            <div className="tiny muted" style={{ fontWeight: 700 }}>
              EVIDENCE (DEMO)
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {evidence.slice(0, 4).map((x) => (
                <li key={x}>{x}</li>
              ))}
              {evidence.length > 4 && <li className="muted">+ {evidence.length - 4} more</li>}
            </ul>
          </>
        )}
        {findings.length > 0 && (
          <>
            <hr className="sep" />
            <FindingList findings={findings} />
          </>
        )}
      </div>
      {siblings.length > 1 && (
        <div className="row-between" style={{ padding: '6px 10px', borderTop: '1px solid var(--line)' }}>
          <button className="btn btn-sm btn-ghost" disabled={idx <= 0} onClick={() => onStep(siblings[idx - 1].id)}>
            <ChevronLeft size={14} /> Previous
          </button>
          <span className="tiny muted">
            Step {idx + 1} of {siblings.length}
          </span>
          <button className="btn btn-sm btn-ghost" disabled={idx >= siblings.length - 1} onClick={() => onStep(siblings[idx + 1].id)}>
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
