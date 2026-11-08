// Live store: Supabase Auth + RLS-scoped snapshot + workflow RPCs.
// Implements the same `Store` interface as the demo store, so screens are shared.
//
// Security model: the browser holds only the publishable key and the user's own
// session. What the user can read is decided by RLS; what they can write is
// decided by the SECURITY DEFINER workflow functions. Nothing here grants access.
//
// Status: type-checked, and its snapshot mapping is exercised against the real
// migrations (npm run verify:rls). It has NOT run against a hosted Supabase
// project yet. Run the acceptance tests in docs/SUPABASE_SETUP.md before relying on it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppUser, DemoDB, Handoff, RoleId } from '../data/types';
import { viewerOf } from '../domain/access';
import { analyze } from '../domain/engine';
import { uid } from '../domain/format';
import { StoreCtx, type AccessIssue, type AuthApi, type PendingInvite, type Result, type Store, type Toast } from '../domain/storeTypes';
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
}

export function LiveStoreProvider({ children }: { children: ReactNode }) {
  const sb = supabase();
  const [db, setDb] = useState<DemoDB>(EMPTY);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessIssue, setAccessIssue] = useState<AccessIssue | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = uid('t');
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  /** Resolve who the signed-in identity is and load their RLS-scoped workspace. */
  const load = useCallback(async () => {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) {
      setUser(null);
      setDb(EMPTY);
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
    if (!c.user_id) {
      // authenticated identity without a profile: pending invite, expired, or uninvited
      const { data: inv } = await sb.rpc('accept_invitation', { p_display_name: null });
      const r = inv as { status: string; invitation?: { id: string; email: string; display_name: string; role: RoleId; location_names: string[] } } | null;
      setUser(null);
      if (r?.status === 'pending' && r.invitation)
        setPendingInvite({ invitationId: r.invitation.id, email: r.invitation.email, name: r.invitation.display_name, role: r.invitation.role, locationNames: r.invitation.location_names });
      else setAccessIssue(r?.status === 'expired' ? 'expired-invite' : 'no-access');
      setLoading(false);
      return;
    }
    if (c.status === 'suspended') {
      setUser(null);
      setAccessIssue('suspended');
      setLoading(false);
      return;
    }
    if (!c.locations?.length && !['commercial', 'it-admin'].includes(c.role ?? '')) {
      setUser(null);
      setAccessIssue('no-locations');
      setLoading(false);
      return;
    }
    const { data: snap, error: e2 } = await sb.rpc('get_workspace_snapshot');
    if (e2) {
      toast(errorText(e2), 'error');
      setLoading(false);
      return;
    }
    setDb(snapshotToDb(snap as Snapshot));
    setUser({ id: c.user_id, name: c.display_name ?? c.email ?? '', email: c.email ?? '', role: c.role ?? 'nut-fo', locationIds: c.locations ?? [], clientNames: c.clients ?? [], status: 'active', demo: false });
    setAccessIssue(null);
    setPendingInvite(null);
    setLoading(false);
  }, [sb, toast]);

  useEffect(() => {
    const fragment = takeAuthFragment();
    (async () => {
      if (fragment?.access_token && fragment.refresh_token) {
        // invitation accepted from the email link: adopt that session
        const { error } = await sb.auth.setSession({ access_token: fragment.access_token, refresh_token: fragment.refresh_token });
        if (error) toast(errorText(error), 'error');
      } else if (fragment?.error) {
        toast(`${fragment.error}. Sign in with your email address to receive a new code, or ask your administrator to resend the invitation.`, 'error');
      }
      await load();
    })();
    const { data } = sb.auth.onAuthStateChange(() => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 50);
    });
    return () => data.subscription.unsubscribe();
  }, [sb, load]);

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

  const recordEvent: Store['recordEvent'] = async (e, summary) => {
    const base = { occurred_at: e.eventTime, occurred_tz: tz(e.eventTime), idempotency_key: e.idempotencyKey ?? uid('idem'), notes: e.notes };
    switch (e.type) {
      case 'commission': {
        const o = e.outputs[0];
        return call('record_purchase', { p: { ...base, collector_code: e.collectorId, product: o.product, quantity_kg: o.qty, purchase_date: e.purchaseDate, lot_code: o.lotId, price_per_kg: e.pricePerKg, currency: e.currency } }, summary);
      }
      case 'ship':
        return call(
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
          summary,
        );
      case 'receive':
        return call('receive_shipment', { p: { ...base, shipment_event_id: e.shipEventId, items: lines(e.items), outcome: e.outcome, discrepancy_note: e.discrepancyNote } }, summary);
      case 'issue':
        return call('issue_to_group', { p: { ...base, centre_code: e.locationId, group_code: e.groupId, items: lines(e.items) } }, summary);
      case 'transform':
        if (e.kind === 'aggregation')
          return call('save_sfcl_aggregation', { p: { ...base, sfcl_code: e.outputs[0]?.lotId, warehouse_code: e.locationId, draws: lines(e.inputs), finalize: e.sfclStage === 'finalized' } }, summary);
        return call(
          'record_transformation',
          { p: { ...base, kind: TRANSFORM[e.kind], location_code: e.locationId, group_code: e.groupId, inputs: lines(e.inputs), outputs: e.outputs.map((o) => ({ lot_code: o.lotId, product: o.product, quantity_kg: o.qty })) } },
          summary,
        );
      case 'deliver':
        return call('record_delivery', { p: { ...base, origin_code: e.locationId, client_location_code: e.toId, items: lines(e.items) } }, summary);
      default:
        return { ok: false, error: 'Unsupported event.' };
    }
  };

  const auth: AuthApi = {
    resendAfterSeconds: 60,
    codeLength: 6,
    codeLifetimeMinutes: 10,
    sendCode: async (email) => {
      const { error } = await sb.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: false, emailRedirectTo: redirectTo() } });
      // Unknown emails get the same neutral response, so the screen never reveals who has an account.
      if (error && /rate|too many|security purposes/i.test(error.message)) return { ok: false, error: 'Too many code requests. Wait a minute and try again.' };
      return { ok: true };
    },
    verifyCode: async (email, code) => {
      const { error } = await sb.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code, type: 'email' });
      if (error) return { ok: false, error: /expired/i.test(error.message) ? 'That code has expired. Request a new one.' : 'That code is not valid. Check it or request a new one.' };
      await load();
      return { ok: true, next: 'app' }; // provider state then routes to the app, activation or an access-issue screen
    },
    acceptInvitation: async (_invite, name) => {
      const { data, error } = await sb.rpc('accept_invitation', { p_display_name: name });
      if (error) return { ok: false, error: errorText(error) };
      const st = (data as { status: string }).status;
      if (st !== 'activated' && st !== 'already_active') return { ok: false, error: st === 'expired' ? 'This invitation has expired. Ask IT to send a new one.' : 'No valid invitation for this email.' };
      await load();
      return { ok: true };
    },
    google: async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
      return error ? { ok: false, error: errorText(error) } : { ok: true };
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
    inviteUser: (i) => edge('admin-users', { action: 'invite', email: i.email, name: i.name, role: i.role, location_codes: i.locationIds, client_names: i.clientNames }, 'Invitation sent.'),
    resendInvite: (id) => edge('admin-users', { action: 'resend', invitation_id: id }, 'Invitation re-sent.'),
    revokeInvite: (id) => edge('admin-users', { action: 'revoke', invitation_id: id }, 'Invitation revoked.'),
    setUserStatus: (id, status) =>
      edge('admin-users', { action: status === 'suspended' ? 'suspend' : 'reactivate', user_id: id }, status === 'suspended' ? 'Access suspended and sessions revoked.' : 'Access reactivated.'),
    setUserAccess: (id, role, locs, clients) => call('admin_set_user_access', { p: { user_id: id, role, location_codes: locs, client_names: clients } }, 'Role and location access updated.'),
    sendRecovery: (id) => edge('admin-users', { action: 'recovery', user_id: id }, 'A fresh sign-in email was sent to the user.'),
    auth,
    accessIssue,
    pendingInvite,
    signOut: async () => {
      await sb.auth.signOut();
      setUser(null);
      setAccessIssue(null);
      setPendingInvite(null);
      setDb(EMPTY);
    },
    reset: () => toast('Reset is a demo-only feature.', 'warn'),
    refresh: load,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
