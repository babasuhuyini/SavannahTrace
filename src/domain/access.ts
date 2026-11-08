// Visibility rules for demo mode. These deliberately mirror the RLS policies in
// supabase/migrations (private.event_visible / lot_visible) so the demo shows
// the same per-role, per-location experience the database will enforce.

import type { AppUser, DemoDB, Handoff, TraceEvent } from '../data/types';
import type { Analysis, Finding } from './engine';
import { ROLES } from './roles';

export interface Viewer {
  user: AppUser;
  locations: Set<string>;
}

export const viewerOf = (user: AppUser): Viewer => ({ user, locations: new Set(user.locationIds) });

export function eventVisible(v: Viewer, e: TraceEvent): boolean {
  const role = v.user.role;
  if (v.user.status !== 'active') return false;
  if (role === 'it-admin') return true;
  if (role === 'commercial') return false;
  const L = v.locations;
  if (role === 'auditor') return L.has(e.locationId) || (e.type === 'ship' && L.has(e.toId));
  if (e.actorId === v.user.id) return true; // own entries
  if (L.has(e.locationId)) return true; // activity at an assigned location
  if (e.type === 'ship' && L.has(e.toId)) return true; // inbound handoff exception
  return false;
}

export function handoffVisible(v: Viewer, h: Handoff): boolean {
  if (v.user.status !== 'active') return false;
  const role = v.user.role;
  if (role === 'it-admin') return true;
  if (role === 'commercial') return v.user.clientNames.includes(h.clientName);
  if (role === 'supply-chain' || role === 'auditor') return v.locations.has(h.locationId);
  return false;
}

/** Findings that concern this viewer (on visible events at their locations). */
export function findingsFor(v: Viewer, a: Analysis): Finding[] {
  return a.findings.filter((f) => {
    if (!f.eventId) return v.user.role === 'it-admin';
    const e = a.byId.get(f.eventId);
    if (!e || !eventVisible(v, e)) return false;
    if (v.user.role === 'it-admin' || v.user.role === 'auditor') return true;
    return v.locations.has(e.locationId) || e.actorId === v.user.id || (e.type === 'ship' && v.locations.has(e.toId));
  });
}

export const can = (v: Viewer) => ROLES[v.user.role].can;

export function visibleDb(db: DemoDB, v: Viewer): DemoDB {
  return { ...db, events: db.events.filter((e) => eventVisible(v, e)), handoffs: db.handoffs.filter((h) => handoffVisible(v, h)) };
}

/** Locations of a kind that this viewer is assigned to. */
export function myLocations(v: Viewer, a: Analysis, kinds: string[]) {
  return [...v.locations].filter((id) => kinds.includes(a.places.get(id)?.kind ?? ''));
}
