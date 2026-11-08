// DEMO USERS — fictional accounts used only in local demo mode.
// In live (Supabase) mode users come from protected tables: profiles,
// app_user_roles, user_location_assignments, commercial client assignments.
// Emails use the reserved `.invalid` domain so they can never receive mail.

import type { AppUser, Invitation, RoleId } from './types';

const u = (id: string, name: string, email: string, role: RoleId, locationIds: string[], clientNames: string[] = []): AppUser => ({
  id,
  name,
  email,
  role,
  locationIds,
  clientNames,
  status: 'active',
  demo: true,
});

const ALL = ['ca-kulaa', 'ca-sabon', 'ca-tingbaa', 'phc-nayiri', 'bc-tamba', 'bc-kalbe', 'wh-central', 'port-tema', 'nl-terminal', 'nl-zaan', 'nl-clearfilter', 'client-lumiere'];

export const DEMO_USERS: AppUser[] = [
  u('u-nut-a', 'Demo Nut Officer A', 'nut.officer.a@demo-sfcl.invalid', 'nut-fo', ['ca-kulaa', 'phc-nayiri']),
  u('u-nut-b', 'Demo Nut Officer B', 'nut.officer.b@demo-sfcl.invalid', 'nut-fo', ['ca-sabon', 'ca-tingbaa']),
  u('u-butter-tamba', 'Demo Butter Officer (Tamba)', 'butter.tamba@demo-sfcl.invalid', 'butter-fo', ['bc-tamba']),
  u('u-butter-kalbe', 'Demo Butter Officer (Kalbe + warehouse)', 'butter.kalbe@demo-sfcl.invalid', 'butter-fo', ['bc-kalbe', 'wh-central']),
  u('u-supply', 'Demo Supply Chain Officer', 'supply.chain@demo-sfcl.invalid', 'supply-chain', ['port-tema', 'nl-terminal', 'nl-zaan', 'nl-clearfilter', 'client-lumiere']),
  u('u-commercial', 'Demo Commercial Officer', 'commercial@demo-sfcl.invalid', 'commercial', [], ['DEMO Lumière Naturals B.V.', 'DEMO Nordhavn Personal Care A/S']),
  u('u-admin', 'Demo IT Admin', 'it.admin@demo-sfcl.invalid', 'it-admin', ALL),
  u('u-auditor', 'Demo Auditor', 'auditor@demo-sfcl.invalid', 'auditor', ALL),
];

export const DEMO_INVITATIONS: Invitation[] = [
  {
    id: 'inv-0001',
    email: 'new.butter.officer@demo-sfcl.invalid',
    name: 'Demo New Butter Officer',
    role: 'butter-fo',
    locationIds: ['bc-tamba'],
    clientNames: [],
    status: 'pending',
    createdAt: '2026-11-06T09:10:00.000Z',
    expiresAt: '2026-11-13T09:10:00.000Z',
    invitedBy: 'u-admin',
    demo: true,
  },
  {
    id: 'inv-0002',
    email: 'late.starter@demo-sfcl.invalid',
    name: 'Demo Late Starter',
    role: 'nut-fo',
    locationIds: ['ca-kulaa'],
    clientNames: [],
    status: 'expired',
    createdAt: '2026-10-20T08:00:00.000Z',
    expiresAt: '2026-10-27T08:00:00.000Z',
    invitedBy: 'u-admin',
    demo: true,
  },
];

/** Which demo user recorded a seeded event (by role + location). */
export function demoActorFor(role: RoleId, locationId: string): string {
  const match = DEMO_USERS.find((x) => x.role === role && x.locationIds.includes(locationId));
  if (match) return match.id;
  return DEMO_USERS.find((x) => x.role === role)?.id ?? 'u-admin';
}

export const ROLE_DEFAULT_USER: Record<RoleId, string> = {
  'nut-fo': 'u-nut-a',
  'butter-fo': 'u-butter-tamba',
  'supply-chain': 'u-supply',
  commercial: 'u-commercial',
  'it-admin': 'u-admin',
  auditor: 'u-auditor',
};
