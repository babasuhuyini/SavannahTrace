# GitHub: repository, test site and workflows

Repository: **https://github.com/babasuhuyini/SavannahTrace** (public)
Test site (after the first deploy): **https://babasuhuyini.github.io/SavannahTrace/**

The local folder `C:\Users\Suhuyini\dev\savannah-trace-github` is a git clone of that repository. Its contents come from the working copy via `npm run export:github`, which refreshes every file but keeps the `.git` history.

Do not upload files through the GitHub web page. It silently skips hidden files and folders (`.github`, `.gitignore`, `.env.example`), which is why the workflows were empty the first time.

## Publishing changes (GitHub Desktop)

1. In the working copy, run `npm run export:github`.
2. In GitHub Desktop, choose the **savannah-trace-github** repository. The first time, add it with **File → Add local repository…** and that folder.
3. Review the changed files, write a summary, and click **Commit to main**.
4. Click **Push origin**.

## One-time: turn on the test site

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. If you pushed before switching this on, open **Actions → Deploy to GitHub Pages → Run workflow** afterwards.

## The three workflows (Actions tab)

| Workflow | When | What |
|---|---|---|
| **CI** | Every push | Type-check, all database access rules (`verify:rls`) and the production build. A red cross means something broke. |
| **Deploy to GitHub Pages** | Push to `main` | Builds the app and publishes the test site. |
| **Supabase keep-alive** | Every 2 days | Stops the Free Supabase project from pausing. It skips itself until its secrets exist. See `SUPABASE_SETUP.md` §12. |

## Demo mode vs live mode on the test site

Without settings, the test site runs in **demo mode**: fictional data that lives only in each visitor's browser, with a Demo menu for switching users. Anyone with the link can use it. Nothing is shared between visitors, and nothing is real.

To point the site at Supabase, add these under **Settings → Secrets and variables → Actions → Variables** (not Secrets). They are browser-safe by design:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_APP_URL` = `https://babasuhuyini.github.io/SavannahTrace/`

Then re-run the deploy workflow. Also add that address to Supabase Auth's redirect URLs and to the `ALLOWED_ORIGINS` function secret.

For the keep-alive, add **Secrets** (not Variables) named `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.

## What being public means

The source code, database schema and security rules are visible to anyone. The system is designed so that this is safe: access is enforced by Row Level Security in the database, not by hiding code.

The repository must never contain:
- a secret or service-role key
- `.env.local`
- real collector, purchase or client data
- spreadsheets

`.gitignore` blocks the usual files, but always look at the file list in GitHub Desktop before committing. If a secret is ever pushed, rotate it in Supabase immediately. Deleting the commit is not enough.

Once real operations start, consider making the repository private. GitHub Pages on a private repository needs a paid GitHub plan; Cloudflare Pages (see `SUPABASE_SETUP.md` §11) works with private repositories for free.
