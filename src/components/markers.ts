// One visual vocabulary for every event type: unique SHAPE + icon + text label,
// with colour only as a secondary cue. Used by the map, legend and timeline.

import {
  createElement,
  FlaskConical,
  Funnel,
  Handshake,
  Inbox,
  Merge,
  Nut,
  Droplet,
  ShieldCheck,
  Ship,
  ShoppingBasket,
  Truck,
  Users,
  Warehouse,
  type IconNode,
} from 'lucide';
import type { MarkerKind } from '../domain/trace';

type Shape = 'circle' | 'square' | 'diamond' | 'hexagon' | 'funnel' | 'tag' | 'pill' | 'hull' | 'house' | 'drop' | 'octagon' | 'shield' | 'star';

export interface MarkerMeta {
  label: string;
  short: string;
  shape: Shape;
  color: string;
  icon: IconNode;
  gx?: number; // glyph centre (% of box)
  gy?: number;
}

export const MARKER_META: Record<MarkerKind, MarkerMeta> = {
  purchase: { label: 'Purchase / collection', short: 'Purchase', shape: 'circle', color: '#8a5a2b', icon: ShoppingBasket },
  ship: { label: 'Ship (domestic)', short: 'Ship', shape: 'tag', color: '#4a4c43', icon: Truck, gx: 44 },
  receive: { label: 'Receive', short: 'Receive', shape: 'square', color: '#3b5d6c', icon: Inbox },
  issue: { label: 'Issue to processing group', short: 'Issue', shape: 'pill', color: '#66793a', icon: Users },
  kernel: { label: 'Transform OFN → ODK', short: 'OFN→ODK', shape: 'diamond', color: '#b7821c', icon: Nut },
  butter: { label: 'Transform ODK → OSB (LPO)', short: 'ODK→OSB', shape: 'hexagon', color: '#2d6a4a', icon: Droplet },
  aggregate: { label: 'SFCL aggregation (Transform)', short: 'SFCL', shape: 'funnel', color: '#173a29', icon: Merge, gy: 38 },
  export: { label: 'Export movement', short: 'Export', shape: 'hull', color: '#24485a', icon: Ship, gy: 57 },
  arrival: { label: 'Arrival / warehouse receipt', short: 'Arrival', shape: 'house', color: '#3b6f80', icon: Warehouse, gy: 62 },
  refine: { label: 'Refining', short: 'Refine', shape: 'drop', color: '#2f6f73', icon: FlaskConical, gy: 64 },
  filter: { label: 'Filtering', short: 'Filter', shape: 'octagon', color: '#4f6b8a', icon: Funnel },
  ready: { label: 'Arrived & ready for pickup', short: 'Ready', shape: 'shield', color: '#c4851a', icon: ShieldCheck, gy: 48 },
  delivery: { label: 'Customer delivery', short: 'Delivered', shape: 'star', color: '#8a3b2a', icon: Handshake, gy: 56 },
};

export const MARKER_ORDER: MarkerKind[] = ['purchase', 'ship', 'receive', 'kernel', 'issue', 'butter', 'aggregate', 'export', 'arrival', 'refine', 'filter', 'ready', 'delivery'];

const SHAPES: Record<Shape, string> = {
  circle: '<circle cx="20" cy="20" r="17"/>',
  square: '<rect x="4" y="4" width="32" height="32" rx="3"/>',
  diamond: '<polygon points="20,1.5 38.5,20 20,38.5 1.5,20"/>',
  hexagon: '<polygon points="20,1.5 36.5,11 36.5,29 20,38.5 3.5,29 3.5,11"/>',
  funnel: '<polygon points="1.5,4 38.5,4 20,38"/>',
  tag: '<polygon points="2,7 27,7 38.5,20 27,33 2,33"/>',
  pill: '<rect x="1.5" y="8" width="37" height="24" rx="12"/>',
  hull: '<polygon points="1.5,11 38.5,11 31,35 9,35"/>',
  house: '<polygon points="20,1.5 38.5,16 38.5,38 1.5,38 1.5,16"/>',
  drop: '<path d="M20 1.5 C27 11 35 18 35 26 A15 13 0 0 1 5 26 C5 18 13 11 20 1.5Z"/>',
  octagon: '<polygon points="12.5,1.5 27.5,1.5 38.5,12.5 38.5,27.5 27.5,38.5 12.5,38.5 1.5,27.5 1.5,12.5"/>',
  shield: '<path d="M20 1.5 L36.5 7.5 V19 C36.5 29 29 35.5 20 38.5 C11 35.5 3.5 29 3.5 19 V7.5 Z"/>',
  star: '<polygon points="20,1 25.2,14 39,14.4 28,23 32.2,37.5 20,29.2 7.8,37.5 12,23 1,14.4 14.8,14"/>',
};

const iconCache = new Map<string, string>();
function iconHtml(kind: MarkerKind, px: number) {
  const k = `${kind}|${px}`;
  if (!iconCache.has(k)) {
    const el = createElement(MARKER_META[kind].icon, { width: px, height: px, stroke: '#fff', 'stroke-width': 2.4 });
    iconCache.set(k, el.outerHTML);
  }
  return iconCache.get(k)!;
}

/** HTML for a marker glyph (shape + icon). Used in DOM markers and in React via innerHTML. */
export function markerGlyphHtml(kind: MarkerKind, size = 30) {
  const m = MARKER_META[kind];
  const icon = Math.round(size * (m.shape === 'star' || m.shape === 'funnel' ? 0.36 : 0.46));
  return `<span class="mk-shape" style="width:${size}px;height:${size}px"><svg class="shape" viewBox="0 0 40 40" aria-hidden="true"><g fill="${m.color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round">${SHAPES[m.shape]}</g></svg><span style="position:absolute;left:${m.gx ?? 50}%;top:${m.gy ?? 50}%;transform:translate(-50%,-50%);display:flex">${iconHtml(kind, icon)}</span></span>`;
}

export const PRODUCT_COLOR: Record<string, string> = {
  OFN: '#8a5a2b',
  ODK: '#b7821c',
  OSB: '#2d6a4a',
  ORSB: '#2f6f73',
  OFSB: '#4f6b8a',
  'OFSB-FFL': '#4f6b8a',
};
