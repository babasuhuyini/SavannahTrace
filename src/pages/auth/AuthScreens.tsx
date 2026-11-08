import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, KeyRound, LifeBuoy, Lock, LogIn, Mail, ShieldCheck, ShieldOff, Smartphone, UserX, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrandMark, Wordmark } from '../../components/Brand';
import { CodeInput, PasswordFields, PasswordInput, type PasswordFieldsHandle } from '../../components/PasswordFields';
import { ROLES } from '../../domain/roles';
import { useStore } from '../../domain/store';
import type { AccessIssue, MfaEnrollment, PendingInvite } from '../../domain/storeTypes';
import { go } from '../../router';

/**
 * Sign-in and account set-up. Invitation only: there is no public sign-up.
 *
 *  Invited person:  invitation link → confirm name + create password → set up authenticator app → in
 *  Returning user:  email + password → 6-digit code from the authenticator app → in
 *  Forgot password: reset link (self-service email, or from IT) → new password → authenticator code → in
 *
 * Every form posts with method="post" and is handled in script, so a password can never end
 * up in the address bar or browser history, even if a script fails to load.
 */
export function AuthScreens() {
  const store = useStore();
  const { mode, authStage, pendingInvite, accessIssue } = store;
  const [view, setView] = useState<'signin' | 'forgot'>('signin');
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const off = () => setOffline(true);
    const on = () => setOffline(false);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, []);

  let content: ReactNode;
  if (offline || accessIssue) content = <IssueScreen issue={offline ? 'offline' : accessIssue!} />;
  else if (pendingInvite) content = <AcceptInvite invite={pendingInvite} />;
  else if (authStage === 'set-password') content = <SetPassword />;
  else if (authStage === 'mfa-enroll') content = <MfaEnroll />;
  else if (authStage === 'mfa-verify') content = <MfaVerify />;
  else if (view === 'forgot') content = <Forgot onBack={() => setView('signin')} />;
  else content = <SignIn onForgot={() => setView('forgot')} />;

  return (
    <AuthFrame>
      {mode === 'demo' && store.user && !authStage && !pendingInvite && (
        <button className="link-btn small" style={{ marginBottom: 12 }} onClick={() => go('/')}>
          <ArrowLeft size={13} style={{ verticalAlign: -2 }} /> Back to the app (demo)
        </button>
      )}
      {content}
    </AuthFrame>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  const { mode } = useStore();
  return (
    <div className="auth-page">
      {mode === 'demo' && (
        <div className="demo-strip">
          <AlertTriangle size={14} /> <strong>DEMO MODE</strong> Sign-in is simulated in this browser. No password or code is sent or stored anywhere.
        </div>
      )}
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size={30} />
            <Wordmark />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

const Err = ({ text }: { text: string }) =>
  text ? (
    <p className="auth-error" role="alert">
      {text}
    </p>
  ) : null;

function SignIn({ onForgot }: { onForgot: () => void }) {
  const { auth, mode } = useStore();
  const [email, setEmail] = useState('');
  const pw = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const password = pw.current?.value ?? '';
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    setError('');
    const r = await auth.signIn(email, password);
    if (pw.current) pw.current.value = '';
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Email or password is incorrect.');
      pw.current?.focus();
    }
  };
  return (
    <form method="post" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted small" style={{ marginBottom: 16 }}>
        Access is by invitation from SFCL IT.
      </p>
      {mode === 'demo' && (
        <div className="auth-demo">
          <b>Demo:</b> sign in as <code>butter.tamba@demo-sfcl.invalid</code> or <code>it.admin@demo-sfcl.invalid</code> with any password, then any 6 digits. To try a new account, sign in as IT
          Admin and invite someone under Users &amp; access.
        </div>
      )}
      <div className="stack-sm">
        <label className="field">
          <span>Work email</span>
          <input type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus spellCheck={false} autoCapitalize="off" />
        </label>
        <PasswordInput ref={pw} label="Password" autoComplete="current-password" />
      </div>
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={busy}>
        <LogIn size={16} /> {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="auth-note">
        <button type="button" className="link-btn" onClick={onForgot}>
          Forgot your password?
        </button>
      </p>
      <p className="auth-note">After your password you'll enter a 6-digit code from your authenticator app. SFCL will never ask you for your password or code.</p>
    </form>
  );
}

function Forgot({ onBack }: { onBack: () => void }) {
  const { auth } = useStore();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (sent)
    return (
      <div>
        <h1>Check your email</h1>
        <div className="stack-sm small" style={{ marginTop: 10 }}>
          <p>
            If <b>{email.trim()}</b> has a Savannah Trace account, a password reset link is on its way. It works once and expires after 24 hours.
          </p>
          <p>
            <b>No email after a few minutes?</b> Check spam, then ask SFCL IT. They can give you a reset link directly. IT can never see or choose your password.
          </p>
        </div>
        <button className="btn btn-block" style={{ marginTop: 18 }} onClick={onBack}>
          <ArrowLeft size={14} /> Back to sign in
        </button>
      </div>
    );
  return (
    <form
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const r = await auth.requestPasswordReset(email);
        setBusy(false);
        if (!r.ok) return setError(r.error ?? 'Could not send the email. Try again later.');
        setSent(true);
      }}
    >
      <button type="button" className="link-btn small" onClick={onBack}>
        <ArrowLeft size={13} style={{ verticalAlign: -2 }} /> Back to sign in
      </button>
      <h1 style={{ marginTop: 10 }}>Reset your password</h1>
      <p className="muted small" style={{ marginBottom: 16 }}>
        We'll email you a one-time link to choose a new password. You will still need your authenticator app to sign in.
      </p>
      <label className="field">
        <span>Work email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus spellCheck={false} autoCapitalize="off" />
      </label>
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={busy || !email.trim()}>
        <Mail size={16} /> Email me a reset link
      </button>
      <p className="auth-note">Lost your phone with the authenticator app? A password reset does not help — ask SFCL IT to reset your authenticator.</p>
    </form>
  );
}

function SignOutLink({ label = 'Use a different account' }: { label?: string }) {
  const { signOut } = useStore();
  return (
    <button type="button" className="link-btn" onClick={() => signOut().then(() => go('/'))}>
      {label}
    </button>
  );
}

function MfaVerify() {
  const { auth, authEmail } = useStore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (c = code) => {
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    const r = await auth.verifyMfa(c);
    setBusy(false);
    if (!r.ok) {
      setCode('');
      setError(r.error ?? 'That code is not right.');
    } else go('/');
  };
  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1>Enter your authenticator code</h1>
      <p className="muted small" style={{ marginBottom: 16 }}>
        Open the authenticator app on your phone and enter the 6-digit code for <b>Savannah Trace{authEmail ? ` (${authEmail})` : ''}</b>. A new code appears every 30 seconds.
      </p>
      <label className="field">
        <span>6-digit code</span>
        <CodeInput
          value={code}
          onChange={(v) => {
            setCode(v);
            if (v.length === 6) submit(v);
          }}
        />
      </label>
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={busy || code.length !== 6}>
        <ShieldCheck size={16} /> {busy ? 'Checking…' : 'Verify and continue'}
      </button>
      <p className="auth-note">
        Lost or replaced your phone? Ask SFCL IT to reset your authenticator. · <SignOutLink />
      </p>
    </form>
  );
}

function MfaEnroll() {
  const { auth, authEmail } = useStore();
  const [enr, setEnr] = useState<MfaEnrollment | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    auth.startMfaEnrollment().then((r) => (r.ok && r.enrollment ? setEnr(r.enrollment) : setError(r.error ?? 'Could not start the setup.')));
  }, [auth]);
  return (
    <form
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!enr || code.length !== 6) return;
        setBusy(true);
        setError('');
        const r = await auth.confirmMfaEnrollment(enr.factorId, code);
        setBusy(false);
        if (!r.ok) {
          setCode('');
          setError(r.error ?? 'That code is not right.');
        } else go('/');
      }}
    >
      <h1>Set up your authenticator app</h1>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Savannah Trace uses two-step sign-in: your password plus a code from your phone. This is required for everyone and takes about a minute.
      </p>
      <ol className="steps">
        <li>
          <b>Install an authenticator app</b> on your phone if you don't have one: <i>Microsoft Authenticator</i> or <i>Google Authenticator</i> (both free).
        </li>
        <li>
          <b>Scan this QR code</b> in the app (Add account → scan QR code).
          <div className="qr-box">
            {enr ? <img src={enr.qr} width={176} height={176} alt="QR code to add Savannah Trace to your authenticator app" /> : <span className="tiny muted">{error ? '—' : 'Preparing…'}</span>}
          </div>
          {enr && (
            <div className="tiny">
              {showKey ? (
                <>
                  Can't scan? In the app choose “enter a setup key”, account <b>{authEmail ?? 'Savannah Trace'}</b>, key:
                  <code className="setup-key">{enr.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                  <span className="muted">Keep this key private — anyone with it can create your codes.</span>
                </>
              ) : (
                <button type="button" className="link-btn" onClick={() => setShowKey(true)}>
                  Can't scan the code?
                </button>
              )}
            </div>
          )}
        </li>
        <li>
          <b>Enter the 6-digit code</b> the app now shows for Savannah Trace.
          <div style={{ marginTop: 8 }}>
            <CodeInput value={code} onChange={setCode} autoFocus={false} />
          </div>
        </li>
      </ol>
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 14 }} disabled={busy || !enr || code.length !== 6}>
        <Smartphone size={16} /> {busy ? 'Checking…' : 'Confirm and finish'}
      </button>
      <p className="auth-note">
        If you lose this phone, SFCL IT can reset your authenticator. · <SignOutLink label="Sign out" />
      </p>
    </form>
  );
}

function SetPassword() {
  const { auth, authEmail } = useStore();
  const fields = useRef<PasswordFieldsHandle>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [valid, setValid] = useState(false);
  return (
    <form
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!fields.current) return;
        setBusy(true);
        setError('');
        const r = await fields.current.read();
        if (!r.ok) {
          setBusy(false);
          return setError(r.error);
        }
        const s = await auth.setPassword(r.password);
        fields.current?.clear();
        setBusy(false);
        if (!s.ok) setError(s.error ?? 'The password could not be saved.');
      }}
    >
      <h1>Choose a new password</h1>
      <p className="muted small" style={{ marginBottom: 16 }}>
        For <b>{authEmail}</b>. Use a password you don't use anywhere else. Next, you'll confirm with your authenticator app.
      </p>
      {/* lets password managers save the new password against the right account */}
      <input type="email" name="username" autoComplete="username" value={authEmail ?? ''} readOnly hidden />
      <PasswordFields ref={fields} email={authEmail ?? undefined} onValidChange={setValid} autoFocus />
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={busy || !valid}>
        <KeyRound size={16} /> {busy ? 'Saving…' : 'Save password'}
      </button>
      <p className="auth-note">
        <SignOutLink label="Cancel and sign out" />
      </p>
    </form>
  );
}

function AcceptInvite({ invite }: { invite: PendingInvite }) {
  const { auth, mode } = useStore();
  const [name, setName] = useState(invite.name);
  const fields = useRef<PasswordFieldsHandle>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [valid, setValid] = useState(false);
  return (
    <form
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!fields.current) return;
        setBusy(true);
        setError('');
        const r = await fields.current.read();
        if (!r.ok) {
          setBusy(false);
          return setError(r.error);
        }
        const a = await auth.acceptInvitation(invite, name.trim(), r.password);
        fields.current?.clear();
        setBusy(false);
        if (!a.ok) setError(a.error ?? 'Could not activate the account.');
      }}
    >
      <div className="notice ok" style={{ marginBottom: 14 }}>
        <CheckCircle2 size={18} />
        <span>
          Invitation for <b>{invite.email}</b>
        </span>
      </div>
      <h1>Create your account</h1>
      <p className="muted small" style={{ marginBottom: 14 }}>
        SFCL IT invited you with the access below. If anything looks wrong, contact IT before continuing.
      </p>
      {mode === 'demo' && <div className="auth-demo">Demo: the password is checked against the rules but not stored anywhere.</div>}
      <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>Role</dt>
        <dd>{ROLES[invite.role].label}</dd>
        <dt>Locations</dt>
        <dd>{invite.locationNames.length ? invite.locationNames.join(', ') : '—'}</dd>
      </dl>
      <div className="stack-sm">
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </label>
        <input type="email" name="username" autoComplete="username" value={invite.email} readOnly hidden />
        <PasswordFields ref={fields} email={invite.email} name={name} label="Create a password" onValidChange={setValid} />
      </div>
      <Err text={error} />
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={busy || !name.trim() || !valid}>
        {busy ? 'Saving…' : 'Create account'}
      </button>
      <p className="auth-note">
        Next: set up an authenticator app on your phone. · <SignOutLink label="Cancel" />
      </p>
    </form>
  );
}

function IssueScreen({ issue }: { issue: AccessIssue }) {
  const { authEmail } = useStore();
  const content: Record<AccessIssue, { icon: ReactNode; title: string; body: ReactNode }> = {
    suspended: { icon: <ShieldOff size={22} />, title: 'Access suspended', body: 'Your SFCL account is suspended, so no data is available. Your past records are kept. Contact SFCL IT if you think this is a mistake.' },
    'no-access': {
      icon: <UserX size={22} />,
      title: 'No access for this account',
      body: (
        <>
          {authEmail ? <b>{authEmail}</b> : 'This account'} has no SFCL invitation. Access is by invitation only — ask SFCL IT to invite your work email.
        </>
      ),
    },
    'no-locations': { icon: <Lock size={22} />, title: 'No locations assigned yet', body: 'Your account is active but IT has not assigned any locations, so there is nothing to show. Ask SFCL IT to assign your centre or area.' },
    'expired-invite': { icon: <Clock size={22} />, title: 'Invitation expired', body: 'This invitation is no longer valid. Ask SFCL IT for a new invitation link.' },
    'wrong-email': { icon: <AlertTriangle size={22} />, title: 'Different account', body: 'This link belongs to a different email address. Sign out and open the link again.' },
    offline: { icon: <WifiOff size={22} />, title: "You're offline", body: 'Sign-in needs a connection. Your data is safe — reconnect and try again.' },
  };
  const c = content[issue];
  return (
    <div>
      <div className="notice danger" style={{ marginBottom: 14, alignItems: 'center' }}>
        {c.icon}
        <b>{c.title}</b>
      </div>
      <p className="small">{c.body}</p>
      <div className="row" style={{ marginTop: 18 }}>
        {issue !== 'offline' && <SignOutLink />}
        <a className="btn btn-ghost" href="mailto:">
          <LifeBuoy size={14} /> Contact IT
        </a>
      </div>
    </div>
  );
}

/**
 * Landing page for one-time invitation / password-reset links (#/welcome?token_hash=…&type=…).
 * The token is taken out of the address bar immediately, and it is only used when the person
 * clicks Continue — so email security scanners that pre-open links cannot use it up.
 */
export function LinkLanding({ tokenHash, type }: { tokenHash: string; type: string }) {
  const store = useStore();
  const [token] = useState(tokenHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind: 'invite' | 'recovery' = type === 'recovery' ? 'recovery' : 'invite';
  useEffect(() => {
    if (tokenHash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/welcome?type=${kind}`);
  }, [tokenHash, kind]);
  return (
    <AuthFrame>
      <h1>{kind === 'invite' ? 'Welcome to Savannah Trace' : 'Reset your password'}</h1>
      <p className="muted small" style={{ marginBottom: 16 }}>
        {kind === 'invite'
          ? 'SFCL IT has invited you. Next you will confirm your name, choose your own password and set up an authenticator app on your phone.'
          : 'You will choose a new password. Your authenticator app is still needed to sign in afterwards.'}
      </p>
      {store.user && (
        <div className="notice amber small" style={{ marginBottom: 12 }}>
          Someone is signed in on this browser ({store.user.email}). Continuing signs them out first.
        </div>
      )}
      {!token ? (
        <Err text="This link is incomplete or was already opened. Open the full link you were sent, or ask SFCL IT for a new one." />
      ) : (
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            if (store.user) await store.signOut();
            const r = await store.auth.acceptLink(token, kind);
            setBusy(false);
            if (!r.ok) return setError(r.error ?? 'This link has expired or was already used.');
            go('/');
          }}
        >
          {busy ? 'Checking the link…' : 'Continue'}
        </button>
      )}
      <Err text={error} />
      <p className="auth-note">The link works once and expires after 24 hours. It is for you alone — don't forward it.</p>
    </AuthFrame>
  );
}
