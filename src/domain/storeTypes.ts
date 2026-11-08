import { createContext, useContext } from 'react';
import type { AppUser, CollectionArea, DemoDB, Handoff, Invitation, Location, ProcessingGroup, ReadyEvent, RoleId, Route, TraceEvent, TransformEvent } from '../data/types';
import type { Viewer } from './access';
import type { Analysis } from './engine';

export interface Result {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export interface Toast {
  id: string;
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

export type InviteInput = Pick<Invitation, 'email' | 'name' | 'role' | 'locationIds' | 'clientNames'>;

/** What a sign-in attempt for an email leads to (demo lookup or live server answer). */
export type AccountState = 'active' | 'suspended' | 'invited' | 'expired' | 'revoked' | 'unknown';

/** Why a signed-in identity cannot use the app (shown as a dedicated state screen). */
export type AccessIssue = 'suspended' | 'no-access' | 'no-locations' | 'expired-invite' | 'wrong-email' | 'offline';

export interface PendingInvite {
  invitationId?: string;
  email: string;
  name: string;
  role: RoleId;
  locationNames: string[];
}

export interface AuthApi {
  /** Request a one-time sign-in code by email (never reveals whether the email exists). */
  sendCode: (email: string) => Promise<Result>;
  /** Verify the code; the result says where the user goes next. */
  verifyCode: (email: string, code: string) => Promise<Result & { next?: 'app' | 'accept' | AccessIssue; invite?: PendingInvite }>;
  /** Activate a pending invitation for the verified email (role/locations were preassigned by IT). */
  acceptInvitation: (invite: PendingInvite, name: string) => Promise<Result>;
  /** Start Google sign-in. The verified Google email must match an invitation or account. */
  google: () => Promise<Result>;
  /** Resend wait in seconds after a code request (rate limit shown in the UI). */
  resendAfterSeconds: number;
  codeLength: number;
  codeLifetimeMinutes: number;
}

/**
 * The single interface the screens use. Two implementations:
 *  - DemoStoreProvider: browser-only localStorage data, simulated users.
 *  - LiveStoreProvider: Supabase Auth + RLS-scoped queries + workflow RPCs.
 */
export interface Store {
  mode: 'demo' | 'live';
  db: DemoDB;
  analysis: Analysis;
  user: AppUser | null;
  viewer: Viewer | null;
  role: RoleId;
  loading: boolean;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;

  recordEvent: (e: TraceEvent, summary: string) => Promise<Result>;
  correctEvent: (id: string, next: TraceEvent, reason: string, summary: string) => Promise<Result>;
  resolveDiscrepancy: (receiveId: string, note: string) => Promise<Result>;
  updateAggregation: (id: string, next: TransformEvent, summary: string, finalize?: boolean) => Promise<Result>;
  markReady: (e: ReadyEvent, h: { lotId: string; qty: number; product: Handoff['product']; locationId: string; clientName: string; orderRef: string }) => Promise<Result & { handoff?: Handoff }>;
  updateHandoff: (id: string, patch: Partial<Handoff>, summary: string) => Promise<Result>;
  /** Resolve the shareable customer link for a handoff (demo: local token; live: server-derived token). */
  traceLink: (h: Handoff) => Promise<string | null>;

  upsertLocation: (l: Location) => Promise<Result>;
  upsertArea: (a: CollectionArea) => Promise<Result>;
  upsertGroup: (g: ProcessingGroup) => Promise<Result>;
  upsertRoute: (r: Route) => Promise<Result>;

  inviteUser: (i: InviteInput) => Promise<Result>;
  resendInvite: (id: string) => Promise<Result>;
  revokeInvite: (id: string) => Promise<Result>;
  setUserStatus: (userId: string, status: AppUser['status']) => Promise<Result>;
  setUserAccess: (userId: string, role: RoleId, locationIds: string[], clientNames: string[]) => Promise<Result>;
  sendRecovery: (userId: string) => Promise<Result>;

  // session & authentication
  auth: AuthApi;
  /** Set when an authenticated identity has no usable access (live mode). */
  accessIssue: AccessIssue | null;
  pendingInvite: PendingInvite | null;
  signOut: () => Promise<void>;
  /** Demo only: switch the simulated signed-in user. */
  switchUser?: (userId: string) => void;
  /** Demo only: look up what an email would get at sign-in. */
  demoAccountState?: (email: string) => { state: AccountState; userId?: string; invitationId?: string };
  /** Demo only: accept an invitation and activate the account. */
  demoAcceptInvitation?: (invitationId: string, name: string) => string | null;
  reset: () => void;
  refresh: () => Promise<void>;
}

export const StoreCtx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('Store provider missing');
  return s;
}

/** For screens that require a signed-in user (always true inside the app shell). */
export function useSession() {
  const s = useStore();
  if (!s.user || !s.viewer) throw new Error('No signed-in user');
  return { ...s, user: s.user, viewer: s.viewer };
}
