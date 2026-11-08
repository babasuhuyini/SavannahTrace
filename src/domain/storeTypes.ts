import { createContext, useContext } from 'react';
import type { AppUser, CollectionArea, Collector, DemoDB, Handoff, Invitation, Location, ProcessingGroup, ReadyEvent, RoleId, Route, TraceEvent, TransformEvent } from '../data/types';
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

/** What a sign-in attempt for an email leads to (demo lookup). */
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

/** Which sign-in step a signed-in identity still has to complete (live: decided from Auth + database). */
export type AuthStage = 'set-password' | 'mfa-enroll' | 'mfa-verify';

/** Authenticator-app (TOTP) setup material. Shown once, during setup only. */
export interface MfaEnrollment {
  factorId: string;
  /** Image URL (data: URL) of the QR code to scan. */
  qr: string;
  /** Setup key for typing in by hand. */
  secret: string;
}

/**
 * Sign-in: email + password, then a 6-digit code from an authenticator app.
 * Passwords are passed straight to Supabase Auth and never stored, logged or shown.
 */
export interface AuthApi {
  signIn: (email: string, password: string) => Promise<Result>;
  /** Self-service reset email (neutral answer: never reveals whether the email has an account). */
  requestPasswordReset: (email: string) => Promise<Result>;
  /** Use a one-time invitation / password-reset link (after the person clicks Continue). */
  acceptLink: (tokenHash: string, type: 'invite' | 'recovery') => Promise<Result>;
  /** Set a new password for the signed-in identity (invitation, reset, or missing password). */
  setPassword: (password: string) => Promise<Result>;
  /** Activate a pending invitation (role/locations were preassigned by IT) and set the password. */
  acceptInvitation: (invite: PendingInvite, name: string, password: string) => Promise<Result>;
  startMfaEnrollment: () => Promise<Result & { enrollment?: MfaEnrollment }>;
  confirmMfaEnrollment: (factorId: string, code: string) => Promise<Result>;
  verifyMfa: (code: string) => Promise<Result>;
  /** Re-checks the current password and an authenticator code before changing the password. */
  changePassword: (current: string, code: string, next: string) => Promise<Result>;
  signOutOtherDevices: () => Promise<Result>;
}

export type Delivery = 'link' | 'email';
/** Admin actions that produce a one-time link for IT to send privately. */
export interface LinkResult extends Result {
  link?: string | null;
}

export type MasterImport =
  | { kind: 'locations'; items: Location[] }
  | { kind: 'collection_areas'; items: CollectionArea[] }
  | { kind: 'collectors'; items: (Collector & { areaCode: string })[] }
  | { kind: 'groups'; items: ProcessingGroup[] };

/** One entry of a bulk event upload. `key` is the deterministic idempotency key. */
export interface BulkEvent {
  key: string;
  event: TraceEvent;
  summary: string;
  /** Ready-for-pickup only. */
  handoff?: { lotId: string; qty: number; product: Handoff['product']; locationId: string; clientName: string; orderRef: string };
}
export interface BulkOutcome {
  key: string;
  ok: boolean;
  duplicate?: boolean;
  error?: string;
  warnings?: string[];
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

  /** Bulk upload of master data: all rows saved, or none (one transaction in live mode). */
  importMaster: (m: MasterImport) => Promise<Result & { count?: number }>;
  /** Bulk upload of events, in order. Each entry is validated by the server; repeats are ignored. */
  recordEvents: (items: BulkEvent[], onProgress?: (done: number, total: number) => void) => Promise<BulkOutcome[]>;

  inviteUser: (i: InviteInput, delivery: Delivery) => Promise<LinkResult>;
  resendInvite: (id: string, delivery: Delivery) => Promise<LinkResult>;
  revokeInvite: (id: string) => Promise<Result>;
  setUserStatus: (userId: string, status: AppUser['status']) => Promise<Result>;
  setUserAccess: (userId: string, role: RoleId, locationIds: string[], clientNames: string[]) => Promise<Result>;
  /** One-time link with which the user chooses a new password (IT never sees or sets it). */
  passwordResetLink: (userId: string, delivery: Delivery) => Promise<LinkResult>;
  /** Remove the user's authenticator (lost phone); they set up a new one at next sign-in. */
  resetMfa: (userId: string) => Promise<Result>;

  // session & authentication
  auth: AuthApi;
  /** The next sign-in step for a signed-in identity, or null when none is pending. */
  authStage: AuthStage | null;
  /** Email of the signed-in identity (also while a sign-in step is pending). */
  authEmail: string | null;
  /** Set when an authenticated identity has no usable access (live mode). */
  accessIssue: AccessIssue | null;
  pendingInvite: PendingInvite | null;
  signOut: () => Promise<void>;
  /** Demo only: switch the simulated signed-in user. */
  switchUser?: (userId: string) => void;
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
