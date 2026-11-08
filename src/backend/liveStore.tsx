// Live store: Supabase Auth + RLS-scoped snapshot + workflow RPCs.
// Implements the same `Store` interface as the demo store, so screens are shared.
//
// Security model: the browser holds only the publishable key and the user's own
// session. What the user can read is decided by RLS; what they can write is
// decided by the SECURITY DEFINER workflow functions. Nothing here grants access.
//
// Sign-in: email + password, then a 6-digit authenticator code (TOTP). The database
// refuses all data until the session is aal2, so the screens below only guide the
// person through the steps — they are not what protects the data.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppUser, DemoDB, Handoff, RoleId, TraceEvent } from '../data/types';
import { viewerOf } from '../domain/access';
import { analyze } from '../domain/engine';
import { uid } from '../domain/format';
import {
  StoreCtx,
  type AccessIssue,
  type AuthApi,
  type AuthStage,
  type BulkOutcome,
  type LinkResult,
  type PendingInvite,
  type Result,
  type Store,
  type Toast,
} from '../domain/storeTypes';
import { takeAuthFragment } from './authFragment';
import { APP_URL } from './config';
import { snapshotToDb, type Snapshot } from './snapshot';
import { errorText, supabase } from './supabase';

const EMPTY: DemoDB = { schemaVersion: 4, seededAt: '', locations: [], collectionAreas: [], collectors: [], groups: [], routes: [], events: [], handoffs: [], documents: [], audit: [], users: [], invitations: [] };
const tz = (iso: string) => iso.slice(19) || '+00:00';
const redirectTo = () => APP_URL || `${window.location.origin}${window.location.pathname}`;
const TRANSFORM: Record<string, string> = { kernel: 'ofn_to_odk', butter: 'odk_to_osb', refine: 'refining', filter: 'filtering' };
const INVOICE: Record<Handoff['invoiceStatus'], string> = { 'not-started': 'not_started', 'in-preparation': 'in_preparation', 'recorded-demo': 'recorded' };
const lines = (ls: { lotId: string; qty: number }[]) => ls.map((l) => ({ lot_code: l.lotId, quantity_kg: l.qty }));

interface Ctx {
  signed_in: boolean;
  email?: string;
  user_id?: string;
  display_name?: string;
  status?: 'active' | 'suspended';
  role?: RoleId;
  locations?: string[];
  clients?: string[];
  has_password?: boolean;
  mfa_enrolled?: boolean;
  aal?: string;
}

/** Map Supabase Auth errors to plain sentences. Never includes the password. */
function authError(e: { message?: string; status?: number; code?: string } | null, fallback: string): string {
  const m = e?.message ?? '';
  if (e?.status === 429 || /rate limit|too many/i.test(m)) return 'Too many attempts. Wait a few minutes, then try again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'You appear to be offline. Reconnect and try again.';
  if (e?.code === 'weak_password' || /password should|weak password|at least \d+ characters/i.test(m))
    return 'That password does not meet the rules: at least 12 characters, with letters and numbers. Choose another.';
  if (e?.code === 'same_password' || /different from the old password/i.test(m)) return 'Choose a password that is different from your current one.';
  if (e?.code === 'reauthentication_needed' || /reauthentication/i.test(m)) return 'For security, sign out and sign in again, then change your password.';
  return fallback;
}

export function LiveStoreProvider({ children }: { children: ReactNode }) {
  const sb = supabase();
  const [db, setDb] = useState<DemoDB>(EMPTY);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessIssue, setAccessIssue] = useState<AccessIssue | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const [authStage, setAuthStage] = useState<AuthStage | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  /** True after a password-reset link was used: the next step is "choose a new password". */
  const recovery = useRef(false);
  /** Multi-step auth operations pause automatic reloads so the screen does not jump mid-way. */
  const quiet = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = uid('t');
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const signedOutState = useCallback(() => {
    setUser(null);
    setDb(EMPTY);
    setAuthStage(null);
    setAuthEmail(null);
    setPendingInvite(null);
    setAccessIssue(null);
  }, []);

  /** Decide the sign-in step (or load the RLS-scoped workspace) for the current session. */
  const load = useCallback(async () => {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) {
      signedOutState();
      setLoading(false);
      return;
    }
    if (!navigator.onLine) {
      setAccessIssue('offline');
      setLoading(false);
      return;
    }
    const { data: ctx, error } = await sb.rpc('get_my_context');
    if (error) {
      toast(errorText(error), 'error');
      setLoading(false);
      return;
    }
    const c = ctx as Ctx;
    setAuthEmail(c.email ?? s.session.user.email ?? null);
    const stage = (st: AuthStage | null) => {
      setUser(null);
      setDb(EMPTY);
      setAuthStage(st);
      setLoading(false);
    };
    if (!c.user_id) {
      // Identity without a profile: an invitation to accept (with a new password), or no access.
      const { data: inv } = await sb.rpc('accept_invitation', { p_display_name: null });
      const r = inv as { status: string; invitation?: { id: string; email: string; display_name: string; role: RoleId; location_names: string[] } } | null;
      stage(null);
      if (r?.status === 'pending' && r.invitation) {
        setAccessIssue(null);
        setPendingInvite({ invitationId: r.invitation.id, email: r.invitation.email, name: r.invitation.display_name, role: r.invitation.role, locationNames: r.invitation.location_names });
      } else setAccessIssue(r?.status === 'expired' ? 'expired-invite' : 'no-access');
      return;
    }
    setPendingInvite(null);
    if (c.status === 'suspended') {
      setAccessIssue('suspended');
      return stage(null);
    }
    setAccessIssue(null);
    if (recovery.current || !c.has_password) return stage('set-password');
    if (!c.mfa_enrolled) return stage('mfa-enroll');
    if (c.aal !== 'aal2') return stage('mfa-verify');
    if (!c.locations?.length && !['commercial', 'it-admin'].includes(c.role ?? '')) {
      setAccessIssue('no-locations');
      return stage(null);
    }
    const { data: snap, error: e2 } = await sb.rpc('get_workspace_snapshot');
    if (e2) {
      toast(errorText(e2), 'error');
      setLoading(false);
      return;
    }
    setDb(snapshotToDb(snap as Snapshot));
    setUser({ id: c.user_id, name: c.display_name ?? c.email ?? '', email: c.email ?? '', role: c.role ?? 'nut-fo', locationIds: c.locations ?? [], clientNames: c.clients ?? [], status: 'active', demo: false });
    setAuthStage(null);
    setLoading(false);
  }, [sb, toast, signedOutState]);

  useEffect(() => {
    const fragment = takeAuthFragment();
    (async () => {
      if (fragment?.access_token && fragment.refresh_token) {
        // A link from a Supabase email (default template): adopt that session.
        if (fragment.type === 'recovery') recovery.current = true;
        const { error } = await sb.auth.setSession({ access_token: fragment.access_token, refresh_token: fragment.refresh_token });
        if (error) toast(errorText(error), 'error');
      } else if (fragment?.error) {
        toast(`${fragment.error}. The link has expired or was already used — ask SFCL IT for a new one.`, 'error');
      }
      await load();
    })();
    const { data } = sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recovery.current = true; // self-service reset email (PKCE)
      if (quiet.current > 0) return;
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 50);
    });
    return () => data.subscription.unsubscribe();
  }, [sb, load, toast]);

  // Scoped realtime: postgres_changes respects RLS, so only shipments this user may
  // read (e.g. those addressed to their centre) trigger a refresh. No global polling.
  useEffect(() => {
    if (!user) return;
    const ch = sb
      .channel('my-shipments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipment_events' }, () => {
        clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(load, 400);
      })
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [sb, user, load]);

  const analysis = useMemo(() => analyze(db), [db]);
  const viewer = useMemo(() => (user ? viewerOf(user) : null), [user]);

  /** Run a multi-step auth operation without intermediate reloads, then reload once. */
  async function steps<T>(fn: () => Promise<T>): Promise<T> {
    quiet.current++;
    try {
      return await fn();
    } finally {
      quiet.current--;
      await load();
    }
  }

  async function call(name: string, args: Record<string, unknown>, success?: string): Promise<Result & { data?: Record<string, unknown> }> {
    const { data, error } = await sb.rpc(name, args);
    if (error) {
      toast(errorText(error), 'error');
      return { ok: false, error: errorText(error) };
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const warnings = (d.warnings as string[] | undefined) ?? [];
    if (d.duplicate) toast('This was already submitted — the repeat was ignored (no duplicate created).', 'warn');
    else if (success) toast(success);
    warnings.forEach((w) => toast(w, 'warn'));
    await load();
    return { ok: true, warnings, data: d };
  }
  async function edge(name: string, body: Record<string, unknown>, success?: string): Promise<Result & { data?: Record<string, unknown> }> {
    const { data, error } = await sb.functions.invoke(name, { body });
    let err: string | undefined = (data as { error?: string } | null)?.error;
    if (error) {
      const ctxBody = await (error as { context?: Response }).context?.json?.().catch(() => null);
      err = (ctxBody as { error?: string } | null)?.error ?? error.message;
    }
    if (err) {
      toast(err, 'error');
      return { ok: false, error: err };
    }
    if (success) toast(success);
    await load();
    return { ok: true, data: data as Record<string, unknown> };
  }
  const linkResult = async (p: Promise<Result & { data?: Record<string, unknown> }>): Promise<LinkResult> => {
    const r = await p;
    return { ok: r.ok, error: r.error, link: (r.data?.link as string | null | undefined) ?? null };
  };

  /** The workflow RPC (name + payload) for an event — shared by single entry and bulk upload. */
  function eventRpc(e: TraceEvent, idem?: string): [string, Record<string, unknown>] | null {
    const base = { occurred_at: e.eventTime, occurred_tz: tz(e.eventTime), idempotency_key: idem ?? e.idempotencyKey ?? uid('idem'), notes: e.notes };
    switch (e.type) {
      case 'commission': {
        const o = e.outputs[0];
        return ['record_purchase', { p: { ...base, collector_code: e.collectorId, product: o.product, quantity_kg: o.qty, purchase_date: e.purchaseDate, lot_code: o.lotId, price_per_kg: e.pricePerKg, currency: e.currency } }];
      }
      case 'ship':
        return [
          'record_shipment',
          {
            p: {
              ...base,
              origin_code: e.fromId,
              destination_code: e.toId,
              items: lines(e.items),
              shipment_ref: e.shipmentRef,
              container_no: e.exportDetails?.containerNo,
              vessel: e.exportDetails?.vessel,
              eta: e.exportDetails?.eta,
              client_name: e.exportDetails?.clientName,
              order_ref: e.exportDetails?.orderRef,
            },
          },
        ];
      case 'receive':
        return ['receive_shipment', { p: { ...base, shipment_event_id: e.shipEventId, items: lines(e.items), outcome: e.outcome, discrepancy_note: e.discrepancyNote } }];
      case 'issue':
        return ['issue_to_group', { p: { ...base, centre_code: e.locationId, group_code: e.groupId, items: lines(e.items) } }];
      case 'transform':
        if (e.kind === 'aggregation')
          return ['save_sfcl_aggregation', { p: { ...base, sfcl_code: e.outputs[0]?.lotId, warehouse_code: e.locationId, draws: lines(e.inputs), finalize: e.sfclStage === 'finalized' } }];
        return [
          'record_transformation',
          { p: { ...base, kind: TRANSFORM[e.kind], location_code: e.locationId, group_code: e.groupId, inputs: lines(e.inputs), outputs: e.outputs.map((o) => ({ lot_code: o.lotId, product: o.product, quantity_kg: o.qty })) } },
        ];
      case 'deliver':
        return ['record_delivery', { p: { ...base, origin_code: e.locationId, client_location_code: e.toId, items: lines(e.items) } }];
      default:
        return null;
    }
  }

  const recordEvent: Store['recordEvent'] = async (e, summary) => {
    const rpc = eventRpc(e);
    return rpc ? call(rpc[0], rpc[1], summary) : { ok: false, error: 'Unsupported event.' };
  };

  const recordEvents: Store['recordEvents'] = async (items, onProgress) => {
    const out: BulkOutcome[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let rpc: [string, Record<string, unknown>] | null;
      if (it.event.type === 'ready' && it.handoff) {
        const h = it.handoff;
        rpc = ['mark_ready_for_pickup', { p: { location_code: h.locationId, lot_code: h.lotId, quantity_kg: h.qty, client_name: h.clientName, order_ref: h.orderRef, occurred_at: it.event.eventTime, occurred_tz: tz(it.event.eventTime), idempotency_key: it.key } }];
      } else rpc = eventRpc(it.event, it.key);
      if (!rpc) out.push({ key: it.key, ok: false, error: 'Unsupported event.' });
      else {
        const { data, error } = await sb.rpc(rpc[0], rpc[1]);
        const d = (data ?? {}) as Record<string, unknown>;
        out.push(error ? { key: it.key, ok: false, error: errorText(error) } : { key: it.key, ok: true, duplicate: !!d.duplicate, warnings: (d.warnings as string[] | undefined) ?? [] });
        if (error && /offline/i.test(errorText(error))) {
          for (const rest of items.slice(i + 1)) out.push({ key: rest.key, ok: false, error: 'Not sent: the connection dropped.' });
          break;
        }
      }
      onProgress?.(i + 1, items.length);
    }
    await load();
    return out;
  };

  const importMaster: Store['importMaster'] = async (m) => {
    const rows =
      m.kind === 'locations'
        ? m.items.map((l) => ({ code: l.id, name: l.name, kind: l.kind, lat: l.lat, lng: l.lng, public_label: l.publicLabel, country: l.country, account_code: l.accountCode, public_place: !!l.publicPlace }))
        : m.kind === 'collection_areas'
          ? m.items.map((a) => {
              const pts = a.polygon.slice(0, -1);
              return {
                code: a.id,
                area_code: a.code,
                name: a.name,
                operational_area: a.operationalArea,
                polygon: a.polygon,
                geometry_source: a.geometrySource,
                lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
                lng: pts.reduce((s, p) => s + p[0], 0) / pts.length,
              };
            })
          : m.kind === 'collectors'
            ? m.items.map((c) => ({ code: c.code, name: c.name, area_code: c.areaCode }))
            : m.items.map((g) => ({ code: g.id, centre_code: g.centreId, name: g.name, members: g.members }));
    const { data, error } = await sb.rpc('admin_bulk_upsert', { p_kind: m.kind, p_rows: rows.map((r, i) => ({ ...r, _row: (m.items[i] as { _row?: number })._row ?? i + 2 })) });
    if (error) return { ok: false, error: errorText(error) };
    await load();
    return { ok: true, count: (data as { count?: number } | null)?.count ?? rows.length };
  };

  const auth: AuthApi = {
    signIn: async (email, password) =>
      steps(async () => {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        // One message for wrong email, wrong password and suspended account: the screen never reveals who has an account.
        if (error) return { ok: false, error: authError(error, 'Email or password is incorrect.') };
        return { ok: true };
      }),
    requestPasswordReset: async (email) => {
      const { error } = await sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: redirectTo() });
      if (error && (error.status === 429 || /rate|too many|security purposes/i.test(error.message))) return { ok: false, error: 'Too many reset requests. Wait an hour, or ask SFCL IT for a reset link.' };
      return { ok: true }; // neutral, whether or not the email has an account
    },
    acceptLink: async (tokenHash, type) =>
      steps(async () => {
        await sb.auth.signOut({ scope: 'local' }); // a link is for one person: never mix it with another session in this browser
        const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
        if (error) return { ok: false, error: authError(error, 'This link has expired or was already used. Ask SFCL IT for a new one.') };
        if (type === 'recovery') recovery.current = true;
        return { ok: true };
      }),
    setPassword: async (password) =>
      steps(async () => {
        const { error } = await sb.auth.updateUser({ password });
        if (error) return { ok: false, error: authError(error, 'The password could not be saved. Try again.') };
        recovery.current = false;
        await sb.auth.signOut({ scope: 'others' }); // any other device signed in as this person is signed out
        toast('Password saved.');
        return { ok: true };
      }),
    acceptInvitation: async (_invite, name, password) =>
      steps(async () => {
        const { error } = await sb.auth.updateUser({ password });
        if (error) return { ok: false, error: authError(error, 'The password could not be saved. Try again.') };
        const { data, error: e2 } = await sb.rpc('accept_invitation', { p_display_name: name });
        if (e2) return { ok: false, error: errorText(e2) };
        const st = (data as { status: string }).status;
        if (st !== 'activated' && st !== 'already_active') return { ok: false, error: st === 'expired' ? 'This invitation has expired. Ask IT for a new one.' : 'No valid invitation for this email.' };
        recovery.current = false;
        return { ok: true };
      }),
    startMfaEnrollment: async () => {
      quiet.current++;
      try {
        // Clear half-finished setups (e.g. the page was closed before the code was entered).
        const { data: lf } = await sb.auth.mfa.listFactors();
        for (const f of lf?.all ?? []) if (f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
        const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', issuer: 'Savannah Trace', friendlyName: `Authenticator ${uid('f').slice(2)}` });
        if (error || !data) return { ok: false, error: authError(error, 'Could not start the authenticator setup. Try again.') };
        return { ok: true, enrollment: { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret } };
      } finally {
        quiet.current--;
      }
    },
    confirmMfaEnrollment: async (factorId, code) =>
      steps(async () => {
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
        if (error) return { ok: false, error: authError(error, 'That code is not right. Use the newest 6-digit code in the app, and check that the phone’s clock is set automatically.') };
        toast('Authenticator set up. You will be asked for a code each time you sign in.');
        return { ok: true };
      }),
    verifyMfa: async (code) =>
      steps(async () => {
        const { data: f } = await sb.auth.mfa.listFactors();
        const factor = f?.totp?.[0];
        if (!factor) return { ok: false, error: 'No authenticator is set up for this account. Ask SFCL IT to reset it.' };
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
        if (error) return { ok: false, error: authError(error, 'That code is not right. Use the newest 6-digit code in the app.') };
        return { ok: true };
      }),
    changePassword: async (current, code, next) =>
      steps(async () => {
        const email = authEmail ?? user?.email;
        if (!email) return { ok: false, error: 'Sign in again first.' };
        const { error: e1 } = await sb.auth.signInWithPassword({ email, password: current });
        if (e1) return { ok: false, error: authError(e1, 'Your current password is not correct.') };
        const { data: f } = await sb.auth.mfa.listFactors();
        const factor = f?.totp?.[0];
        if (!factor) return { ok: false, error: 'No authenticator is set up for this account.' };
        const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
        if (e2) return { ok: false, error: authError(e2, 'That authenticator code is not right.') };
        const { error: e3 } = await sb.auth.updateUser({ password: next });
        if (e3) return { ok: false, error: authError(e3, 'The new password could not be saved.') };
        await sb.auth.signOut({ scope: 'others' });
        toast('Password changed. Other devices were signed out.');
        return { ok: true };
      }),
    signOutOtherDevices: async () => {
      const { error } = await sb.auth.signOut({ scope: 'others' });
      if (error) return { ok: false, error: errorText(error) };
      toast('Signed out on every other device.');
      return { ok: true };
    },
  };

  const value: Store = {
    mode: 'live',
    db,
    analysis,
    user,
    viewer,
    role: user?.role ?? 'nut-fo',
    loading,
    toasts,
    toast,
    recordEvent,
    recordEvents,
    importMaster,
    correctEvent: (id, next, reason) =>
      call('record_correction', { p: { event_id: id, occurred_at: next.eventTime, occurred_tz: tz(next.eventTime), notes: next.notes ?? '', reason } }, 'Correction recorded as a new history entry.'),
    resolveDiscrepancy: (id, note) => call('resolve_discrepancy', { p_receipt_event_id: id, p_note: note }, 'Discrepancy resolution recorded.'),
    updateAggregation: (_id, next, summary, finalize) =>
      call(
        'save_sfcl_aggregation',
        { p: { sfcl_code: next.outputs[0]?.lotId, warehouse_code: next.locationId, draws: lines(next.inputs), finalize: !!finalize, occurred_at: next.eventTime, occurred_tz: tz(next.eventTime), idempotency_key: uid('idem') } },
        summary,
      ),
    markReady: async (e, h) => {
      const r = await call(
        'mark_ready_for_pickup',
        { p: { location_code: h.locationId, lot_code: h.lotId, quantity_kg: h.qty, client_name: h.clientName, order_ref: h.orderRef, occurred_at: e.eventTime, occurred_tz: tz(e.eventTime), idempotency_key: e.idempotencyKey ?? uid('idem') } },
        'Marked ready for pickup — Commercial handoff created.',
      );
      if (!r.ok) return r;
      const { data: snap } = await sb.rpc('get_workspace_snapshot');
      const handoff = snapshotToDb(snap as Snapshot).handoffs.find((x) => x.id === r.data?.handoff_id);
      return { ok: true, handoff };
    },
    updateHandoff: (id, patch, summary) =>
      call(
        'update_handoff',
        { p: { handoff_id: id, acknowledge: patch.status === 'acknowledged', invoice_ref: patch.invoiceRef, invoice_status: patch.invoiceStatus ? INVOICE[patch.invoiceStatus] : undefined, disclosure: patch.disclosure } },
        summary,
      ),
    traceLink: async (h) => {
      const { data, error } = await sb.functions.invoke('trace-link', { body: { handoff_id: h.id } });
      if (error) return null;
      return (data as { url?: string } | null)?.url ?? null;
    },
    upsertLocation: (l) =>
      call('admin_upsert_location', { p: { code: l.id, name: l.name, kind: l.kind, lat: l.lat, lng: l.lng, public_label: l.publicLabel, country: l.country, account_code: l.accountCode, public_place: !!l.publicPlace } }, `Saved location “${l.name}”.`),
    upsertGroup: (g) => call('admin_upsert_group', { p: { code: g.id, centre_code: g.centreId, name: g.name, members: g.members } }, `Saved group “${g.name}”.`),
    upsertArea: (a) => {
      const pts = a.polygon.slice(0, -1);
      const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      return call('admin_upsert_collection_area', { p: { code: a.id, area_code: a.code, name: a.name, operational_area: a.operationalArea, polygon: a.polygon, geometry_source: a.geometrySource, lat, lng } }, `Saved collection area “${a.name}”.`);
    },
    upsertRoute: async () => {
      toast('Planned routes are not stored in the database yet (demo-only feature).', 'warn');
      return { ok: false, error: 'not supported' };
    },
    inviteUser: (i, delivery) =>
      linkResult(
        edge(
          'admin-users',
          { action: 'invite', email: i.email, name: i.name, role: i.role, location_codes: i.locationIds, client_names: i.clientNames, delivery },
          delivery === 'email' ? 'Invitation emailed.' : 'Invitation created. Copy the link and send it to the person.',
        ),
      ),
    resendInvite: (id, delivery) => linkResult(edge('admin-users', { action: 'resend', invitation_id: id, delivery }, delivery === 'email' ? 'New invitation emailed.' : 'New invitation link created. The old link no longer works.')),
    revokeInvite: (id) => edge('admin-users', { action: 'revoke', invitation_id: id }, 'Invitation revoked.'),
    setUserStatus: (id, status) =>
      edge('admin-users', { action: status === 'suspended' ? 'suspend' : 'reactivate', user_id: id }, status === 'suspended' ? 'Access suspended and sessions revoked.' : 'Access reactivated.'),
    setUserAccess: (id, role, locs, clients) => call('admin_set_user_access', { p: { user_id: id, role, location_codes: locs, client_names: clients } }, 'Role and location access updated.'),
    passwordResetLink: (id, delivery) =>
      linkResult(edge('admin-users', { action: 'password_reset', user_id: id, delivery }, delivery === 'email' ? 'Password reset email sent.' : 'Password reset link created.')),
    resetMfa: (id) => edge('admin-users', { action: 'mfa_reset', user_id: id }, 'Authenticator removed. The user sets up a new one at their next sign-in.'),
    auth,
    authStage,
    authEmail,
    accessIssue,
    pendingInvite,
    signOut: async () => {
      recovery.current = false;
      await sb.auth.signOut();
      signedOutState();
    },
    reset: () => toast('Reset is a demo-only feature.', 'warn'),
    refresh: load,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
