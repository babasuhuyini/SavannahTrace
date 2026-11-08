import { AlertTriangle, BookOpen, FileDown, ChevronDown, ClipboardList, Database, Eye, Handshake, LayoutDashboard, LogOut, Package, RefreshCcw, Route as RouteIcon, ShieldCheck, Users as UsersIcon } from 'lucide-react';
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark, Wordmark } from './components/Brand';
import { Modal } from './components/ui';
import { severityCounts } from './domain/engine';
import { PAGE_LABEL, ROLES, ROLE_ORDER, type PageId } from './domain/roles';
import { useStore } from './domain/store';
import { About } from './pages/About';
import { AuthScreens } from './pages/auth/AuthScreens';
import { Handoffs } from './pages/Handoffs';
import { Home, useWorkCount } from './pages/Home';
import { Lots } from './pages/Lots';
import { Overview } from './pages/Overview';
import { go, useRoute } from './router';

// Heavier screens load on demand (the map library is only fetched with them).
const TraceExplorer = lazy(() => import('./pages/TraceExplorer').then((m) => ({ default: m.TraceExplorer })));
const CustomerTrace = lazy(() => import('./pages/CustomerTrace').then((m) => ({ default: m.CustomerTrace })));
const Locations = lazy(() => import('./pages/Locations').then((m) => ({ default: m.Locations })));
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })));
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })));
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })));

const ICONS: Record<PageId, ReactNode> = {
  home: <ClipboardList size={17} />,
  lots: <Package size={17} />,
  overview: <LayoutDashboard size={17} />,
  users: <UsersIcon size={17} />,
  audit: <ShieldCheck size={17} />,
  trace: <RouteIcon size={17} />,
  handoffs: <Handshake size={17} />,
  reports: <FileDown size={17} />,
  master: <Database size={17} />,
  about: <BookOpen size={17} />,
};

const Loading = () => <div className="empty">Loading…</div>;

export function App() {
  const route = useRoute();
  const store = useStore();

  if (route.path[0] === 't')
    return (
      <Suspense fallback={<Loading />}>
        <CustomerTrace token={route.path[1] ?? ''} />
      </Suspense>
    );
  if (store.loading) return <div className="empty" style={{ paddingTop: 120 }}>Checking your access…</div>;
  if (route.path[0] === 'auth' || !store.user) return <AuthScreens />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const { user, db, analysis, mode, signOut } = useStore();
  const workCount = useWorkCount();
  const role = ROLES[user!.role];
  const page = ((route.path[0] as PageId) || role.home) as PageId;
  const allowed = role.nav.includes(page) || page === 'about' || (page === 'master' && mode === 'demo');

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  const counts: Partial<Record<PageId, number>> = {
    home: workCount,
    handoffs: role.can.handoffEdit ? db.handoffs.filter((h) => h.status === 'new' && user!.clientNames.includes(h.clientName)).length : 0,
    audit: role.can.auditRead ? (() => {
      const c = severityCounts(analysis.findings);
      return c.blocking + c.review;
    })() : 0,
  };
  const locNames =
    user!.role === 'commercial'
      ? user!.clientNames
      : user!.locationIds.length > 4
        ? [`${user!.role === 'auditor' ? 'Audit scope' : 'All'} · ${user!.locationIds.length} locations`]
        : user!.locationIds.map((id) => analysis.places.get(id)?.name.replace(/^DEMO /, '') ?? id);

  return (
    <>
      {mode === 'demo' && (
        <div className="demo-strip" role="note">
          <AlertTriangle size={14} />
          <strong>DEMO MODE · PROTOTYPE</strong>
          <span>Fictional data stored only in this browser. Not the live process. The demo user switcher is not security.</span>
        </div>
      )}
      <header className="topbar">
        <a className="brand" href={`#/${role.home}`}>
          <BrandMark size={26} />
          <Wordmark className="brand-name" />
          <span className="brand-sub">Organic shea · chain of custody</span>
        </a>
        <div className="spacer" />
        {mode === 'demo' && <DemoMenu />}
        <div className="who">
          <div className="avatar" aria-hidden="true">
            {user!.name
              .replace(/^Demo /, '')
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0])
              .join('')}
          </div>
          <div className="meta">
            <span>{user!.name}</span>
            <span>{role.label}</span>
          </div>
        </div>
        <button className="top-btn" onClick={() => signOut().then(() => go('/'))} title="Sign out">
          <LogOut size={14} />
        </button>
      </header>

      <div className="layout">
        <nav className="sidenav" aria-label="Main">
          <div className="scope-card">
            <div className="role">{role.label}</div>
            <div className="locs">{locNames.join(' · ') || 'No locations assigned'}</div>
          </div>
          {role.nav.map((p) => (
            <a key={p} className={`nav-item ${page === p ? 'active' : ''}`} href={`#/${p}`} aria-current={page === p ? 'page' : undefined}>
              {ICONS[p]}
              {PAGE_LABEL[p]}
              {!!counts[p] && <span className="count">{counts[p]}</span>}
            </a>
          ))}
        </nav>
        <main className="main">
          <Suspense fallback={<Loading />}>
            {!allowed && <NotAllowed page={page} />}
            {allowed && page === 'home' && <Home />}
            {allowed && page === 'lots' && <Lots />}
            {allowed && page === 'overview' && <Overview />}
            {allowed && page === 'users' && <Users />}
            {allowed && page === 'audit' && <Audit />}
            {allowed && page === 'trace' && <TraceExplorer />}
            {allowed && page === 'handoffs' && <Handoffs />}
            {allowed && page === 'reports' && <Reports />}
            {allowed && page === 'master' && <Locations />}
            {allowed && page === 'about' && <About />}
          </Suspense>
        </main>
      </div>
      <Toasts />
    </>
  );
}

function NotAllowed({ page }: { page: PageId }) {
  const { user } = useStore();
  const role = ROLES[user!.role];
  return (
    <div className="card card-pad" style={{ maxWidth: 560 }}>
      <h2>Not available for your role</h2>
      <p className="muted" style={{ marginTop: 6 }}>
        {PAGE_LABEL[page] ?? 'This page'} is not part of the {role.label} workspace. In the live system the database also refuses this data, not just this screen.
      </p>
      <a className="btn" style={{ marginTop: 14 }} href={`#/${role.home}`}>
        Go to {PAGE_LABEL[role.home]}
      </a>
    </div>
  );
}

function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Prototype-only controls: demo user switcher, sample data, reset. Hidden in live mode. */
function DemoMenu() {
  const { user, db, analysis, switchUser, reset } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const users = [...db.users].filter((u) => u.status === 'active').sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const scope = (ids: string[], clients: string[]) => (clients.length ? clients.map((c) => c.replace(/^DEMO /, '')).join(', ') : ids.length > 3 ? `${ids.length} locations` : ids.map((id) => analysis.places.get(id)?.name.replace(/^DEMO /, '')).join(', '));

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="top-btn demo" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <Eye size={14} /> Demo <ChevronDown size={14} />
      </button>
      {open && (
        <div className="demo-menu" role="menu">
          <div className="dm-head">
            <b>Prototype controls.</b> Switching demo users simulates different signed-in accounts. It grants no real permission; the live system uses sign-in and database rules.
          </div>
          <div className="dm-sec">
            <div className="dm-label">Signed in as (demo)</div>
            {users.map((u) => (
              <button
                key={u.id}
                className={`dm-user ${u.id === user?.id ? 'on' : ''}`}
                onClick={() => {
                  switchUser?.(u.id);
                  setOpen(false);
                  go(`/${ROLES[u.role].home}`);
                }}
              >
                <span className="n">{u.name.replace(/^Demo /, '')}</span>
                <span className="r">
                  {ROLES[u.role].label} · {scope(u.locationIds, u.clientNames)}
                </span>
                <span className="tag">{u.id === user?.id ? 'Current' : ''}</span>
              </button>
            ))}
          </div>
          <div className="dm-sec">
            <a className="dm-item" href="#/auth" onClick={() => setOpen(false)}>
              <LogOut size={15} /> Preview sign-in & invitation screens
            </a>
            <a className="dm-item" href="#/master" onClick={() => setOpen(false)}>
              <Database size={15} /> Sample locations & geometry
            </a>
            <a className="dm-item" href="#/about" onClick={() => setOpen(false)}>
              <BookOpen size={15} /> About the demo data
            </a>
            <button
              className="dm-item"
              onClick={() => {
                setOpen(false);
                setConfirm(true);
              }}
            >
              <RefreshCcw size={15} /> Reset demo data…
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <Modal title="Reset demo data?" onClose={() => setConfirm(false)}>
          <p>This replaces everything stored in this browser with the original fictional sample, including demo users and invitations.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                reset();
                setConfirm(false);
              }}
            >
              <RefreshCcw size={14} /> Reset to sample
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
