// admin-users — IT Admin account lifecycle.
// Authorization is decided IN THE DATABASE: every action first calls an admin_*
// SQL function with the caller's own JWT, which raises unless the caller is an
// active IT Admin who has completed the authenticator step (aal2). Only then is the
// secret-key client used for Auth admin calls.
//
// Passwords: IT never reads, sets or receives one. IT can only issue a ONE-TIME LINK
// (invitation or password reset) with which the person chooses their own password.
// The link is single-use and expires (Auth `otp_expiry`, 24 h). After using it, the
// person must still pass the authenticator step before any data is available.
//
// Delivery:
//   'link'  — return the link to IT to send privately (works without an email service).
//   'email' — Supabase Auth emails it (needs custom SMTP; see docs/SUPABASE_SETUP.md §4).
import { APP_URL, adminClient, cors, json, userClient } from '../_shared/common.ts';

type Delivery = 'link' | 'email';
type LinkType = 'invite' | 'recovery';

const base = () => (APP_URL || '').replace(/#.*$/, '');
/** App URL the person opens. The token is in the fragment, so it never reaches a server log or Referer. */
const appLink = (tokenHash: string, type: LinkType) => `${base()}#/welcome?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);
  const body = await req.json().catch(() => ({}));
  const user = userClient(req);
  const admin = adminClient();
  const fail = (msg: string, status = 400) => json(req, { error: msg }, status);
  const delivery: Delivery = body.delivery === 'email' ? 'email' : 'link';
  const redirectTo = base() || undefined;

  /** One-time link for a person who must (re)set their password. Never reveals or sets a password. */
  async function issueLink(email: string, prefer: LinkType): Promise<{ link?: string; error?: string }> {
    if (delivery === 'email') {
      if (prefer === 'invite') {
        const r = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
        if (!r.error) return {};
      }
      const r2 = await admin.auth.resetPasswordForEmail(email, { redirectTo });
      return r2.error ? { error: `The email could not be sent: ${r2.error.message}. Use “Copy link” instead.` } : {};
    }
    if (prefer === 'invite') {
      const r = await admin.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
      if (!r.error && r.data.properties?.hashed_token) return { link: appLink(r.data.properties.hashed_token, 'invite') };
      // Already in Auth (e.g. a re-issued invitation): a recovery link does the same job.
    }
    const r = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (r.error || !r.data.properties?.hashed_token) return { error: `Could not create the link: ${r.error?.message ?? 'unknown error'}` };
    return { link: appLink(r.data.properties.hashed_token, 'recovery') };
  }

  switch (body.action) {
    case 'invite': {
      const { data, error } = await user.rpc('admin_prepare_invitation', {
        p: { email: body.email, name: body.name, role: body.role, location_codes: body.location_codes ?? [], client_names: body.client_names ?? [] },
      });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const inv = data as { invitation_id: string; email: string };
      const out = await issueLink(inv.email, 'invite');
      if (out.error) {
        await user.rpc('admin_update_invitation', { p_id: inv.invitation_id, p_action: 'revoke' });
        return fail(out.error, 502);
      }
      return json(req, { ok: true, invitation_id: inv.invitation_id, link: out.link ?? null });
    }
    case 'resend': {
      // A new link replaces the old one (the previous link stops working).
      const { data, error } = await user.rpc('admin_update_invitation', { p_id: body.invitation_id, p_action: 'resend' });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const out = await issueLink((data as { email: string }).email, 'invite');
      return out.error ? fail(out.error, 502) : json(req, { ok: true, link: out.link ?? null });
    }
    case 'revoke': {
      const { error } = await user.rpc('admin_update_invitation', { p_id: body.invitation_id, p_action: 'revoke' });
      return error ? fail(error.message, 403) : json(req, { ok: true });
    }
    case 'suspend':
    case 'reactivate': {
      const status = body.action === 'suspend' ? 'suspended' : 'active';
      // 1) database: access denied immediately by RLS/workflow checks
      const { error } = await user.rpc('admin_set_user_status', { p_user: body.user_id, p_status: status });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      // 2) Auth: ban/unban so refresh tokens stop working (records are kept)
      const r = await admin.auth.admin.updateUserById(body.user_id, { ban_duration: status === 'suspended' ? '876000h' : 'none' });
      if (r.error) return fail(`Database access updated, but the session ban failed: ${r.error.message}`, 502);
      return json(req, { ok: true });
    }
    case 'password_reset': {
      const { data, error } = await user.rpc('admin_user_security', { p_user: body.user_id, p_action: 'password_reset' });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const out = await issueLink((data as { email: string }).email, 'recovery');
      return out.error ? fail(out.error, 502) : json(req, { ok: true, link: out.link ?? null });
    }
    case 'mfa_reset': {
      // Lost or replaced phone. Removing every factor means the next sign-in asks the
      // person to set up a new authenticator; until then the database refuses all data.
      const { error } = await user.rpc('admin_user_security', { p_user: body.user_id, p_action: 'mfa_reset' });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const { data: f, error: e2 } = await admin.auth.admin.mfa.listFactors({ userId: body.user_id });
      if (e2) return fail(`Could not read the user's authenticators: ${e2.message}`, 502);
      for (const factor of f?.factors ?? []) {
        const d = await admin.auth.admin.mfa.deleteFactor({ userId: body.user_id, id: factor.id });
        if (d.error) return fail(`Could not remove an authenticator: ${d.error.message}`, 502);
      }
      return json(req, { ok: true });
    }
    default:
      return fail('Unknown action.');
  }
});
