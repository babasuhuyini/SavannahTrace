// Password inputs. Security rules this component follows:
//  • type="password" only. There is no "show password" button and the value is never
//    rendered anywhere (not in messages, not in the strength meter).
//  • The value is NOT kept in React state, a store, localStorage or a URL. It lives only
//    in the input element; parents read it once on submit with read() and then clear().
//  • Paste and password managers are allowed (autocomplete="new-password").
//  • spellcheck/autocorrect are off so the browser does not send it to a spelling service.
import { AlertTriangle, Check, Circle, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { STRENGTH_LABEL, assessPassword, breachCount, type PasswordAssessment } from '../domain/password';

export interface PasswordFieldsHandle {
  /** Validate and return the new password (including the breach check), or an error. Clears nothing. */
  read: () => Promise<{ ok: true; password: string } | { ok: false; error: string }>;
  /** Empty both inputs. Call after every submit, successful or not. */
  clear: () => void;
}

const noAssist = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

/** Caps Lock warning without ever looking at the value. */
export function useCapsLock() {
  const [on, setOn] = useState(false);
  const onKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => setOn(e.getModifierState?.('CapsLock') ?? false), []);
  return { capsOn: on, onKeyUp: onKey, onKeyDown: onKey };
}

/** Single password input (sign-in, current password). Uncontrolled: read the value from the ref. */
export const PasswordInput = forwardRef<HTMLInputElement, { label: string; autoComplete: 'current-password' | 'new-password'; autoFocus?: boolean; id?: string }>(function PasswordInput({ label, autoComplete, autoFocus, id }, ref) {
  const caps = useCapsLock();
  return (
    <label className="field">
      <span>{label}</span>
      <input ref={ref} id={id} type="password" name={autoComplete === 'current-password' ? 'password' : 'new-password'} autoComplete={autoComplete} autoFocus={autoFocus} required {...noAssist} onKeyUp={caps.onKeyUp} onKeyDown={caps.onKeyDown} />
      {caps.capsOn && (
        <span className="caps-warn">
          <AlertTriangle size={12} /> Caps Lock is on
        </span>
      )}
    </label>
  );
});

/** New password + confirmation, with the live checklist and strength meter. */
export const PasswordFields = forwardRef<PasswordFieldsHandle, { email?: string; name?: string; label?: string; onValidChange?: (ok: boolean) => void; autoFocus?: boolean }>(function PasswordFields(
  { email, name, label = 'New password', onValidChange, autoFocus },
  ref,
) {
  const pw = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);
  const [a, setA] = useState<PasswordAssessment>(() => assessPassword('', '', { email, name }));
  const [touched, setTouched] = useState(false);
  const caps = useCapsLock();

  const recompute = useCallback(() => {
    // Only the assessment (booleans + a 0–4 score) is kept — never the password itself.
    setA(assessPassword(pw.current?.value ?? '', confirm.current?.value ?? '', { email, name }));
  }, [email, name]);
  useEffect(recompute, [recompute]);
  useEffect(() => onValidChange?.(a.ok), [a.ok, onValidChange]);

  useImperativeHandle(
    ref,
    () => ({
      read: async () => {
        const password = pw.current?.value ?? '';
        const res = assessPassword(password, confirm.current?.value ?? '', { email, name });
        setTouched(true);
        if (!res.ok) return { ok: false, error: `The password does not meet the rules yet: ${res.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join('; ')}.` };
        const seen = await breachCount(password);
        if (seen && seen > 0)
          return { ok: false, error: `This password has appeared in ${seen.toLocaleString('en-GB')} known data breach${seen === 1 ? '' : 'es'}, so attackers try it first. Choose a different one.` };
        return { ok: true, password };
      },
      clear: () => {
        if (pw.current) pw.current.value = '';
        if (confirm.current) confirm.current.value = '';
        recompute();
      },
    }),
    [email, name, recompute],
  );

  return (
    <div className="stack-sm">
      <label className="field">
        <span>{label}</span>
        <input
          ref={pw}
          type="password"
          name="new-password"
          autoComplete="new-password"
          autoFocus={autoFocus}
          required
          {...noAssist}
          aria-describedby="pw-rules"
          onInput={() => {
            setTouched(true);
            recompute();
          }}
          onKeyUp={caps.onKeyUp}
          onKeyDown={caps.onKeyDown}
        />
      </label>
      <div className={`pw-meter s${a.strength}`} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="tiny muted" aria-live="polite">
        {a.strength ? `Strength: ${STRENGTH_LABEL[a.strength]}` : 'Tip: a passphrase of four or more unrelated words is long, strong and easy to remember.'}
      </div>
      <label className="field">
        <span>Type it again</span>
        <input ref={confirm} type="password" name="confirm-password" autoComplete="new-password" required {...noAssist} onInput={recompute} onKeyUp={caps.onKeyUp} onKeyDown={caps.onKeyDown} />
      </label>
      {caps.capsOn && (
        <span className="caps-warn">
          <AlertTriangle size={12} /> Caps Lock is on
        </span>
      )}
      <ul className="pw-rules" id="pw-rules">
        {a.checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : touched ? 'bad' : ''}>
            {c.ok ? <Check size={13} /> : touched ? <X size={13} /> : <Circle size={9} />}
            {c.label}
          </li>
        ))}
        <li className="note">Checked against known data breaches when you continue (privately: the password never leaves this device).</li>
      </ul>
    </div>
  );
});

/** 6-digit authenticator code input. */
export function CodeInput({ value, onChange, autoFocus = true, id }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; id?: string }) {
  return (
    <input
      id={id}
      className="code-input"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      autoFocus={autoFocus}
      {...noAssist}
      aria-label="6-digit code from your authenticator app"
    />
  );
}
