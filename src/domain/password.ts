// Password policy for Savannah Trace (NIST SP 800-63B style).
//
// Server-side (Supabase Auth, cannot be bypassed): at least 12 characters, letters and
// digits, bcrypt storage, rate-limited sign-in. Client-side (this file) adds what the
// server cannot: rejecting common and guessable passwords, the person's own name or
// email, company words, and passwords already exposed in known data breaches.
//
// Handling rules (see src/components/PasswordFields.tsx):
//  • a password is never shown on screen, logged, put in a URL, stored in app state,
//    localStorage or analytics; it is read from the input once, on submit
//  • paste and password managers are allowed (they lead to stronger passwords)
//  • the breach check sends only the first 5 characters of the SHA-1 hash
//    (k-anonymity) — the password itself never leaves the browser except to Supabase Auth

export const PASSWORD_MIN = 12;
/** bcrypt ignores everything after 72 bytes, so longer input would silently be truncated. */
export const PASSWORD_MAX_BYTES = 72;

export interface PasswordCheck {
  id: 'length' | 'max' | 'mix' | 'common' | 'personal' | 'match';
  label: string;
  ok: boolean;
}
export interface PasswordAssessment {
  checks: PasswordCheck[];
  ok: boolean;
  /** 0 empty · 1 weak · 2 fair · 3 good · 4 strong */
  strength: 0 | 1 | 2 | 3 | 4;
}

// Most-used passwords and base words (lower-case, de-leeted), plus local and company words.
const COMMON = new Set(
  (
    'password passw0rd passwort motdepasse qwerty qwertyuiop asdfgh asdfghjkl zxcvbn zxcvbnm azerty letmein welcome welcome1 admin administrator ' +
    'iloveyou loveyou monkey dragon football baseball soccer sunshine princess shadow master superman batman starwars trustno1 whatever freedom ' +
    'secret changeme default login access hello hello123 abc123 abcdef abcdefg abcdefgh 123abc password1 qazwsx qwerty123 1q2w3e4r 1qaz2wsx ' +
    'michael jennifer jordan hunter killer charlie andrew thomas daniel joshua matthew ashley jessica amanda summer winter spring autumn ' +
    'january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday ' +
    'computer internet samsung iphone android google facebook microsoft office outlook windows linux apple orange banana chocolate cookie ' +
    'blessed blessing jesus jesuschrist christ godisgood praisegod gracegod emmanuel favour favor victory success happiness family lovely ' +
    'ghana ghana123 accra kumasi tamale wa bolgatanga techiman takoradi blackstars blackstar akwaaba ' +
    'savannah savannahfruits savannahtrace sfcl sfcltrace trace traceability shea sheabutter sheanut organic butter kernel nuts fairforlife'
  ).split(/\s+/),
);

const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz', '0987654321', 'zyxwvutsrqponmlkjihgfedcba'];

function deleet(s: string) {
  return s
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/[$5]/g, 's')
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/7/g, 't')
    .replace(/8/g, 'b');
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** True when the password is (or is dominated by) a common word, a keyboard run or repetition. */
function isGuessable(pw: string): boolean {
  const lower = pw.toLowerCase();
  const core = deleet(pw).replace(/[^a-z]/g, '');
  const stripped = lower.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/\d+$/, '').replace(/^\d+/, '');
  if (COMMON.has(lower) || COMMON.has(deleet(stripped)) || COMMON.has(core)) return true;
  if (/^(.)\1+$/.test(pw) || /^(.{1,3})\1{2,}$/.test(pw)) return true; // aaaa…, abcabcabc
  if (/^\d+$/.test(pw)) return true; // only digits (phone numbers, dates)
  for (const run of KEYBOARD_RUNS) for (let i = 0; i + 6 <= run.length; i++) if (lower.includes(run.slice(i, i + 6)) && lower.length < 16) return true;
  // A common word that makes up most of the password, e.g. "Password2026!" or "Savannah@2026".
  for (const w of COMMON) if (w.length >= 5 && core.includes(w) && w.length * 2 >= core.length && core.length < 14) return true;
  return false;
}

/** Name / email parts (3+ characters) that must not appear in the password. */
function personalTokens(ctx: { email?: string; name?: string }): string[] {
  const parts = [...(ctx.email?.split('@')[0].split(/[._\-+]/) ?? []), ...(ctx.name?.split(/\s+/) ?? []), ctx.email?.split('@')[0] ?? ''];
  return [...new Set(parts.map((p) => deleet(p.trim())).filter((p) => p.length >= 3))];
}

/** Rough strength estimate for the meter (length and variety, minus guessable patterns). */
function strengthOf(pw: string, guessable: boolean): PasswordAssessment['strength'] {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2);
  if (guessable || pw.length < PASSWORD_MIN) return 1;
  return bits < 60 ? 2 : bits < 80 ? 3 : 4;
}

export function assessPassword(pw: string, confirm: string, ctx: { email?: string; name?: string }): PasswordAssessment {
  const guessable = pw.length > 0 && isGuessable(pw);
  const core = deleet(pw);
  const personal = personalTokens(ctx).some((t) => core.includes(t));
  const checks: PasswordCheck[] = [
    { id: 'length', label: `At least ${PASSWORD_MIN} characters`, ok: pw.length >= PASSWORD_MIN },
    { id: 'mix', label: 'Contains letters and numbers', ok: /[A-Za-z]/.test(pw) && /\d/.test(pw) },
    { id: 'common', label: 'Not a common or easily guessed password', ok: pw.length > 0 && !guessable },
    { id: 'personal', label: 'Does not contain your name or email', ok: pw.length > 0 && !personal },
    { id: 'match', label: 'Both entries match', ok: pw.length > 0 && pw === confirm },
  ];
  if (bytes(pw) > PASSWORD_MAX_BYTES) checks.splice(1, 0, { id: 'max', label: `No longer than ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} plain characters)`, ok: false });
  const ok = checks.every((c) => c.ok);
  return { checks, ok, strength: personal ? 1 : strengthOf(pw, guessable) };
}

export const STRENGTH_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/**
 * Has this password appeared in a known data breach? Uses the Have I Been Pwned range API
 * with k-anonymity: only the first 5 hex characters of the SHA-1 hash are sent, and the
 * response is padded so its size reveals nothing. Returns null if the check could not run
 * (offline, blocked) — the server-side rules still apply in that case.
 */
export async function breachCount(pw: string): Promise<number | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(pw));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const suffix = hex.slice(5);
    for (const line of (await res.text()).split('\n')) {
      const [s, n] = line.trim().split(':');
      if (s === suffix) return parseInt(n, 10) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}
