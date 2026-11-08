import { useEffect, useState } from 'react';

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function useRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export const traceHref = (lotId: string, dir?: string) => `#/trace/${encodeURIComponent(lotId)}${dir ? `?dir=${dir}` : ''}`;

/** Absolute link to the customer page for a token, on this same running app. */
export const customerUrl = (token: string) => `${window.location.origin}${window.location.pathname}#/t/${token}`;
