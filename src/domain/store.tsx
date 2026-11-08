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
import {
  StoreCtx,
  type AccessIssue,
  type AccountState,
  type AuthApi,
  type AuthStage,
  type BulkOutcome,
  type Delivery,
  type LinkResult,
  type PendingInvite,
  type Result,
  type Store,
  type Toast,
} from './storeTypes';

export { useStore, useSession } from './storeTypes';

const DB_KEY = 'sfcl-trace-demo:db';
const USER_KEY = 'sfcl-trace-demo:user';
const LINKS_KEY = 'sfcl-trace-demo:links';

/** Demo one-time links: token → what it unlocks. Kept in this browser only. */
type DemoLink = { kind: 'invite'; invitationId: string } | { kind: 'recovery'; userId: string };
function loadLinks(): Record<string, DemoLink> {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, DemoLink>;
  } catch {
    return {};
  }
}
function saveLinks(l: Record<string, DemoLink>) {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

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
const sixDigits = (code: string): Result | null => (/^\d{6}$/.test(code.trim()) ? null : { ok: false, error: 'Enter the 6-digit code from your authenticator app.' });

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
  // Simulated sign-in steps (the live store derives these from Supabase Auth + the database).
  const [authStage, setAuthStage] = useState<AuthStage | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const [accessIssue, setAccessIssue] = useState<AccessIssue | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
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

  // ── bulk upload ──
  const recordEvents: Store['recordEvents'] = async (items, onProgress) => {
    const cur = dbRef.current;
    const seen = new Set(cur.events.map((e) => e.idempotencyKey).filter(Boolean));
    const out: BulkOutcome[] = [];
    const newEvents: TraceEvent[] = [];
    const newHandoffs: Handoff[] = [];
    const entries: AuditEntry[] = [];
    for (const it of items) {
      if (seen.has(it.key)) {
        out.push({ key: it.key, ok: true, duplicate: true });
        continue;
      }
      seen.add(it.key);
      const ev = stamp({ ...it.event, idempotencyKey: it.key });
      newEvents.push(ev);
      if (ev.type === 'ready' && it.handoff)
        newHandoffs.push({ ...it.handoff, id: ev.handoffId, token: randomToken(), createdAt: new Date().toISOString(), readyEventId: ev.id, status: 'new', invoiceStatus: 'not-started', disclosure: 'generalized', demo: false });
      entries.push({ id: uid('au'), at: new Date().toISOString(), actor: user?.role ?? 'system', actorId: user?.id, action: ev.type === 'ready' ? 'handoff.created' : 'event.recorded', targetId: ev.id, summary: `${it.summary} (bulk upload)` });
      out.push({ key: it.key, ok: true });
    }
    setDb((d) => ({ ...d, events: [...d.events, ...newEvents], handoffs: [...d.handoffs, ...newHandoffs], audit: [...d.audit, ...entries] }));
    onProgress?.(items.length, items.length);
    return out;
  };
  const importMaster: Store['importMaster'] = async (m) => {
    const key = ({ locations: 'locations', collection_areas: 'collectionAreas', collectors: 'collectors', groups: 'groups' } as const)[m.kind];
    const items = (m.items as unknown as Record<string, unknown>[]).map((raw) => {
      const r = { ...raw };
      delete r._row;
      delete r.areaCode;
      return r as unknown as { id: string };
    });
    setDb((d) => {
      const byId = new Map((d[key] as { id: string }[]).map((x) => [x.id, x] as const));
      for (const it of items) byId.set(it.id, { ...byId.get(it.id), ...it });
      return audit({ ...d, [key]: [...byId.values()] } as DemoDB, { action: 'master.updated', summary: `Bulk upload: ${items.length} ${m.kind.replace('_', ' ')} saved (demo)` });
    });
    return { ok: true, count: items.length };
  };

  // ── user administration (demo: simulated; live: Edge Function + RPCs) ──
  const demoLink = (l: DemoLink, type: 'invite' | 'recovery'): string => {
    const token = randomToken().replace('tr-', 'demo-');
    saveLinks({ ...loadLinks(), [token]: l });
    return `${window.location.origin}${window.location.pathname}#/welcome?token_hash=${token}&type=${type}`;
  };
  const linkOrEmail = (delivery: Delivery, l: DemoLink, type: 'invite' | 'recovery'): LinkResult => {
    if (delivery === 'link') return { ok: true, link: demoLink(l, type) };
    toast('Demo mode: no email is sent. Use “Copy a link” to try the flow.', 'warn');
    return { ok: true, link: null };
  };

  const inviteUser: Store['inviteUser'] = async (i, delivery) => {
    const email = i.email.trim().toLowerCase();
    const cur = dbRef.current;
    if (cur.users.some((u) => u.email.toLowerCase() === email)) return { ok: false, error: 'An account with this email already exists.' };
    if (cur.invitations.some((x) => x.email.toLowerCase() === email && x.status === 'pending')) return { ok: false, error: 'There is already a pending invitation for this email.' };
    const now = new Date();
    const inv = { ...i, email, id: uid('inv'), status: 'pending' as const, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(), invitedBy: user?.id ?? 'system', demo: true };
    setDb((d) => audit({ ...d, invitations: [...d.invitations, inv] }, { action: 'user.invited', targetId: inv.id, summary: `Invitation created for ${email} as ${i.role} (demo)` }));
    return linkOrEmail(delivery, { kind: 'invite', invitationId: inv.id }, 'invite');
  };
  const resendInvite: Store['resendInvite'] = async (id, delivery) => {
    const now = new Date();
    // A new link replaces any earlier one for this invitation.
    saveLinks(Object.fromEntries(Object.entries(loadLinks()).filter(([, l]) => !(l.kind === 'invite' && l.invitationId === id))));
    setDb((d) =>
      audit(
        { ...d, invitations: d.invitations.map((x) => (x.id === id ? { ...x, status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString() } : x)) },
        { action: 'user.invitation-resent', targetId: id, summary: 'Invitation re-issued with a new link (demo)' },
      ),
    );
    return linkOrEmail(delivery, { kind: 'invite', invitationId: id }, 'invite');
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
  const passwordResetLink: Store['passwordResetLink'] = async (id, delivery) => {
    const u = dbRef.current.users.find((x) => x.id === id);
    if (!u || u.status !== 'active') return { ok: false, error: 'Reactivate the account first.' };
    setDb((d) => audit(d, { action: 'user.recovery-sent', targetId: id, summary: `Password reset link issued for ${u.email} (demo; IT never sees the password)` }));
    return linkOrEmail(delivery, { kind: 'recovery', userId: id }, 'recovery');
  };
  const resetMfa: Store['resetMfa'] = async (id) => {
    if (id === user?.id) return { ok: false, error: 'Ask another IT Admin to reset your own authenticator.' };
    setDb((d) => audit(d, { action: 'user.access-changed', targetId: id, summary: `Authenticator removed for ${d.users.find((u) => u.id === id)?.email} (demo)` }));
    toast('Authenticator removed. The user sets up a new one at their next sign-in (demo).');
    return ok;
  };

  const demoAccountState = (email: string): { state: AccountState; userId?: string; invitationId?: string } => {
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
  const inviteView = (invId: string): PendingInvite | null => {
    const inv = dbRef.current.invitations.find((x) => x.id === invId);
    if (!inv) return null;
    const places = new Map(dbRef.current.locations.map((l) => [l.id, l.name] as const));
    dbRef.current.collectionAreas.forEach((a) => places.set(a.id, a.name));
    return { invitationId: inv.id, email: inv.email, name: inv.name, role: inv.role, locationNames: inv.locationIds.map((id) => places.get(id) ?? id) };
  };
  const clearAuth = () => {
    setAuthStage(null);
    setPendingUser(null);
    setPendingInvite(null);
    setAccessIssue(null);
    setAuthEmail(null);
  };
  const finishSignIn = (id: string) => {
    clearAuth();
    setUserId(id);
  };

  // Demo authentication: nothing is sent anywhere, demo accounts accept any password and
  // any 6-digit code. The steps and rules (password policy, link → password →
  // authenticator) behave like the live flow.
  const auth: AuthApi = {
    signIn: async (email, password) => {
      if (!password) return { ok: false, error: 'Enter your password.' };
      const r = demoAccountState(email);
      if (r.state === 'active' && r.userId) {
        setUserId(null);
        setPendingUser(r.userId);
        setAuthEmail(email.trim().toLowerCase());
        setAuthStage('mfa-verify');
        return ok;
      }
      if (r.state === 'invited') return { ok: false, error: 'This email has a pending invitation. Open the invitation link from SFCL IT to set your password first.' };
      return { ok: false, error: 'Email or password is incorrect.' };
    },
    requestPasswordReset: async () => ok,
    acceptLink: async (token) => {
      const links = loadLinks();
      const l = links[token];
      if (!l) return { ok: false, error: 'This link has expired or was already used. Ask SFCL IT for a new one.' };
      delete links[token];
      saveLinks(links); // one-time
      setUserId(null);
      clearAuth();
      if (l.kind === 'invite') {
        const inv = dbRef.current.invitations.find((x) => x.id === l.invitationId && x.status === 'pending');
        if (!inv) return { ok: false, error: 'This invitation is no longer valid. Ask SFCL IT for a new one.' };
        setPendingInvite(inviteView(inv.id));
        setAuthEmail(inv.email);
      } else {
        const u = dbRef.current.users.find((x) => x.id === l.userId);
        if (!u) return { ok: false, error: 'Unknown account.' };
        setPendingUser(u.id);
        setAuthEmail(u.email);
        setAuthStage('set-password');
      }
      return ok;
    },
    setPassword: async () => {
      setAuthStage('mfa-verify');
      toast('Password saved (demo: not stored anywhere).');
      return ok;
    },
    acceptInvitation: async (invite, name) => {
      const inv = invite.invitationId ? dbRef.current.invitations.find((x) => x.id === invite.invitationId && x.status === 'pending') : undefined;
      if (!inv) return { ok: false, error: 'This invitation is no longer valid.' };
      const newUser: AppUser = { id: uid('u'), name: name.trim() || inv.name, email: inv.email, role: inv.role, locationIds: inv.locationIds, clientNames: inv.clientNames, status: 'active', demo: true };
      setDb((d) =>
        audit(
          { ...d, users: [...d.users, newUser], invitations: d.invitations.map((x) => (x.id === inv.id ? { ...x, status: 'accepted', acceptedAt: new Date().toISOString() } : x)) },
          { action: 'user.activated', actor: 'system', targetId: newUser.id, summary: `${newUser.email} accepted the invitation and set a password; preassigned role and locations activated` },
        ),
      );
      setPendingInvite(null);
      setPendingUser(newUser.id);
      setAuthStage('mfa-enroll');
      return ok;
    },
    startMfaEnrollment: async () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const a = new Uint8Array(32);
      crypto.getRandomValues(a);
      const secret = Array.from(a, (x) => alphabet[x % 32]).join('');
      const { default: QRCode } = await import('qrcode');
      const label = `Savannah%20Trace%20(demo):${encodeURIComponent(authEmail ?? 'demo')}`;
      const qr = await QRCode.toDataURL(`otpauth://totp/${label}?secret=${secret}&issuer=Savannah%20Trace%20(demo)`, { margin: 1, width: 200 });
      return { ok: true, enrollment: { factorId: 'demo-factor', qr, secret } };
    },
    confirmMfaEnrollment: async (_factorId, code) => {
      const bad = sixDigits(code);
      if (bad) return bad;
      if (pendingUser) finishSignIn(pendingUser);
      toast('Authenticator set up (demo: any 6 digits are accepted).');
      return ok;
    },
    verifyMfa: async (code) => {
      const bad = sixDigits(code);
      if (bad) return bad;
      if (!pendingUser) return { ok: false, error: 'Sign in again.' };
      finishSignIn(pendingUser);
      return ok;
    },
    changePassword: async (current, code) => {
      if (!current) return { ok: false, error: 'Enter your current password.' };
      const bad = sixDigits(code);
      if (bad) return bad;
      toast('Password changed (demo: not stored anywhere).');
      return ok;
    },
    signOutOtherDevices: async () => {
      toast('Demo mode: there are no other devices.');
      return ok;
    },
  };

  const value: Store = {
    mode: 'demo',
    auth,
    authStage,
    authEmail: authEmail ?? user?.email ?? null,
    accessIssue,
    pendingInvite,
    db,
    analysis,
    user,
    viewer,
    role: user?.role ?? 'nut-fo',
    loading: false,
    toasts,
    toast,
    recordEvent,
    recordEvents,
    importMaster,
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
    passwordResetLink,
    resetMfa,
    signOut: async () => {
      clearAuth();
      setUserId(null);
    },
    switchUser: (id) => setUserId(id),
    reset: () => {
      setDb(buildSeed());
      toast('Demo data reset to the original sample scenario.');
    },
    refresh: async () => undefined,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
