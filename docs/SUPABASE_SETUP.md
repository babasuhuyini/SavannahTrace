# Supabase setup — step by step

> **Status (9 Nov 2026):** project `xinbkypxnegzokpohazz` (Savannah Trace, eu-central-1) is linked. Steps 1–3, 5 and 6 (except the function secrets) were done on 8 Nov. On 9 Nov sign-in changed to **password + authenticator app (MFA)**: migration `20261109000100`, the updated `admin-users` function and the new auth settings must be deployed (step 6b). Remaining: step 6b, function secrets (step 6), the first admin (step 8), then SMTP (step 4) when ready.

## How sign-in works

1. IT invites a person in **Users & access** and copies the one-time link (or, once SMTP exists, emails it).
2. The person opens the link, presses **Continue**, confirms their name and **chooses their own password** (12+ characters, letters and numbers, not common, not their name, not in a known data breach).
3. They set up an **authenticator app** (Microsoft or Google Authenticator) by scanning a QR code.
4. From then on: **email + password + the 6-digit code** from the app.

The database refuses all data until step 3 is done in the current session (`aal2`), so a stolen password or a stolen mailbox alone gives nothing. IT never sees or sets a password. Forgotten password → IT issues a reset link (or the person uses *Forgot your password?*). Lost phone → IT presses **Reset authenticator**.

For: the person setting up the hosted Savannah Trace project (Windows, no Docker needed).
Decided by SFCL (8 Nov 2026): **EU region, Free plan to start.** Dashboard menu names change from time to time; if a label below differs slightly, look for the nearest match.

Do not load real collector data until the role/location matrix, retention and backups (step 13) are agreed.

**What you need:** Node 22 and this folder; the database password you chose when creating the project; someone who can add DNS records for `savannahfruits.com`; about two hours.

---

## 1. Collect the project values

In the Supabase Dashboard, open the project:

| Value | Where | Goes into |
|---|---|---|
| Project ref | Project Settings → General (also in the URL: `supabase.com/dashboard/project/<ref>`) | CLI `link` |
| Project URL `https://<ref>.supabase.co` | Project Settings → Data API | `.env.local`, host settings, GitHub secret |
| Publishable key (`sb_publishable_…`, or the legacy *anon* key) | Project Settings → API Keys | `.env.local`, host settings, GitHub secret |
| Secret / service-role key | Project Settings → API Keys | **nowhere** — Edge Functions receive it automatically |

The publishable key is designed to be public; Row Level Security protects the data. The secret key bypasses all security: never paste it into `.env.local`, the front-end host, GitHub, email or chat.

## 2. Link this folder to the project

From the project folder (PowerShell or Git Bash):

```bash
npm ci
npx supabase login                          # opens the browser once
npx supabase link --project-ref <ref>       # asks for the database password
```

## 3. Create the database

```bash
npm run verify:rls       # must end with "109/109 checks passed"
npx supabase db push     # applies supabase/migrations in order; type Y to confirm
```

Then in the Dashboard:

- **Table Editor**: the tables (`locations`, `events`, `inventory_ledger`, …) exist and show **RLS enabled**.
- **Project Settings → Data API → Exposed schemas**: only `public` (the `private` schema must not be listed).
- **Do not run `supabase/seed.sql` on this project.** It is fictional demo data and cannot be cleanly removed from an append-only ledger. Real locations, groups and collection areas are created by the IT Admin in **Master data** (step 9). If you want a sandbox, create a second free project for it.

## 4. Email: custom SMTP with Resend

The built-in Supabase mailer sends only about **2 emails per hour** and is for testing. Invitations and sign-in codes will not arrive reliably until custom SMTP is set.

**Recommended: [Resend](https://resend.com).** It has a free tier (3,000 emails/month, about 100/day; check their pricing page) and published Supabase settings.

**Microsoft 365 is not recommended.** SMTP AUTH with basic authentication on Exchange Online is being retired: it will be off by default for existing tenants from late December 2026, and unavailable to new tenants. A dedicated sending service is the durable choice.

1. **Create the Resend account** with a shared work mailbox (e.g. `it@savannahfruits.com`), not a personal one.
2. **Add a sending domain:** Domains → Add domain → `notify.savannahfruits.com`. A subdomain keeps this traffic separate from staff email and does not touch the existing Microsoft 365 records. Choose the EU region if offered.
3. **Add DNS records:** give the records Resend shows (DKIM TXT on `resend._domainkey.notify…`, SPF TXT and MX on `send.notify…`) to whoever manages the `savannahfruits.com` DNS. Click **Verify**; it can take from minutes to a few hours.
   - If the root domain has no DMARC record, also add TXT `_dmarc.savannahfruits.com` = `v=DMARC1; p=none; rua=mailto:it@savannahfruits.com`. Tighten it to `quarantine` later.
4. **Create an API key:** API Keys → Create → name `supabase-auth-smtp`, permission **Sending access**, restricted to `notify.savannahfruits.com`. Copy it once.
5. **Configure Supabase:** Authentication → Emails → **SMTP Settings** → enable custom SMTP:

   | Field | Value |
   |---|---|
   | Sender email | `no-reply@notify.savannahfruits.com` |
   | Sender name | `Savannah Trace` |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | the Resend API key |
   | Minimum interval between emails | `60` seconds (per user) |

6. **Raise the send limit:** Authentication → **Rate Limits** → *emails sent per hour* → `30`. It drops to a low value when SMTP is first enabled.
7. **Branded templates** (Supabase only allows this once custom SMTP is on). Either uncomment the template sections in `supabase/config.toml` and run `npx supabase config push`, or paste them in the Dashboard: Authentication → Emails → **Templates**:
   - **Invite user**: subject `You have been invited to Savannah Trace`; body = `supabase/templates/invite.html`.
   - **Reset password**: subject `Reset your Savannah Trace password`; body = `supabase/templates/recovery.html`.
   Both link to the app's own confirmation page, which needs a click before the one-time token is used, so Microsoft Safe Links and similar scanners cannot use up a link.
   Until SMTP is set, invitations work without email: IT copies the link from the app.
8. **Test** after step 6 by inviting yourself (step 8). If nothing arrives, check Resend → Logs, then Supabase → Logs → Auth.

*Alternative:* Brevo (free tier of about 300 emails/day; host `smtp-relay.brevo.com`, port 587). The steps are the same apart from the host and credentials.

## 5. Auth settings

Authentication → **Sign In / Providers** (and **Email**):

- **Allow new users to sign up:** **off**. Access is by invitation only.
- **Email provider:** on. **Confirm email:** on. **Email OTP expiration:** `86400` seconds (lifetime of invitation and password-reset links: 24 hours, single use).
- **Passwords:** minimum length `12`, require letters and digits, **Secure password change** on.
- **Multi-Factor:** TOTP (app authenticator) enabled. Phone MFA off.
- All of these are in `supabase/config.toml` and applied with `npx supabase config push`.
- **Anonymous sign-ins:** off.

Authentication → **URL Configuration**:

- **Site URL:** for now `http://localhost:5173`. Change it to the real address in step 11.
- **Redirect URLs:** add `http://localhost:5173/**`. In step 11 also add `https://trace.savannahfruits.com/**`.

## 6. Edge Functions (no Docker needed)

Generate the customer-link secret. It works in PowerShell and Git Bash; copy the output into your password manager:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
npx supabase secrets set TRACE_LINK_SECRET=<paste> APP_URL=http://localhost:5173 ALLOWED_ORIGINS=http://localhost:5173
npx supabase functions deploy admin-users  --use-api
npx supabase functions deploy trace-link   --use-api
npx supabase functions deploy public-trace --use-api --no-verify-jwt
```

- `--use-api` bundles on Supabase's side, so Docker is not required.
- `public-trace` is opened anonymously by customers. Its link token is checked inside the function.
- Rotating `TRACE_LINK_SECRET` later invalidates **every** customer link that has been issued.
- If a function fails with an invalid-key error, the project has legacy API keys disabled. Set `SB_PUBLISHABLE_KEY` and `SB_SECRET_KEY` with `secrets set`; the functions read them first.

## 6b. Deploy the password + MFA change (9 Nov 2026)

From this folder, in PowerShell:

```
npx supabase db push --remote --yes
npx supabase functions deploy admin-users --use-api
npx supabase config push --yes
npm run verify:rls
```

The first command adds the authenticator requirement to the database. From that moment, sessions without an authenticator code see no data — deploy the new front end (GitHub Desktop → Push origin) at the same time.

## 7. Run the app against the project

Copy `.env.example` to `.env.local` (Git ignores it) and fill in:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_APP_URL=http://localhost:5173
```

Run `npm run dev`. The amber **DEMO MODE** strip must be gone. That shows the app is in live mode.

## 8. Create the first IT Admin (one time)

1. Dashboard → Authentication → Users → **Add user → Send invitation**, using the IT lead's work email. Do not click the email link yet.
2. Dashboard → SQL Editor:
   ```sql
   select private.bootstrap_first_admin('it.lead@savannahfruits.com', 'Full Name');
   ```
   It refuses to run once an IT Admin exists, and no signed-in user can call it.
3. Open the invitation email and click the link. The app asks you to **choose a password**, then to **set up your authenticator app**. You then land in the app as IT Admin.

**Already bootstrapped but no password yet** (accounts created before 9 Nov): Dashboard → Authentication → Users → your user → **Send password recovery**. The email link opens the app at *Choose a new password*, then the authenticator setup. The built-in mailer only delivers to members of your Supabase organisation and about 2 emails per hour.

Every later user is invited from **Users & access** in the app, with role, locations and (for Commercial) clients.

## 9. Real master data

As IT Admin, open **Master data** and create the real locations (collection areas, post-harvest centres, butter centres, warehouse, Tema port, the Amsterdam terminal, the refiner and filterer, client sites) and processing groups. Then invite the officers and assign each to their locations. Users without a location get a "no locations assigned" screen by design.

## 10. Acceptance tests before real data

Use one test account per role and two locations, mirroring `scripts/verify-rls.ts`:

- A Nut Officer cannot see Butter panels or another officer's purchases.
- A Butter Officer cannot see a consignment for an unassigned centre.
- The receiving officer sees, and can receive, a shipment addressed to their location.
- A suspended user loses access on the next action.
- An uninvited Google or email identity gets no data.
- A customer link opens on a phone with mobile data. It shows the full SFCL trace but no collector names or prices. It stops working after **Revoke**.
- An expired or already-used invitation link shows a clear message; IT creates a new link from Users & access.
- A user who knows the password but has no authenticator code sees no data (try the API directly with that session).
- **Reset authenticator** makes the user set up the app again at the next sign-in.

## 11. Host the front end

The app is static files. Any HTTPS host works. **Cloudflare Pages** and **Netlify** have free tiers that allow business use; Vercel's free tier is for non-commercial use.

**Cloudflare Pages:**

1. Create the project from the GitHub repository. Set:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Environment variables: `NODE_VERSION=22`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_URL=https://trace.savannahfruits.com`
2. Custom domain → `trace.savannahfruits.com`. Add the CNAME it shows to DNS.

No rewrite rules are needed, because the app uses `#/` routes.

Then point everything at the real address:

- Supabase → URL Configuration: **Site URL** `https://trace.savannahfruits.com`, and keep both redirect URLs.
- Run:
  ```bash
  npx supabase secrets set APP_URL=https://trace.savannahfruits.com ALLOWED_ORIGINS=https://trace.savannahfruits.com,http://localhost:5173
  ```

## 12. Keep the Free project from pausing

**The policy.** Supabase pauses Free projects after about a week without enough database activity. While paused, sign-in, the app and **every customer QR link stop working** until someone clicks *Restore* in the Dashboard. A project paused for more than 90 days can no longer be restored from the Dashboard.

**What this repository does about it:**

- **Migration `20261108000500_keepalive.sql`** adds `public.keepalive()`. It is callable with the publishable key, writes at most one heartbeat row per hour to the private schema, deletes heartbeats older than 30 days, and returns only a timestamp. No data is exposed.
- **Workflow `.github/workflows/keepalive.yml`** calls it every two days and can be run by hand.

To switch it on, after the first push to GitHub:

1. On GitHub, open the repository's **Settings → Secrets and variables → Actions** and add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
2. Go to **Actions → Supabase keep-alive → Run workflow**. It should succeed and print `HTTP 200`.
3. A failed run sends an email to the repository owner, which doubles as a simple uptime alert.

**Limits, stated plainly:**

- This is a community workaround, not a Supabase guarantee. Supabase may change how it measures activity.
- In a **public** repository, GitHub disables scheduled workflows after 60 days without commits. A private repository avoids this.

**Recommendation.** Move to the **Pro plan** before customer links are printed on labels or sent to clients. Pro projects are never paused and include daily backups. A customer link that silently stops working damages trust far more than the subscription costs. Keep the workflow afterwards; it costs nothing and alerts you if the project stops responding.

## 13. Backups (Free plan has none you can download)

`supabase db dump` needs Docker. Instead, install the PostgreSQL 17 client tools (only *Command Line Tools* is needed in the installer). Then take a backup using the **Session pooler** connection string from the Dashboard's **Connect** button:

```bash
pg_dump "postgresql://postgres.<ref>:<db-password>@<pooler-host>:5432/postgres" -Fc -f savannah-trace-YYYY-MM-DD.dump
```

- Run it on a schedule, at least weekly and before every migration.
- Store backups outside OneDrive-synced folders, in an access-controlled location.
- Test a restore into a sandbox project once.

## 14. Optional: Google sign-in

1. In Google Cloud, create an OAuth client (Web application) with the redirect URI `https://<ref>.supabase.co/auth/v1/callback`.
2. Paste the client ID and secret into Supabase → Authentication → Providers → Google.

With sign-ups off, only an invited email can sign in. The app also requires an accepted invitation before it shows any data.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Invitation or reset email never arrives | SMTP not set or domain not verified (Resend → Logs); Auth rate limit still low (step 4.6). Use **Copy link** in Users & access instead |
| "This link has expired or was already used" | Link older than 24 hours or already opened with Continue. IT creates a new link from Users & access |
| "That code is not right" at the authenticator step | The phone's clock is off. Set date and time to automatic; use the newest code |
| User lost their phone | IT → Users & access → **Reset authenticator** (confirm who is asking first) |
| Self-service reset link opens but you are not signed in | It was opened in a different browser from the one that requested it. Ask IT for a reset link instead (works in any browser) |
| Customer link says "not available" | Wrong `TRACE_LINK_SECRET`/`APP_URL`, link revoked or expired, or the project is paused |
| Browser console shows CORS error from a function | The app's address is missing from `ALLOWED_ORIGINS` |
| Whole app is down and Dashboard says *Paused* | Restore it; then check the keep-alive workflow runs (step 12) |
