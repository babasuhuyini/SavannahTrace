# Putting the project on GitHub

The folder `savannah-trace-github` (next to the working copy) holds exactly what belongs in the repository: source, migrations, Edge Functions, scripts, docs and the CI workflow.

It never contains:
- `node_modules` or `dist`
- `.env` files
- spreadsheets
- secrets

Refresh it any time with `npm run export:github`. The `.savannah-trace-export` marker file lets the script refresh the folder safely; you can commit it or delete it.

## Option A: GitHub Desktop (installed on this PC)

1. On github.com, create a new **private** repository, e.g. `savannah-trace`. Do not add a README or .gitignore; the folder has them.
2. In GitHub Desktop: **File → Add local repository…** and choose the `savannah-trace-github` folder. When asked, click **create a repository** (this runs `git init`). Keep the existing `.gitignore`.
3. Review the files and write the first commit message, e.g. "Savannah Trace: app, Supabase migrations, docs, brand". Commit.
4. **Publish repository**. Keep **Private** ticked and select your organisation if the repository should belong to it.

## Option B: command line

```bash
cd ../savannah-trace-github
git init -b main
git add .
git commit -m "Savannah Trace: app, Supabase migrations, docs, brand"
git remote add origin https://github.com/<org>/savannah-trace.git
git push -u origin main
```

## After the first push

- **Actions → Supabase keep-alive** needs two repository secrets, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (Settings → Secrets and variables → Actions). Then run it once by hand — see `SUPABASE_SETUP.md` §12.
- **Actions → CI** runs the type-check, `npm run verify:rls` (all database access rules) and the production build on every push.
- Secrets never go in the repository. Supabase keys belong in `.env.local` (browser-safe values only) and in Supabase Edge Function secrets. If you add a deploy workflow later, use GitHub **Actions secrets**.
- GitHub stores the code only. Sign-in, invitations and data need the Supabase project (see `SUPABASE_SETUP.md`). GitHub Pages can serve the built front end but is not an authentication backend.
