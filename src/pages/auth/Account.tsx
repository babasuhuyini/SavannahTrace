import { KeyRound, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { useRef, useState } from 'react';
import { CodeInput, PasswordFields, PasswordInput, type PasswordFieldsHandle } from '../../components/PasswordFields';
import { ROLES } from '../../domain/roles';
import { useSession } from '../../domain/store';

/** My account: change password (current password + authenticator code required), sign out elsewhere. */
export function Account() {
  const { user, auth } = useSession();
  const current = useRef<HTMLInputElement>(null);
  const fields = useRef<PasswordFieldsHandle>(null);
  const [code, setCode] = useState('');
  const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h1>My account</h1>
          <p>
            {user.name} · {user.email} · {ROLES[user.role].label}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Change password</h3>
        </div>
        <form
          className="card-body stack-sm"
          method="post"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!fields.current) return;
            const cur = current.current?.value ?? '';
            if (!cur) return setError('Enter your current password.');
            if (code.length !== 6) return setError('Enter the 6-digit code from your authenticator app.');
            setBusy(true);
            setError('');
            setDone(false);
            const r = await fields.current.read();
            if (!r.ok) {
              setBusy(false);
              return setError(r.error);
            }
            const c = await auth.changePassword(cur, code, r.password);
            if (current.current) current.current.value = '';
            fields.current?.clear();
            setCode('');
            setBusy(false);
            if (!c.ok) setError(c.error ?? 'The password could not be changed.');
            else setDone(true);
          }}
        >
          <p className="small muted">For your security you need your current password and a code from your authenticator app. Other devices are signed out afterwards.</p>
          <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
          <div className="form-grid">
            <PasswordInput ref={current} label="Current password" autoComplete="current-password" />
            <label className="field">
              <span>Authenticator code</span>
              <CodeInput value={code} onChange={setCode} autoFocus={false} />
            </label>
          </div>
          <PasswordFields ref={fields} email={user.email} name={user.name} onValidChange={setValid} />
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {done && <div className="ok-box">Password changed.</div>}
          <div>
            <button className="btn btn-primary" disabled={busy || !valid}>
              <KeyRound size={15} /> {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Two-step sign-in</h3>
        </div>
        <div className="card-body stack-sm small">
          <p className="row" style={{ gap: 8 }}>
            <ShieldCheck size={16} style={{ color: 'var(--forest-2)' }} /> Your account is protected by an authenticator app. It is required for every account and cannot be turned off.
          </p>
          <p className="row" style={{ gap: 8 }}>
            <Smartphone size={16} /> New or lost phone? Ask SFCL IT to reset your authenticator; you will set up the new phone at your next sign-in.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Sessions</h3>
        </div>
        <div className="card-body stack-sm small">
          <p>Signed in on a shared or lost device? Sign out everywhere except here.</p>
          <div>
            <button className="btn" onClick={() => auth.signOutOtherDevices()}>
              <LogOut size={14} /> Sign out other devices
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
