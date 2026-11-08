// Demo store: browser-only data in localStorage with simulated users.
// The live Supabase implementation is in src/backend/liveStore.tsx and exposes
// the same `Store` interface (see storeTypes.ts).

import { useCallback, useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { SCHEMA_VERSION, buildSeed } from '../data/seed';
import { ROLE_DEFAULT_USER } from '../data/users';
import type { AppUser, AuditEntry, DemoDB, Handoff, TraceEvent } from '../data/types';
import { viewerOf } from './access';
import { analyze } from './engine';
import { randomToken, uid } from './format';
import { customerUrl } from '../router';
import { StoreCtx, type AccountState, type AuthApi, type Result, type Store, type Toast } from './storeTypes';

export { useStore, useSession } from './storeTypes';

const DB_KEY = 'sfcl-trace-demo:db';
const USER_KEY = 'sfcl-trace-demo:user';

function load(): DemoDB | null {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return null;
    const db = JSON.parse(raw) as DemoDB;
    return db.schemaVersion === SCHEMA_VERSION ? db : null;
  } catch {
    return null;
  }
}
function save(db: DemoDB) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    /* storage unavailable: the demo still works for this session */
  }
}
const ok: Result = { ok: true };

export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<DemoDB>(() => load() ?? buildSeed());
  const [userId, setUserId] = useState<string | null>(() => {
    // demo convenience (e.g. for screenshots/profiling): #/route?as=u-admin
    const asUser = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('as');
    if (asUser) return asUser;
    try {
      const v = localStorage.getItem(USER_KEY);
      return v === '' ? null : v ?? ROLE_DEFAULT_USER['nut-fo'];
    } catch {
      return ROLE_DEFAULT_USER['nut-fo'];
    }
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dbRef = useRef(db);
  dbRef.current = db;

  useEffect(() => save(db), [db]);
  useEffect(() => {
    try {
      localStorage.setItem(USER_KEY, userId ?? '');
    } catch {
      /* ignore */
    }
  }, [userId]);

  // The engine replays every event; memoised so it only reruns when data changes.
  const analysis = useMemo(() => analyze(db), [db]);
  const user = useMemo(() => {
    const u = db.users.find((x) => x.id === userId) ?? null;
    return u && u.status === 'active' ? u : null;
  }, [db.users, userId]);
  const viewer = useMemo(() => (user ? viewerOf(user) : null), [user]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = uid('t');
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const audit = (d: DemoDB, entry: Omit<AuditEntry, 'id' | 'at' | 'actor'> & { actor?: AuditEntry['actor'] }): DemoDB => ({
    ...d,
    audit: [...d.audit, { id: uid('au'), at: new Date().toISOString(), actor: entry.actor ?? user?.role ?? 'system', actorId: user?.id, ...entry }],
  });
  const stamp = <T extends TraceEvent>(e: T): T => ({ ...e, actorId: e.actorId ?? user?.id });

  const recordEvent: Store['recordEvent'] = async (e, summary) => {
    const cur = dbRef.current;
    if (e.idempotencyKey && cur.events.some((x) => x.idempotencyKey === e.idempotencyKey)) {
      setDb((d) => audit(d, { action: 'event.duplicate-blocked', targetId: e.id, summary: `Repeated submission ignored: ${summary}` }));
      toast('This form was already submitted — the repeat was ignored (no duplicate created).', 'warn');
      return { ok: false, error: 'duplicate' };
    }
    setDb((d) => audit({ ...d, events: [...d.events, stamp(e)] }, { action: 'event.recorded', targetId: e.id, summary }));
    toast(summary);
    return ok;
  };

  const correctEvent: Store['correctEvent'] = async (id, next, reason, summary) => {
    setDb((d) => {
      const before = d.events.find((e) => e.id === id);
      if (!before) return d;
      const updated = { ...next, version: before.version + 1 } as TraceEvent;
      return audit(
        { ...d, events: d.events.map((e) => (e.id === id ? updated : e)) },
        { action: 'event.corrected', targetId: id, summary: `${summary} (version ${before.version} → ${before.version + 1})`, reason, before, after: updated },
      );
    });
    toast('Correction recorded as a new history entry.');
    return ok;
  };

  const resolveDiscrepancy: Store['resolveDiscrepancy'] = async (receiveId, note) => {
    setDb((d) => {
      const ev = d.events.find((e) => e.id === receiveId);
      if (!ev || ev.type !== 'receive') return d;
      const updated = { ...ev, discrepancyResolution: { at: new Date().toISOString(), note }, version: ev.version + 1 };
      return audit({ ...d, events: d.events.map((e) => (e.id === receiveId ? updated : e)) }, { action: 'discrepancy.resolved', targetId: receiveId, summary: 'Receipt discrepancy resolved', reason: note, before: ev, after: updated });
    });
    toast('Discrepancy resolution recorded.');
    return ok;
  };

  const updateAggregation: Store['updateAggregation'] = async (id, next, summary, finalize) => {
    setDb((d) => {
      const before = d.events.find((e) => e.id === id);
      if (!before) return d;
      const updated = { ...next, version: before.version + 1 };
      return audit({ ...d, events: d.events.map((e) => (e.id === id ? updated : e)) }, { action: finalize ? 'sfcl.finalized' : 'event.corrected', targetId: id, summary, before, after: updated });
    });
    toast(summary);
    return ok;
  };

  const markReady: Store['markReady'] = async (e, h) => {
    const cur = dbRef.current;
    const existing = cur.handoffs.find((x) => x.lotId === h.lotId && x.locationId === h.locationId);
    if (existing) {
      toast('Already marked ready — the existing trace link and handoff were reused.', 'warn');
      return { ok: true, handoff: existing };
    }
    const handoff: Handoff = {
      ...h,
      id: e.handoffId,
      token: randomToken(),
      createdAt: new Date().toISOString(),
      readyEventId: e.id,
      status: 'new',
      invoiceStatus: 'not-started',
      disclosure: 'generalized',
      demo: false,
    };
    setDb((d) =>
      audit(
        { ...d, events: [...d.events, stamp(e)], handoffs: [...d.handoffs, handoff] },
        { action: 'handoff.created', targetId: handoff.id, summary: `${h.lotId} (${h.qty.toLocaleString('en-GB')} kg) marked Arrived and ready for pickup. Trace link and Commercial handoff created.` },
      ),
    );
    toast('Marked ready for pickup — trace link, QR and Commercial handoff created.');
    return { ok: true, handoff };
  };

  const updateHandoff: Store['updateHandoff'] = async (id, patch, summary) => {
    setDb((d) => {
      const before = d.handoffs.find((h) => h.id === id);
      if (!before) return d;
      const after = { ...before, ...patch };
      return audit({ ...d, handoffs: d.handoffs.map((h) => (h.id === id ? after : h)) }, { action: 'handoff.updated', targetId: id, summary, before, after });
    });
    toast(summary);
    return ok;
  };

  function upsert<K extends 'locations' | 'collectionAreas' | 'groups' | 'routes'>(key: K, item: DemoDB[K][number], label: string): Promise<Result> {
    setDb((d) => {
      const list = d[key] as { id: string }[];
      const before = list.find((x) => x.id === item.id);
      const next = before ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
      return audit({ ...d, [key]: next } as DemoDB, { action: 'master.updated', targetId: item.id, summary: `${before ? 'Edited' : 'Added'} ${label}`, before, after: item });
    });
    toast(`Saved ${label} (local demo record).`);
    return Promise.resolve(ok);
  }

  // ── user administration (demo: simulated; live: Edge Function + RPCs) ──
  const inviteUser: Store['inviteUser'] = async (i) => {
    const email = i.email.trim().toLowerCase();
    const cur = dbRef.current;
    if (cur.users.some((u) => u.email.toLowerCase() === email)) return { ok: false, error: 'An account with this email already exists.' };
    if (cur.invitations.some((x) => x.email.toLowerCase() === email && x.status === 'pending')) return { ok: false, error: 'There is already a pending invitation for this email.' };
    const now = new Date();
    const inv = { ...i, email, id: uid('inv'), status: 'pending' as const, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(), invitedBy: user?.id ?? 'system', demo: true };
    setDb((d) => audit({ ...d, invitations: [...d.invitations, inv] }, { action: 'user.invited', targetId: inv.id, summary: `Invitation created for ${email} as ${i.role} (demo — no email sent)` }));
    toast('Invitation recorded. Demo mode: no email is sent.');
    return ok;
  };
  const resendInvite: Store['resendInvite'] = async (id) => {
    const now = new Date();
    setDb((d) =>
      audit(
        { ...d, invitations: d.invitations.map((x) => (x.id === id ? { ...x, status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString() } : x)) },
        { action: 'user.invitation-resent', targetId: id, summary: 'Invitation re-issued with a new 7-day expiry (demo — no email sent)' },
      ),
    );
    toast('Invitation re-issued. Demo mode: no email is sent.');
    return ok;
  };
  const revokeInvite: Store['revokeInvite'] = async (id) => {
    setDb((d) => audit({ ...d, invitations: d.invitations.map((x) => (x.id === id ? { ...x, status: 'revoked' } : x)) }, { action: 'user.invitation-revoked', targetId: id, summary: 'Invitation revoked' }));
    toast('Invitation revoked.');
    return ok;
  };
  const setUserStatus: Store['setUserStatus'] = async (id, status) => {
    if (id === user?.id) return { ok: false, error: 'You cannot change your own account status.' };
    setDb((d) =>
      audit(
        { ...d, users: d.users.map((u) => (u.id === id ? { ...u, status } : u)) },
        { action: status === 'suspended' ? 'user.suspended' : 'user.reactivated', targetId: id, summary: `${d.users.find((u) => u.id === id)?.name}: access ${status === 'suspended' ? 'suspended — sessions revoked, history kept' : 'reactivated'}` },
      ),
    );
    toast(status === 'suspended' ? 'Access suspended. Their records are kept for audit.' : 'Access reactivated.');
    return ok;
  };
  const setUserAccess: Store['setUserAccess'] = async (id, role, locationIds, clientNames) => {
    setDb((d) => {
      const before = d.users.find((u) => u.id === id);
      const after = before ? { ...before, role, locationIds, clientNames } : undefined;
      return audit({ ...d, users: d.users.map((u) => (u.id === id && after ? after : u)) }, { action: 'user.access-changed', targetId: id, summary: `${before?.name}: role/location access changed`, before, after });
    });
    toast('Role and location access updated.');
    return ok;
  };
  const sendRecovery: Store['sendRecovery'] = async (id) => {
    setDb((d) => audit(d, { action: 'user.recovery-sent', targetId: id, summary: `Sign-in recovery triggered for ${d.users.find((u) => u.id === id)?.email} (demo — no email sent)` }));
    toast('Recovery sign-in triggered. Demo mode: no email is sent; the user verifies with a new code.');
    return ok;
  };

  const demoAccountState: NonNullable<Store['demoAccountState']> = (email) => {
    const e = email.trim().toLowerCase();
    const d = dbRef.current;
    const u = d.users.find((x) => x.email.toLowerCase() === e);
    if (u) return { state: u.status === 'active' ? 'active' : 'suspended', userId: u.id };
    const inv = [...d.invitations].reverse().find((x) => x.email.toLowerCase() === e);
    if (inv) {
      const expired = inv.status === 'expired' || (inv.status === 'pending' && new Date(inv.expiresAt).getTime() < Date.now());
      const state: AccountState = expired ? 'expired' : inv.status === 'pending' ? 'invited' : inv.status === 'revoked' ? 'revoked' : 'unknown';
      return { state, invitationId: inv.id };
    }
    return { state: 'unknown' };
  };
  const demoAcceptInvitation: NonNullable<Store['demoAcceptInvitation']> = (invId, name) => {
    const inv = dbRef.current.invitations.find((x) => x.id === invId && x.status === 'pending');
    if (!inv) return null;
    const newUser: AppUser = { id: uid('u'), name: name.trim() || inv.name, email: inv.email, role: inv.role, locationIds: inv.locationIds, clientNames: inv.clientNames, status: 'active', demo: true };
    setDb((d) =>
      audit(
        { ...d, users: [...d.users, newUser], invitations: d.invitations.map((x) => (x.id === invId ? { ...x, status: 'accepted', acceptedAt: new Date().toISOString() } : x)) },
        { action: 'user.activated', actor: 'system', targetId: newUser.id, summary: `${newUser.email} accepted the invitation and verified their email; preassigned role and locations activated` },
      ),
    );
    return newUser.id;
  };

  // Demo authentication: no email is sent and any correctly-shaped code is accepted.
  // The *states* (invited, suspended, expired, unknown) behave like the live flow.
  const auth: AuthApi = {
    resendAfterSeconds: 30,
    codeLength: 6,
    codeLifetimeMinutes: 10,
    sendCode: async (email) => (/^\S+@\S+\.\S+$/.test(email.trim()) ? ok : { ok: false, error: 'Enter a valid work email address.' }),
    verifyCode: async (email, code) => {
      if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };
      const r = demoAccountState(email);
      if (r.state === 'active' && r.userId) {
        setUserId(r.userId);
        return { ok: true, next: 'app' };
      }
      if (r.state === 'suspended') return { ok: true, next: 'suspended' };
      if (r.state === 'expired') return { ok: true, next: 'expired-invite' };
      if (r.state === 'invited' && r.invitationId) {
        const inv = dbRef.current.invitations.find((x) => x.id === r.invitationId)!;
        const places = new Map(dbRef.current.locations.map((l) => [l.id, l.name] as const));
        dbRef.current.collectionAreas.forEach((a) => places.set(a.id, a.name));
        return { ok: true, next: 'accept', invite: { invitationId: inv.id, email: inv.email, name: inv.name, role: inv.role, locationNames: inv.locationIds.map((id) => places.get(id) ?? id) } };
      }
      return { ok: true, next: 'no-access' };
    },
    acceptInvitation: async (invite, name) => {
      const id = invite.invitationId ? demoAcceptInvitation(invite.invitationId, name) : null;
      if (!id) return { ok: false, error: 'This invitation is no longer valid.' };
      setUserId(id);
      toast('Account activated with the role and locations IT assigned.');
      return ok;
    },
    google: async () => ({ ok: false, error: 'Google sign-in needs a configured Supabase project. In demo mode, use the email code option.' }),
  };

  const value: Store = {
    mode: 'demo',
    auth,
    accessIssue: null,
    pendingInvite: null,
    db,
    analysis,
    user,
    viewer,
    role: user?.role ?? 'nut-fo',
    loading: false,
    toasts,
    toast,
    recordEvent,
    correctEvent,
    resolveDiscrepancy,
    updateAggregation,
    markReady,
    updateHandoff,
    traceLink: async (h) => customerUrl(h.token),
    upsertLocation: (l) => upsert('locations', l, `location “${l.name}”`),
    upsertArea: (a) => upsert('collectionAreas', a, `collection area “${a.name}”`),
    upsertGroup: (g) => upsert('groups', g, `processing group “${g.name}”`),
    upsertRoute: (r) => upsert('routes', r, `route “${r.name}”`),
    inviteUser,
    resendInvite,
    revokeInvite,
    setUserStatus,
    setUserAccess,
    sendRecovery,
    signOut: async () => setUserId(null),
    switchUser: (id) => setUserId(id),
    demoAccountState,
    demoAcceptInvitation,
    reset: () => {
      setDb(buildSeed());
      toast('Demo data reset to the original sample scenario.');
    },
    refresh: async () => undefined,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
