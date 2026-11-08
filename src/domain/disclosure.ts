// How much geography a viewer may see.
//  internal    – authorised staff: exact demo polygons and facility points.
//  generalized – customer default: collection areas become a ~30 km circle around
//                a rounded centre; domestic facilities are rounded to ~0.25°.
//  masked      – no collection-area shape at all; origin and facilities rounded
//                to ~1° / 0.5° and labelled at regional level only.
// Public places (ports) are always shown as-is.

import type { CollectionArea } from '../data/types';
import { areaCentroid, type Place } from './engine';

export type MapMode = 'internal' | 'generalized' | 'masked';

export const MODE_LABEL: Record<MapMode, string> = {
  internal: 'Exact places and boundaries',
  generalized: 'Generalised origin (client option)',
  masked: 'Masked coordinates (client option)',
};

const round = (v: number, step: number) => Math.round(v / step) * step;

export interface DisplayPlace {
  id: string;
  lat: number;
  lng: number;
  name: string;
  approximate: boolean;
}

export function displayPlace(p: Place, mode: MapMode): DisplayPlace {
  if (mode === 'internal' || p.publicPlace) return { id: p.id, lat: p.lat, lng: p.lng, name: p.name, approximate: false };
  const step = mode === 'generalized' ? 0.25 : p.kind === 'collection-area' ? 1 : 0.5;
  return { id: p.id, lat: round(p.lat, step), lng: round(p.lng, step), name: p.publicLabel, approximate: true };
}

export function circlePolygon(lat: number, lng: number, radiusKm: number, steps = 48): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

/** Geometry to draw for a collection area in a given mode (null = do not draw a shape). */
export function displayArea(a: CollectionArea, mode: MapMode): { polygon: [number, number][]; label: string; generalized: boolean } | null {
  if (mode === 'internal') return { polygon: a.polygon, label: a.name, generalized: false };
  if (mode === 'masked') return null;
  const [lng, lat] = areaCentroid(a);
  return { polygon: circlePolygon(round(lat, 0.25), round(lng, 0.25), 30), label: 'Certified forest-reserve area (generalized)', generalized: true };
}
