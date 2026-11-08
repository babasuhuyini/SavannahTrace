// Role-and-location access matrix for the UI.
// IMPORTANT: this is a convenience layer. In live mode the same rules are
// enforced by Postgres Row Level Security and the workflow functions in
// supabase/migrations — hiding a screen here is never the security boundary.

import type { RoleId } from '../data/types';

export type PageId = 'home' | 'lots' | 'overview' | 'users' | 'audit' | 'trace' | 'handoffs' | 'reports' | 'master' | 'about';

export interface Capabilities {
  recordPurchase: boolean;
  ship: boolean;
  receive: boolean;
  issueToGroup: boolean;
  processKernel: boolean;
  processButter: boolean;
  aggregateSfcl: boolean;
  exportLegs: boolean;
  refineFilter: boolean;
  markReady: boolean;
  deliver: boolean;
  handoffEdit: boolean;
  handoffRead: boolean;
  /** none | restricted (no collector names/prices) | full */
  trace: 'none' | 'restricted' | 'full';
  collectorPersonalData: boolean;
  prices: boolean;
  correctEvents: boolean;
  manageUsers: boolean;
  masterData: boolean;
  auditRead: boolean;
  readOnly: boolean;
}

const none: Capabilities = {
  recordPurchase: false,
  ship: false,
  receive: false,
  issueToGroup: false,
  processKernel: false,
  processButter: false,
  aggregateSfcl: false,
  exportLegs: false,
  refineFilter: false,
  markReady: false,
  deliver: false,
  handoffEdit: false,
  handoffRead: false,
  trace: 'none',
  collectorPersonalData: false,
  prices: false,
  correctEvents: false,
  manageUsers: false,
  masterData: false,
  auditRead: false,
  readOnly: false,
};

export interface RoleDef {
  id: RoleId;
  label: string;
  short: string;
  summary: string;
  nav: PageId[];
  home: PageId;
  can: Capabilities;
}

export const ROLES: Record<RoleId, RoleDef> = {
  'nut-fo': {
    id: 'nut-fo',
    label: 'Nut Field Officer',
    short: 'Nut FO',
    summary: 'Purchases, OFN/ODK lots at your areas, shipments to the PHC or butter centre, PHC receipt and OFN → ODK processing.',
    nav: ['home', 'lots', 'reports'],
    home: 'home',
    // collector names are visible only for the officer's own assigned areas (needed to record purchases)
    can: { ...none, recordPurchase: true, ship: true, receive: true, processKernel: true, collectorPersonalData: true, prices: true },
  },
  'butter-fo': {
    id: 'butter-fo',
    label: 'Butter Field Officer',
    short: 'Butter FO',
    summary: 'Inbound ODK for your centre, receipt or discrepancy, issue to groups, ODK → OSB (LPO), warehouse shipments and SFCL aggregation where assigned.',
    nav: ['home', 'lots', 'reports'],
    home: 'home',
    can: { ...none, ship: true, receive: true, issueToGroup: true, processButter: true, aggregateSfcl: true },
  },
  'supply-chain': {
    id: 'supply-chain',
    label: 'Supply Chain Officer',
    short: 'Supply Chain',
    summary: 'SFCL and container route legs, arrival, refining/filtering and ready-for-pickup.',
    nav: ['home', 'trace', 'handoffs', 'reports'],
    home: 'home',
    can: { ...none, ship: true, receive: true, exportLegs: true, refineFilter: true, markReady: true, deliver: true, handoffRead: true, trace: 'restricted' },
  },
  commercial: {
    id: 'commercial',
    label: 'Commercial',
    short: 'Commercial',
    summary: 'Handoffs for your assigned clients and orders, trace link and QR, invoice reference.',
    nav: ['handoffs', 'reports'],
    home: 'handoffs',
    can: { ...none, handoffEdit: true, handoffRead: true },
  },
  'it-admin': {
    id: 'it-admin',
    label: 'IT Admin',
    short: 'IT Admin',
    summary: 'Users, invitations, roles and locations, master data, system health and system-wide audit.',
    nav: ['overview', 'trace', 'audit', 'reports', 'handoffs', 'users', 'master'],
    home: 'overview',
    can: { ...none, handoffRead: true, trace: 'full', collectorPersonalData: true, prices: true, correctEvents: true, manageUsers: true, masterData: true, auditRead: true },
  },
  auditor: {
    id: 'auditor',
    label: 'Auditor',
    short: 'Auditor',
    summary: 'Read-only trace and audit history for your assigned audit scope.',
    nav: ['audit', 'trace', 'reports'],
    home: 'audit',
    can: { ...none, trace: 'full', collectorPersonalData: true, prices: true, auditRead: true, readOnly: true },
  },
};

export const ROLE_ORDER: RoleId[] = ['nut-fo', 'butter-fo', 'supply-chain', 'commercial', 'it-admin', 'auditor'];

export const PAGE_LABEL: Record<PageId, string> = {
  home: 'My work',
  lots: 'My lots & stock',
  overview: 'System overview',
  users: 'Users & access',
  audit: 'Audit',
  trace: 'Trace explorer',
  handoffs: 'Handoffs',
  reports: 'Reports',
  master: 'Master data',
  about: 'About the demo',
};
