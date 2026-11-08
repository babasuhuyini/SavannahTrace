import { Info, MailPlus, Pencil, RotateCw, ShieldOff, ShieldCheck, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { DemoBadge, Field, Modal } from '../components/ui';
import type { AppUser, Invitation, RoleId } from '../data/types';
import { fmtRecorded } from '../domain/format';
import { ROLES, ROLE_ORDER } from '../domain/roles';
import { useSession } from '../domain/store';

const CLIENTS = ['DEMO Lumière Naturals B.V.', 'DEMO Nordhavn Personal Care A/S'];

export function Users() {
  const { db, analysis, mode, setUserStatus, sendRecovery, resendInvite, revokeInvite, user: me, toast } = useSession();
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<AppUser | null>(null);
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
          <b>Invitation only, no passwords.</b> People sign in with a one-time email code (expires in 10 minutes; resend after 30 s; rate-limited) or with the Google account matching
          their invited email. IT never sees or sets a password or code. Suspending someone blocks database access immediately and revokes their sessions.
          {mode === 'demo' && (
            <>
              {' '}
              <b>Demo mode:</b> nothing is emailed; changes stay in this browser.
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
                    <button className="btn btn-sm btn-ghost" onClick={() => act(sendRecovery(u.id))} disabled={u.status !== 'active'} title="Sends the user a fresh verified sign-in; no password is involved">
                      <Send size={13} /> Recovery
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
                <InviteRow key={i.id} i={i} locList={locList} onResend={() => act(resendInvite(i.id))} onRevoke={() => act(revokeInvite(i.id))} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {invite && <InviteModal onClose={() => setInvite(false)} />}
      {edit && <AccessModal user={edit} onClose={() => setEdit(null)} />}
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
          <button className="btn btn-sm btn-ghost" onClick={onResend}>
            <RotateCw size={13} /> Resend
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

function InviteModal({ onClose }: { onClose: () => void }) {
  const { inviteUser, toast } = useSession();
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
        <p className="tiny muted">The invitation email asks the person to verify their address. Their role and scope are set here, on the server — they cannot choose or change them.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!validEmail || !name.trim() || !scopeOk || busy}
            onClick={async () => {
              setBusy(true);
              const r = await inviteUser({ email, name: name.trim(), role, locationIds, clientNames });
              setBusy(false);
              if (r.ok) onClose();
              else toast(r.error ?? 'Could not create the invitation.', 'error');
            }}
          >
            Send invitation
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
