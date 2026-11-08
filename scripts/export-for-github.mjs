// Copies exactly the files that belong in the GitHub repository into one clean
// folder next to this project (default: ../savannah-trace-github).
//   npm run export:github            → ../savannah-trace-github
//   npm run export:github -- <path>  → custom target
// Never copies node_modules, dist, .env files, spreadsheets or local tool state.
// For safety it only ever clears a target folder that it created itself.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] ?? join(root, '..', 'savannah-trace-github'));
const MARKER = '.savannah-trace-export';

const include = ['.github', '.gitignore', '.env.example', 'README.md', 'docs', 'index.html', 'public', 'package.json', 'package-lock.json', 'scripts', 'src', 'supabase', 'tsconfig.json', 'vite.config.ts'];
// path segments never exported (matched on each relative path, Windows or POSIX separators)
const skip = /(^|[\\/])(node_modules|dist|\.temp|\.branches|\.env(\.(?!example$)[^\\/]*)?|[^\\/]*\.(xlsx|csv|log))$/;

if (target === root || relative(root, target) === '' || !relative(root, target).startsWith('..')) {
  console.error('Refusing: the export target must be outside the project folder.');
  process.exit(1);
}
if (existsSync(target)) {
  if (!existsSync(join(target, MARKER))) {
    console.error(`Refusing: ${target} exists and was not created by this script. Choose another folder or empty it yourself.`);
    process.exit(1);
  }
  for (const f of readdirSync(target)) if (f !== '.git') rmSync(join(target, f), { recursive: true, force: true }); // keep an existing git history
}
mkdirSync(target, { recursive: true });

let files = 0;
for (const item of include) {
  const src = join(root, item);
  if (!existsSync(src)) continue;
  cpSync(src, join(target, item), {
    recursive: true,
    filter: (p) => {
      const rel = relative(root, p);
      if (rel && skip.test(rel)) return false;
      if (statSync(p).isFile()) files++;
      return true;
    },
  });
}
writeFileSync(join(target, MARKER), 'Created by scripts/export-for-github.mjs. Safe to delete; it lets the script refresh this folder.\n');
console.log(`Exported ${files} files to ${target}`);
console.log('Next: see docs/GITHUB.md (GitHub Desktop or the git commands).');
