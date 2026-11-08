// admin-users — IT Admin account lifecycle.
// Authorization is decided IN THE DATABASE: every action first calls an admin_*
// SQL function with the caller's own JWT, which raises unless the caller is an
// active IT Admin. Only then is the secret-key client used for Auth admin calls
// (sending invite emails, banning sessions, sending a fresh sign-in email).
// No password is ever read, set or returned.
import { APP_URL, adminClient, cors, json, userClient } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);
  const body = await req.json().catch(() => ({}));
  const user = userClient(req);
  const admin = adminClient();
  const fail = (msg: string, status = 400) => json(req, { error: msg }, status);

  switch (body.action) {
    case 'invite': {
      const { data, error } = await user.rpc('admin_prepare_invitation', {
        p: { email: body.email, name: body.name, role: body.role, location_codes: body.location_codes ?? [], client_names: body.client_names ?? [] },
      });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const inv = data as { invitation_id: string; email: string };
      const sent = await admin.auth.admin.inviteUserByEmail(inv.email, { redirectTo: APP_URL || undefined });
      if (sent.error) {
        // Existing Auth identity (e.g. earlier revoked invite): send a sign-in email instead.
        const otp = await admin.auth.signInWithOtp({ email: inv.email, options: { shouldCreateUser: false, emailRedirectTo: APP_URL || undefined } });
        if (otp.error) {
          await user.rpc('admin_update_invitation', { p_id: inv.invitation_id, p_action: 'revoke' });
          return fail(`The invitation email could not be sent: ${sent.error.message}`, 502);
        }
      }
      return json(req, { ok: true, invitation_id: inv.invitation_id });
    }
    case 'resend': {
      const { data, error } = await user.rpc('admin_update_invitation', { p_id: body.invitation_id, p_action: 'resend' });
      if (error) return fail(error.message, error.code === '42501' ? 403 : 400);
      const email = (data as { email: string }).email;
      const sent = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: APP_URL || undefined });
      if (sent.error) {
        const otp = await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: APP_URL || undefined } });
        if (otp.error) return fail(`The email could not be sent: ${otp.error.message}`, 502);
      }
      return json(req, { ok: true });
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
    case 'recovery': {
      // Passwordless recovery: send the user a fresh verified sign-in email. Authorise first.
      const { data, error } = await user.rpc('admin_list_users');
      if (error) return fail(error.message, 403);
      const target = (data as { id: string; email: string; status: string }[]).find((u) => u.id === body.user_id);
      if (!target) return fail('Unknown user.', 404);
      if (target.status !== 'active') return fail('Reactivate the account first.');
      const otp = await admin.auth.signInWithOtp({ email: target.email, options: { shouldCreateUser: false, emailRedirectTo: APP_URL || undefined } });
      if (otp.error) return fail(otp.error.message, 502);
      const { data: me } = await user.auth.getUser();
      await admin.from('audit_log').insert({ actor_id: me.user?.id, action: 'user.recovery-sent', target_table: 'profiles', target_id: body.user_id, summary: 'Fresh sign-in email sent by IT (no password involved)' });
      return json(req, { ok: true });
    }
    default:
      return fail('Unknown action.');
  }
});
