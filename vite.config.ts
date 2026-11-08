import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy for the built site (not the dev server, which needs inline scripts
 * for hot reload). It only allows this site's own scripts, so injected code cannot run and,
 * for example, read a password as it is typed. Network access is limited to Supabase, the
 * map tiles and the password breach check. Static hosts like GitHub Pages cannot send HTTP
 * headers, so the policy is a <meta> tag (frame-ancestors therefore cannot be set here).
 */
function csp(supabaseUrl: string): Plugin {
  const sb = supabaseUrl ? new URL(supabaseUrl).host : '*.supabase.co';
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    "font-src 'self' data:",
    `connect-src 'self' https://${sb} wss://${sb} https://api.pwnedpasswords.com https://tiles.openfreemap.org`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'savannah-trace-csp',
    apply: 'build',
    // right after <meta charset>, which must stay within the first 1024 bytes of the page
    transformIndexHtml: (html) => html.replace(/(<meta charset="[^"]*" \/>)/i, `$1\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // Relative asset paths: the same build works at a domain root (trace.savannahfruits.com)
    // and under a sub-path such as GitHub Pages (babasuhuyini.github.io/SavannahTrace/).
    // Safe because the app routes with #/ and never needs server-side paths.
    base: './',
    plugins: [react(), csp(env.VITE_SUPABASE_URL ?? '')],
    server: { port: 5173 },
    build: { chunkSizeWarningLimit: 2000 },
  };
});
