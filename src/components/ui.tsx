import { AlertOctagon, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { RULES, type Finding, type Severity } from '../domain/engine';
import type { MarkerKind } from '../domain/trace';
import { traceHref } from '../router';
import { MARKER_META, markerGlyphHtml } from './markers';

export const DemoBadge = ({ show = true, title = 'Fictional demo record' }: { show?: boolean; title?: string }) =>
  show ? (
    <span className="demo-badge" title={title}>
      DEMO
    </span>
  ) : null;

export function LotLink({ id, demo }: { id: string; demo?: boolean }) {
  return (
    <a className="id" href={traceHref(id)} title="Open in Trace explorer">
      {id}
      <DemoBadge show={!!demo} />
    </a>
  );
}

export const SevIcon = ({ s, size = 16 }: { s: Severity; size?: number }) =>
  s === 'blocking' ? <AlertOctagon size={size} /> : s === 'review' ? <AlertTriangle size={size} /> : <Info size={size} />;

export const SEV_LABEL: Record<Severity, string> = { blocking: 'Blocking', review: 'Needs review', info: 'Information' };

export function FindingList({ findings, empty, onSelect }: { findings: Finding[]; empty?: ReactNode; onSelect?: (f: Finding) => void }) {
  if (!findings.length)
    return empty === undefined ? (
      <div className="ok-box">
        <CheckCircle2 size={16} /> No validation findings.
      </div>
    ) : (
      <>{empty}</>
    );
  const order: Severity[] = ['blocking', 'review', 'info'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return (
    <div>
      {sorted.map((f) => (
        <div
          key={f.key}
          className={`finding ${f.severity}`}
          role={onSelect ? 'button' : undefined}
          style={onSelect ? { cursor: 'pointer' } : undefined}
          onClick={onSelect ? () => onSelect(f) : undefined}
        >
          <SevIcon s={f.severity} />
          <div>
            <div className="rule">
              {SEV_LABEL[f.severity]} · {RULES[f.rule]}
            </div>
            <div>{f.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MarkerGlyph({ kind, size = 22 }: { kind: MarkerKind; size?: number }) {
  return <span style={{ display: 'inline-flex' }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markerGlyphHtml(kind, size) }} />;
}

export function KindLabel({ kind, size = 20 }: { kind: MarkerKind; size?: number }) {
  return (
    <span className="legend-item">
      <MarkerGlyph kind={kind} size={size} />
      {MARKER_META[kind].label}
    </span>
  );
}

export function Field({ label, hint, children, span }: { label: ReactNode; hint?: ReactNode; children: ReactNode; span?: number }) {
  return (
    <label className="field" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <span>
        {label} {hint && <span className="hint">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Drawer({ title, subtitle, onClose, children, icon }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; icon?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          {icon}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 19 }}>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay modal-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="card-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const cls = value > max ? 'over' : value === max ? 'exact' : '';
  return (
    <div>
      <div className={`meter ${cls}`} role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
        <div style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)} aria-pressed={o.v === value}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
