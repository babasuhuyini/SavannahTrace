import { useMemo, useState } from 'react';
import type { DemoDB } from '../data/types';
import type { Analysis, LotKind } from '../domain/engine';
import { fmtKg, fmtShortDate } from '../domain/format';
import type { Trace } from '../domain/trace';
import { go, traceHref } from '../router';
import { PRODUCT_COLOR } from './markers';

const COLS: { kinds: LotKind[]; label: string }[] = [
  { kinds: ['purchase'], label: 'Purchases (area · date)' },
  { kinds: ['kernel-batch'], label: 'ODK batches (PHC)' },
  { kinds: ['lpo'], label: 'LPO crude butter' },
  { kinds: ['sfcl'], label: 'SFCL export batch' },
  { kinds: ['refined', 'filtered'], label: 'Refined / filtered' },
];

interface GNode {
  id: string;
  col: number;
  title: string;
  sub: string;
  product: string;
  lotIds: string[];
  qty: number;
  target: boolean;
}

/** Input → output genealogy (merges and splits) as a column graph. */
export function Genealogy({ trace, analysis, db, readOnly }: { trace: Trace; analysis: Analysis; db: DemoDB; readOnly?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);

  const graph = useMemo(() => {
    const nodeOf = new Map<string, string>(); // lotId → node id
    const nodes = new Map<string, GNode>();
    for (const lotId of trace.lotSet) {
      const lot = analysis.lots.get(lotId);
      if (!lot) continue;
      const col = COLS.findIndex((c) => c.kinds.includes(lot.kind));
      if (lot.kind === 'purchase') {
        const area = db.collectionAreas.find((a) => a.id === lot.collectionAreaId);
        const date = analysis.byId.get(lot.createdBy);
        const pd = date && date.type === 'commission' ? date.purchaseDate : lot.createdAt.slice(0, 10);
        const id = `grp|${lot.collectionAreaId}|${pd}`;
        let n = nodes.get(id);
        if (!n) nodes.set(id, (n = { id, col, title: `${(area?.name ?? '').replace('DEMO ', '').replace(' Forest Reserve', '')} · ${fmtShortDate(pd)}`, sub: '', product: lot.product, lotIds: [], qty: 0, target: false }));
        n.lotIds.push(lotId);
        n.qty += lot.createdQty;
        n.target ||= lotId === trace.target.lotId;
        nodeOf.set(lotId, id);
      } else {
        nodes.set(lotId, { id: lotId, col, title: lotId, sub: '', product: lot.product, lotIds: [lotId], qty: lot.createdQty, target: lotId === trace.target.lotId });
        nodeOf.set(lotId, lotId);
      }
    }
    for (const n of nodes.values()) {
      n.sub = n.id.startsWith('grp|') ? `${n.lotIds.length} lot${n.lotIds.length > 1 ? 's' : ''} · ${fmtKg(n.qty)} ${n.product}` : `${n.product} · ${fmtKg(n.qty)}`;
    }
    const edges = new Map<string, { from: string; to: string; qty: number; product: string }>();
    for (const lotId of trace.lotSet) {
      const lot = analysis.lots.get(lotId);
      if (!lot) continue;
      for (const p of lot.parents) {
        const from = nodeOf.get(p.lotId);
        const to = nodeOf.get(lotId);
        if (!from || !to) continue;
        const k = `${from}→${to}`;
        const e = edges.get(k) ?? { from, to, qty: 0, product: analysis.lots.get(p.lotId)?.product ?? 'OSB' };
        e.qty += p.qty;
        edges.set(k, e);
      }
    }
    // layout
    const usedCols = [...new Set([...nodes.values()].map((n) => n.col))].sort();
    const colX = new Map(usedCols.map((c, i) => [c, i]));
    const byCol = usedCols.map((c) => [...nodes.values()].filter((n) => n.col === c).sort((a, b) => a.title.localeCompare(b.title)));
    const NODE_H = 44;
    const GAP = 10;
    const COL_W = 200;
    const NODE_W = 174;
    const height = Math.max(...byCol.map((c) => c.length * (NODE_H + GAP))) + 40;
    const pos = new Map<string, { x: number; y: number }>();
    byCol.forEach((col, ci) => {
      const total = col.length * (NODE_H + GAP) - GAP;
      const top = 36 + (height - 40 - total) / 2;
      col.forEach((n, i) => pos.set(n.id, { x: ci * COL_W + 8, y: top + i * (NODE_H + GAP) }));
    });
    return { nodes: [...nodes.values()], edges: [...edges.values()], pos, width: usedCols.length * COL_W, height, usedCols, colX, NODE_H, NODE_W, COL_W };
  }, [trace, analysis, db]);

  const connected = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    const walk = (dir: 'up' | 'down') => {
      let frontier = [hover];
      while (frontier.length) {
        const next: string[] = [];
        for (const id of frontier)
          for (const e of graph.edges) {
            const [a, b] = dir === 'up' ? [e.to, e.from] : [e.from, e.to];
            if (a === id && !set.has(b)) set.add(b), next.push(b);
          }
        frontier = next;
      }
    };
    walk('up');
    walk('down');
    return set;
  }, [hover, graph]);

  const maxQ = Math.max(1, ...graph.edges.map((e) => e.qty));
  const { pos, NODE_H, NODE_W } = graph;

  return (
    <div className="geneo">
      <svg width={Math.max(graph.width, 300)} height={graph.height} role="img" aria-label="Genealogy graph of inputs and outputs">
        {graph.usedCols.map((c, i) => (
          <text key={c} x={i * graph.COL_W + 8} y={18} fontSize={11} fontWeight={700} fill="#74725f" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {COLS[c].label}
          </text>
        ))}
        {graph.edges.map((e) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const on = !connected || (connected.has(e.from) && connected.has(e.to));
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={PRODUCT_COLOR[e.product]}
              strokeOpacity={on ? 0.5 : 0.08}
              strokeWidth={1.5 + 9 * Math.sqrt(e.qty / maxQ)}
            >
              <title>
                {e.from.startsWith('grp|') ? 'Purchase group' : e.from} → {e.to}: {fmtKg(e.qty)}
              </title>
            </path>
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const on = !connected || connected.has(n.id);
          const clickable = !readOnly && (!n.id.startsWith('grp|') || n.lotIds.length === 1);
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              opacity={on ? 1 : 0.3}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => clickable && go(traceHref(n.lotIds[0]))}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <rect width={NODE_W} height={NODE_H} rx={2} fill={n.target ? '#f0ece2' : '#ffffff'} stroke={n.target ? '#16191a' : '#d2cbbb'} strokeWidth={n.target ? 2 : 1} />
              <rect width={4} height={NODE_H} rx={0} fill={PRODUCT_COLOR[n.product]} />
              <text x={12} y={18} fontSize={11} fontWeight={600} fill="#173a29" fontFamily="'IBM Plex Mono', ui-monospace, Consolas, monospace">
                {n.title.length > 24 ? n.title.slice(0, 23) + '…' : n.title}
              </text>
              <text x={13} y={34} fontSize={11} fill="#74725f">
                {n.sub}
              </text>
              <title>{n.id.startsWith('grp|') ? n.lotIds.join('\n') : n.title}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
