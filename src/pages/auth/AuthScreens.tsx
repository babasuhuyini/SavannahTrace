import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, KeyRound, LifeBuoy, Lock, Mail, ShieldOff, UserX, WifiOff } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark, Wordmark } from '../../components/Brand';
import { ROLES } from '../../domain/roles';
import { useStore } from '../../domain/store';
import type { AccessIssue, PendingInvite } from '../../domain/storeTypes';
import { go } from '../../router';

type Step = { s: 'email' } | { s: 'code'; email: string } | { s: 'accept'; invite: PendingInvite } | { s: 'issue'; issue: AccessIssue; email?: string } | { s: 'recover' };

/**
 * Sign-in and account activation. Invitation-only: there is no public sign-up.
 * Passwordless: email one-time code or Google, so there is no password for anyone
 * (including IT) to see, set or reset.
 */
export function AuthScreens() {
  const store = useStore();
  const { auth, mode } = store;
  const [step, setStep] = useState<Step>(() => (store.pendingInvite ? { s: 'accept', invite: store.pendingInvite } : store.accessIssue ? { s: 'issue', issue: store.accessIssue } : { s: 'email' }));
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (store.pendingInvite) setStep({ s: 'accept', invite: store.pendingInvite });
    else if (store.accessIssue) setStep({ s: 'issue', issue: store.accessIssue });
  }, [store.pendingInvite, store.accessIssue]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => {
    const off = () => setStep({ s: 'issue', issue: 'offline' });
    window.addEventListener('offline', off);
    return () => window.removeEventListener('offline', off);
  }, []);

  const send = async (target = email) => {
    setBusy(true);
    setError('');
    const r = await auth.sendCode(target);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'Could not send a code. Try again.');
    setCode('');
    setWait(auth.resendAfterSeconds);
    setStep({ s: 'code', email: target.trim() });
  };
  const verify = async () => {
    if (step.s !== 'code') return;
    setBusy(true);
    setError('');
    const r = await auth.verifyCode(step.email, code.trim());
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'That code did not work.');
    if (r.next === 'app') return go('/');
    if (r.next === 'accept' && r.invite) {
      setName(r.invite.name);
      return setStep({ s: 'accept', invite: r.invite });
    }
    setStep({ s: 'issue', issue: (r.next as AccessIssue) ?? 'no-access', email: step.email });
  };

  const demoBanner =
    mode === 'demo' ? (
      <div className="auth-demo">
        <b>Demo mode.</b> No email is sent and no real account exists. Use a demo address such as <code>butter.tamba@demo-sfcl.invalid</code> and any 6 digits. Try{' '}
        <code>new.butter.officer@demo-sfcl.invalid</code> (pending invite) or <code>late.starter@demo-sfcl.invalid</code> (expired).
      </div>
    ) : null;

  return (
    <div className="auth-page">
      {mode === 'demo' && (
        <div className="demo-strip">
          <AlertTriangle size={14} /> <strong>DEMO MODE</strong> Sign-in screens are a preview. Real sign-in needs the Supabase project to be configured.
          {store.user && (
            <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => go('/')}>
              Back to the app
            </button>
          )}
        </div>
      )}
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size={30} />
            <Wordmark />
          </div>

          {step.s === 'email' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <h1>Sign in</h1>
              <p className="muted small" style={{ marginBottom: 16 }}>
                Access is by invitation from SFCL IT. We'll email you a one-time code — there is no password.
              </p>
              {demoBanner}
              <label className="field">
                <span>Work email</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 14 }} disabled={busy || !email}>
                <Mail size={16} /> Email me a sign-in code
              </button>
              <div className="auth-sep">or</div>
              <button
                type="button"
                className="google-btn"
                disabled={busy}
                onClick={async () => {
                  const r = await auth.google();
                  if (!r.ok) setError(r.error ?? 'Google sign-in failed.');
                }}
              >
                <GoogleMark /> Continue with Google
              </button>
              <p className="auth-note">Google sign-in works only for the Google account whose verified email matches your invitation.</p>
              <p className="auth-note">
                <button type="button" className="link-btn" onClick={() => setStep({ s: 'recover' })}>
                  Can't sign in?
                </button>
              </p>
            </form>
          )}

          {step.s === 'code' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
            >
              <button type="button" className="link-btn small" onClick={() => setStep({ s: 'email' })}>
                <ArrowLeft size={13} style={{ verticalAlign: -2 }} /> Change email
              </button>
              <h1 style={{ marginTop: 10 }}>Check your email</h1>
              <p className="muted small" style={{ marginBottom: 16 }}>
                If <b>{step.email}</b> has an SFCL account or invitation, a {auth.codeLength}-digit code is on its way. It expires in {auth.codeLifetimeMinutes} minutes.
              </p>
              {demoBanner}
              <label className="field">
                <span>Sign-in code</span>
                <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={auth.codeLength} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus aria-describedby="code-help" />
              </label>
              {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 14 }} disabled={busy || code.length !== auth.codeLength}>
                <KeyRound size={16} /> Verify and continue
              </button>
              <p id="code-help" className="auth-note">
                {wait > 0 ? (
                  <>
                    <Clock size={12} style={{ verticalAlign: -2 }} /> You can request a new code in {wait}s. Codes are rate-limited to protect your account.
                  </>
                ) : (
                  <>
                    Code expired or didn't arrive?{' '}
                    <button type="button" className="link-btn" onClick={() => send(step.email)} disabled={busy}>
                      Send a new code
                    </button>
                  </>
                )}
              </p>
            </form>
          )}

          {step.s === 'accept' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                const r = await auth.acceptInvitation(step.invite, name);
                setBusy(false);
                if (!r.ok) return setError(r.error ?? 'Could not activate the account.');
                go('/');
              }}
            >
              <div className="notice ok" style={{ marginBottom: 14 }}>
                <CheckCircle2 size={18} />
                <span>
                  Email verified: <b>{step.invite.email}</b>
                </span>
              </div>
              <h1>Activate your account</h1>
              <p className="muted small" style={{ marginBottom: 14 }}>
                SFCL IT invited you with this access. Confirm your name to finish. If anything looks wrong, contact IT before continuing.
              </p>
              {mode === 'demo' && <div className="auth-demo">Demo mode: activation is simulated in this browser.</div>}
              <dl className="kv" style={{ marginBottom: 14 }}>
                <dt>Role</dt>
                <dd>{ROLES[step.invite.role].label}</dd>
                <dt>Locations</dt>
                <dd>{step.invite.locationNames.length ? step.invite.locationNames.join(', ') : '—'}</dd>
              </dl>
              <label className="field">
                <span>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              </label>
              {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 14 }} disabled={busy || !name.trim()}>
                Activate account
              </button>
            </form>
          )}

          {step.s === 'issue' && <IssueScreen issue={step.issue} email={step.email} onBack={() => setStep({ s: 'email' })} onSignOut={store.signOut} />}

          {step.s === 'recover' && (
            <div>
              <h1>Can't sign in?</h1>
              <div className="stack-sm small" style={{ marginTop: 10 }}>
                <p>
                  <b>There is no password to reset.</b> Each sign-in uses a new one-time code sent to your work email, or your matching Google account.
                </p>
                <p>
                  <b>Code didn't arrive?</b> Check spam, wait for the resend timer and request a new code. Codes expire after {auth.codeLifetimeMinutes} minutes.
                </p>
                <p>
                  <b>Changed email or lost mailbox access?</b> Ask SFCL IT. They can re-issue your invitation or update your account. IT can never see or set a password or a
                  sign-in code.
                </p>
              </div>
              <button className="btn btn-block" style={{ marginTop: 18 }} onClick={() => setStep({ s: 'email' })}>
                <ArrowLeft size={14} /> Back to sign in
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IssueScreen({ issue, email, onBack, onSignOut }: { issue: AccessIssue; email?: string; onBack: () => void; onSignOut: () => Promise<void> }) {
  const content: Record<AccessIssue, { icon: ReactNode; title: string; body: ReactNode }> = {
    suspended: { icon: <ShieldOff size={22} />, title: 'Access suspended', body: 'Your SFCL account is suspended, so no data is available. Your past records are kept. Contact SFCL IT if you think this is a mistake.' },
    'no-access': {
      icon: <UserX size={22} />,
      title: 'No access for this account',
      body: (
        <>
          {email ? <b>{email}</b> : 'This account'} has no SFCL invitation. Access is by invitation only — ask SFCL IT to invite your work email.
        </>
      ),
    },
    'no-locations': { icon: <Lock size={22} />, title: 'No locations assigned yet', body: 'Your account is active but IT has not assigned any locations, so there is nothing to show. Ask SFCL IT to assign your centre or area.' },
    'expired-invite': { icon: <Clock size={22} />, title: 'Invitation expired', body: 'This invitation is no longer valid. Ask SFCL IT to send a new invitation — it will arrive as a new email.' },
    'wrong-email': {
      icon: <AlertTriangle size={22} />,
      title: 'Email does not match the invitation',
      body: 'You signed in with an email (or Google account) that is different from the one invited. Sign out and use the invited work email.',
    },
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
        <button
          className="btn"
          onClick={async () => {
            await onSignOut();
            onBack();
          }}
        >
          <ArrowLeft size={14} /> Use a different account
        </button>
        <a className="btn btn-ghost" href="mailto:">
          <LifeBuoy size={14} /> Contact IT
        </a>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
