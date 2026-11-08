import { Copy, Info, KeyRound, MailPlus, Pencil, RotateCw, ShieldOff, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { DemoBadge, Field, Modal } from '../components/ui';
import type { AppUser, Invitation, RoleId } from '../data/types';
import { fmtRecorded } from '../domain/format';
import { ROLES, ROLE_ORDER } from '../domain/roles';
import { useSession } from '../domain/store';
import type { Delivery, LinkResult } from '../domain/storeTypes';

const CLIENTS = ['DEMO Lumière Naturals B.V.', 'DEMO Nordhavn Personal Care A/S'];

/** A one-time link to show IT once, to send to one person. */
interface IssuedLink {
  title: string;
  email: string;
  link: string;
  kind: 'invite' | 'recovery';
}

export function Users() {
  const { db, analysis, mode, setUserStatus, passwordResetLink, resetMfa, resendInvite, revokeInvite, user: me, toast } = useSession();
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<AppUser | null>(null);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [confirm, setConfirm] = useState<{ user: AppUser; what: 'password' | 'mfa' } | null>(null);
  const showLink = (r: LinkResult, l: Omit<IssuedLink, 'link'>) => {
    if (r.ok && r.link) setIssued({ ...l, link: r.link });
    else if (!r.ok && r.error) toast(r.error, 'error');
  };
  const loc = (id: string) => analysis.places.get(id)?.name.replace(/^DEMO /, '') ?? id;
  const locList = (ids: string[]) => (ids.length > 3 ? `${ids.slice(0, 3).map(loc).join(', ')} +${ids.length - 3}` : ids.map(loc).join(', ') || '—');
  const pending = db.invitations.filter((i) => i.status === 'pending').length;
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    if (!r.ok && r.error) toast(r.error, 'error');
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Users & access</h1>
          <p>Invite people, assign one role and their locations, and suspend access when someone leaves. Their records stay in the audit history.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setInvite(true)}>
          <MailPlus size={16} /> Invite user
        </button>
      </div>

      <div className="notice info">
        <Info size={18} style={{ flex: 'none' }} />
        <div className="small">
          <b>Invitation only.</b> You create an invitation and send the person its one-time link (it works once and expires after 24 hours). They choose their own password and
          set up an authenticator app; every sign-in then needs both. IT never sees or sets a password. If someone forgets theirs, issue a password reset link; if they lose their
          phone, reset their authenticator. Suspending someone blocks database access immediately and revokes their sessions.
          {mode === 'demo' && (
            <>
              {' '}
              <b>Demo mode:</b> nothing is emailed; links work only in this browser.
            </>
          )}
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
          Users ({db.users.length})
        </button>
        <button className={`tab ${tab === 'invites' ? 'active' : ''}`} onClick={() => setTab('invites')}>
          Invitations ({pending} pending)
        </button>
      </div>

      {tab === 'users' && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Assigned scope</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {db.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <b>{u.name}</b>
                    <DemoBadge show={u.demo} />
                    <div className="tiny muted">{u.email}</div>
                  </td>
                  <td>{ROLES[u.role].label}</td>
                  <td className="small">{u.role === 'commercial' ? u.clientNames.join(', ') || '—' : locList(u.locationIds)}</td>
                  <td>
                    <span className={`status ${u.status === 'active' ? 'ok' : 'bad'}`}>{u.status === 'active' ? 'Active' : 'Suspended'}</span>
                  </td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEdit(u)} disabled={u.id === me.id}>
                      <Pencil size={13} /> Access
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirm({ user: u, what: 'password' })} disabled={u.status !== 'active' || u.id === me.id} title="One-time link with which the user chooses a new password">
                      <KeyRound size={13} /> Reset password
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirm({ user: u, what: 'mfa' })} disabled={u.id === me.id} title="Lost or new phone: remove their authenticator">
                      <Smartphone size={13} /> Reset authenticator
                    </button>
                    {u.status === 'active' ? (
                      <button className="btn btn-sm btn-ghost btn-danger" disabled={u.id === me.id} onClick={() => act(setUserStatus(u.id, 'suspended'))}>
                        <ShieldOff size={13} /> Suspend
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-ghost" onClick={() => act(setUserStatus(u.id, 'active'))}>
                        <ShieldCheck size={13} /> Reactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'invites' && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role & scope</th>
                <th>Status</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {db.invitations.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No invitations yet.
                  </td>
                </tr>
              )}
              {[...db.invitations].reverse().map((i) => (
                <InviteRow
                  key={i.id}
                  i={i}
                  locList={locList}
                  onResend={async () => showLink(await resendInvite(i.id, 'link'), { title: 'New invitation link', email: i.email, kind: 'invite' })}
                  onRevoke={() => act(revokeInvite(i.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {invite && (
        <InviteModal
          onClose={() => setInvite(false)}
          onLink={(email, link) => {
            setInvite(false);
            setIssued({ title: 'Invitation created', email, link, kind: 'invite' });
          }}
        />
      )}
      {edit && <AccessModal user={edit} onClose={() => setEdit(null)} />}
      {issued && <LinkModal issued={issued} onClose={() => setIssued(null)} />}
      {confirm && (
        <Modal title={confirm.what === 'password' ? `Reset password for ${confirm.user.name}?` : `Reset authenticator for ${confirm.user.name}?`} onClose={() => setConfirm(null)}>
          <div className="stack">
            {confirm.what === 'password' ? (
              <p className="small">
                You get a one-time link to send to <b>{confirm.user.email}</b>. With it they choose a new password themselves (you never see it). Their current password keeps working
                until they use the link. They still need their authenticator app to sign in.
              </p>
            ) : (
              <p className="small">
                Use this when <b>{confirm.user.name}</b> lost or replaced their phone. Their authenticator is removed now; at their next sign-in (with their password) they set up the
                app again on the new phone. Confirm who is asking before you do this, by phone or in person.
              </p>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const c = confirm;
                  setConfirm(null);
                  if (c.what === 'password') showLink(await passwordResetLink(c.user.id, 'link'), { title: 'Password reset link', email: c.user.email, kind: 'recovery' });
                  else act(resetMfa(c.user.id));
                }}
              >
                {confirm.what === 'password' ? 'Create reset link' : 'Reset authenticator'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InviteRow({ i, locList, onResend, onRevoke }: { i: Invitation; locList: (ids: string[]) => string; onResend: () => void; onRevoke: () => void }) {
  const expired = i.status === 'expired' || (i.status === 'pending' && new Date(i.expiresAt).getTime() < Date.now());
  const status = expired ? 'Expired' : i.status === 'pending' ? 'Pending' : i.status === 'accepted' ? 'Accepted' : 'Revoked';
  return (
    <tr>
      <td>
        {i.email}
        <DemoBadge show={i.demo} />
        <div className="tiny muted">{i.name}</div>
      </td>
      <td className="small">
        {ROLES[i.role].label} · {i.role === 'commercial' ? i.clientNames.join(', ') : locList(i.locationIds)}
      </td>
      <td>
        <span className={`status ${status === 'Pending' ? 'wait' : status === 'Accepted' ? 'ok' : 'bad'}`}>{status}</span>
      </td>
      <td className="small nowrap">{fmtRecorded(i.expiresAt)}</td>
      <td className="nowrap" style={{ textAlign: 'right' }}>
        {(status === 'Pending' || status === 'Expired') && (
          <button className="btn btn-sm btn-ghost" onClick={onResend} title="Creates a new one-time link; the previous link stops working">
            <RotateCw size={13} /> New link
          </button>
        )}
        {status === 'Pending' && (
          <button className="btn btn-sm btn-ghost btn-danger" onClick={onRevoke}>
            <XCircle size={13} /> Revoke
          </button>
        )}
      </td>
    </tr>
  );
}

function ScopePicker({ role, locationIds, setLocationIds, clientNames, setClientNames }: { role: RoleId; locationIds: string[]; setLocationIds: (v: string[]) => void; clientNames: string[]; setClientNames: (v: string[]) => void }) {
  const { analysis } = useSession();
  if (role === 'commercial')
    return (
      <Field label="Clients this user may see">
        <div className="stack-sm">
          {CLIENTS.map((c) => (
            <label key={c} className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={clientNames.includes(c)} onChange={(e) => setClientNames(e.target.checked ? [...clientNames, c] : clientNames.filter((x) => x !== c))} /> {c}
            </label>
          ))}
        </div>
      </Field>
    );
  const kindsFor: Record<RoleId, string[]> = {
    'nut-fo': ['collection-area', 'phc'],
    'butter-fo': ['butter-centre', 'warehouse'],
    'supply-chain': ['port', 'terminal', 'destination-warehouse', 'refiner', 'filterer', 'client', 'warehouse'],
    commercial: [],
    'it-admin': ['collection-area', 'phc', 'butter-centre', 'warehouse', 'port', 'terminal', 'destination-warehouse', 'refiner', 'filterer', 'client'],
    auditor: ['collection-area', 'phc', 'butter-centre', 'warehouse', 'port', 'terminal', 'destination-warehouse', 'refiner', 'filterer', 'client'],
  };
  const options = [...analysis.places.values()].filter((p) => kindsFor[role].includes(p.kind));
  return (
    <Field label={role === 'auditor' ? 'Audit scope (explicit assignment)' : 'Assigned locations'} hint="the user sees only these">
      <div className="stack-sm scope-list">
        {options.map((p) => (
          <label key={p.id} className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={locationIds.includes(p.id)} onChange={(e) => setLocationIds(e.target.checked ? [...locationIds, p.id] : locationIds.filter((x) => x !== p.id))} />
            {p.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

function InviteModal({ onClose, onLink }: { onClose: () => void; onLink: (email: string, link: string) => void }) {
  const { inviteUser, toast } = useSession();
  const [delivery, setDelivery] = useState<Delivery>('link');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<RoleId>('butter-fo');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [clientNames, setClientNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());
  const scopeOk = role === 'commercial' ? clientNames.length > 0 : role === 'it-admin' || locationIds.length > 0;
  return (
    <Modal title="Invite a user" onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Work email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value as RoleId);
                setLocationIds([]);
              }}
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLES[r].label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ScopePicker role={role} locationIds={locationIds} setLocationIds={setLocationIds} clientNames={clientNames} setClientNames={setClientNames} />
        <Field label="How to deliver the invitation">
          <div className="stack-sm small">
            <label className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input type="radio" name="delivery" checked={delivery === 'link'} onChange={() => setDelivery('link')} />
              <span>
                <b>Copy a one-time link</b> and send it to the person yourself (Teams, WhatsApp or email). Recommended: works today.
              </span>
            </label>
            <label className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input type="radio" name="delivery" checked={delivery === 'email'} onChange={() => setDelivery('email')} />
              <span>
                <b>Email it from Savannah Trace.</b> Only once the company email service is connected (docs/SUPABASE_SETUP.md, step 4).
              </span>
            </label>
          </div>
        </Field>
        <p className="tiny muted">Their role and scope are set here, on the server. They cannot choose or change them. They choose their own password; you never see it.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!validEmail || !name.trim() || !scopeOk || busy}
            onClick={async () => {
              setBusy(true);
              const r = await inviteUser({ email, name: name.trim(), role, locationIds, clientNames }, delivery);
              setBusy(false);
              if (r.ok && r.link) onLink(email.trim().toLowerCase(), r.link);
              else if (r.ok) onClose();
              else toast(r.error ?? 'Could not create the invitation.', 'error');
            }}
          >
            {delivery === 'link' ? 'Create invitation' : 'Send invitation email'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AccessModal({ user, onClose }: { user: AppUser; onClose: () => void }) {
  const { setUserAccess } = useSession();
  const [role, setRole] = useState<RoleId>(user.role);
  const [locationIds, setLocationIds] = useState(user.locationIds);
  const [clientNames, setClientNames] = useState(user.clientNames);
  return (
    <Modal title={`Access for ${user.name}`} onClose={onClose}>
      <div className="stack">
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {ROLES[r].label}
              </option>
            ))}
          </select>
        </Field>
        <ScopePicker role={role} locationIds={locationIds} setLocationIds={setLocationIds} clientNames={clientNames} setClientNames={setClientNames} />
        <p className="tiny muted">Changes take effect on the user's next request. The change is recorded in the audit history.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              if ((await setUserAccess(user.id, role, locationIds, clientNames)).ok) onClose();
            }}
          >
            Save access
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Shows a one-time link once. It is not stored anywhere in the app; closing the window forgets it. */
function LinkModal({ issued, onClose }: { issued: IssuedLink; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
    } catch {
      ref.current?.select();
    }
  };
  return (
    <Modal title={issued.title} onClose={onClose}>
      <div className="stack">
        <p className="small">
          Send this link to <b>{issued.email}</b> only. {issued.kind === 'invite' ? 'They will confirm their name, choose a password and set up their authenticator app.' : 'They will choose a new password.'}
        </p>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input ref={ref} className="mono link-field" readOnly value={issued.link} onFocus={(e) => e.currentTarget.select()} aria-label="One-time link" />
          <button className="btn btn-primary" onClick={copy}>
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <ul className="small stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Works <b>once</b> and expires after <b>24 hours</b>. If it expires, create a new one here.
          </li>
          <li>Send it privately to that person (direct message or their own email), not to a group.</li>
          <li>Whoever opens it first can use it, so treat it like a key. It is not shown again after you close this window.</li>
        </ul>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
