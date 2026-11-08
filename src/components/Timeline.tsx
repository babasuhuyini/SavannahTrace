import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DemoDB } from '../data/types';
import type { Analysis } from '../domain/engine';
import { fmtDateRange, fmtEventTime, fmtKg } from '../domain/format';
import { STAGES, stageSummary, stepTitle, sumBy, type StageId, type Step, type Trace } from '../domain/trace';
import { MarkerGlyph } from './ui';

export function stepQtySummary(s: Step) {
  const ins = s.lines.filter((l) => l.role === 'in');
  const outs = s.lines.filter((l) => l.role === 'out');
  const items = s.lines.filter((l) => l.role === 'item');
  const prod = (ls: typeof s.lines) => [...new Set(ls.map((l) => l.product))].join('/');
  if (ins.length) return `${fmtKg(sumBy(ins))} ${prod(ins)} in → ${fmtKg(sumBy(outs))} ${prod(outs)} out`;
  if (outs.length) return `${outs.length} lot${outs.length > 1 ? 's' : ''} · ${fmtKg(sumBy(outs))} ${prod(outs)}`;
  return `${items.length} lot${items.length > 1 ? 's' : ''} · ${fmtKg(sumBy(items))} ${prod(items)}`;
}

const STAGE_ICON: Record<StageId, Step['kind']> = {
  origin: 'purchase',
  'post-harvest': 'kernel',
  butter: 'butter',
  warehouse: 'aggregate',
  export: 'export',
  destination: 'arrival',
  refining: 'refine',
};

/**
 * Journey grouped into named stages. Stages start collapsed as a one-line summary
 * ("36 purchases across 3 collection areas"); expanding shows every underlying step,
 * so nothing in the genealogy is hidden — only summarised.
 */
export function Timeline({
  trace,
  analysis,
  db,
  selectedStepId,
  highlightWaypointId,
  onSelect,
  onFocusStage,
}: {
  trace: Trace;
  analysis: Analysis;
  db: DemoDB;
  selectedStepId?: string;
  highlightWaypointId?: string;
  onSelect: (stepId: string) => void;
  onFocusStage?: (locationIds: string[]) => void;
}) {
  const [open, setOpen] = useState<Partial<Record<StageId, boolean>>>({});
  const ref = useRef<HTMLDivElement>(null);
  const byStage = useMemo(
    () =>
      STAGES.map((st) => {
        const steps = trace.steps.filter((s) => s.stage === st.id);
        return { ...st, steps, summary: steps.length ? stageSummary(st.id, steps, analysis) : '' };
      }).filter((g) => g.steps.length),
    [trace, analysis],
  );

  useEffect(() => setOpen({}), [trace]);

  // selecting a step elsewhere (e.g. a map marker) opens its stage and scrolls to it
  useEffect(() => {
    const s = trace.steps.find((x) => x.id === selectedStepId);
    if (!s) return;
    if (!open[s.stage]) setOpen((o) => ({ ...o, [s.stage]: true }));
    requestAnimationFrame(() => (ref.current?.querySelector(`[data-step="${selectedStepId}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStepId]);

  const hlStage = trace.steps.find((s) => s.waypointId === highlightWaypointId)?.stage;

  return (
    <div className="timeline" ref={ref}>
      {byStage.map((g, i) => {
        const isOpen = !!open[g.id];
        return (
          <section key={g.id} className={`tl-stage ${isOpen ? 'open' : ''} ${hlStage === g.id ? 'hl' : ''}`}>
            <button
              className="tl-stage-head"
              onClick={() => {
                setOpen((o) => ({ ...o, [g.id]: !isOpen }));
                if (!isOpen) onFocusStage?.([...new Set(g.steps.flatMap((s) => [s.locationId, ...(s.toId ? [s.toId] : [])]))]);
              }}
              aria-expanded={isOpen}
            >
              <span className="tl-num">{i + 1}</span>
              <MarkerGlyph kind={STAGE_ICON[g.id]} size={22} />
              <span className="tl-stage-text">
                <span className="tl-stage-name">{g.label}</span>
                <span className="tl-stage-sum">
                  {g.summary} · {fmtDateRange(g.steps[0].start, g.steps.at(-1)!.end)}
                </span>
              </span>
              <span className="tl-count">{g.steps.length}</span>
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {isOpen &&
              g.steps.map((s) => {
                const sel = s.id === selectedStepId;
                const hl = !sel && s.waypointId === highlightWaypointId;
                return (
                  <button key={s.id} data-step={s.id} className={`tl-item ${sel ? 'sel' : ''} ${hl ? 'hl' : ''}`} onClick={() => onSelect(s.id)} aria-current={sel ? 'step' : undefined}>
                    <MarkerGlyph kind={s.kind} size={20} />
                    <span>
                      <span className="t">{stepTitle(s, analysis, db)}</span>
                      <span className="m">
                        {s.events.length > 1 ? fmtDateRange(s.start, s.end) : fmtEventTime(s.start)} · {stepQtySummary(s)}
                      </span>
                    </span>
                  </button>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}
