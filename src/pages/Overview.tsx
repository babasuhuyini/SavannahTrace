import { ArrowRight, History, Users as UsersIcon } from 'lucide-react';
import { useMemo } from 'react';
import { FindingList } from '../components/ui';
import { DEMO_TRACE_LOT } from '../data/seed';
import { severityCounts, type Analysis } from '../domain/engine';
import { fmtKg, fmtRecorded } from '../domain/format';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { traceHref } from '../router';

function stageInventory(a: Analysis) {
  const buckets = [
    { id: 'origin', label: 'Collection areas', kinds: ['collection-area'], kg: 0, lots: new Set<string>() },
    { id: 'transit', label: 'In transit', kinds: [], kg: 0, lots: new Set<string>() },
    { id: 'phc', label: 'Post-harvest', kinds: ['phc'], kg: 0, lots: new Set<string>() },
    { id: 'butter', label: 'Butter centres', kinds: ['butter-centre'], kg: 0, lots: new Set<string>() },
    { id: 'warehouse', label: 'Warehouse', kinds: ['warehouse'], kg: 0, lots: new Set<string>() },
    { id: 'dest', label: 'Export & destination', kinds: ['port', 'terminal', 'destination-warehouse', 'refiner', 'filterer', 'client'], kg: 0, lots: new Set<string>() },
  ];
  for (const [lot, m] of a.stock)
    for (const [loc, q] of m) {
      if (q <= 0) continue;
      const b = buckets.find((x) => x.kinds.includes(a.places.get(loc)?.kind ?? ''));
      if (b) (b.kg += q), b.lots.add(lot);
    }
  for (const [lot, m] of a.allocated)
    for (const [, q] of m)
      if (q > 0) {
        buckets[3].kg += q;
        buckets[3].lots.add(lot);
      }
  for (const s of a.openShipments)
    for (const i of s.items) {
      buckets[1].kg += i.qty;
      buckets[1].lots.add(i.lotId);
    }
  return buckets;
}

/** IT Admin: system-wide oversight. Officers never see this screen. */
export function Overview() {
  const { db, analysis } = useSession();
  const inv = useMemo(() => stageInventory(analysis), [analysis]);
  const counts = severityCounts(analysis.findings);
  const active = db.users.filter((u) => u.status === 'active').length;
  const suspended = db.users.length - active;
  const pending = db.invitations.filter((i) => i.status === 'pending' && new Date(i.expiresAt).getTime() > Date.now()).length;
  const recent = [...db.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>System overview</h1>
          <p>Health of the traceability record, access, and where stock sits across the chain.</p>
        </div>
        <a className="btn" href={traceHref(DEMO_TRACE_LOT)}>
          Open sample trace <ArrowRight size={15} />
        </a>
      </div>

      <div className="grid-4">
        <div className="card metric">
          <div className="v">{db.events.length}</div>
          <div className="l">Events recorded</div>
        </div>
        <div className="card metric">
          <div className="v" style={{ color: counts.blocking ? 'var(--danger)' : undefined }}>{counts.blocking}</div>
          <div className="l">Blocking findings</div>
        </div>
        <div className="card metric">
          <div className="v" style={{ color: counts.review ? 'var(--amber-ink)' : undefined }}>{counts.review}</div>
          <div className="l">Needs review</div>
        </div>
        <div className="card metric">
          <div className="v">{analysis.openShipments.length}</div>
          <div className="l">Shipments in transit</div>
        </div>
      </div>

      <section>
        <div className="section-title">
          <h2>Where stock is now</h2>
          <span className="muted small">Derived from the event ledger, never edited directly</span>
        </div>
        <div className="stage-strip">
          {inv.map((b) => (
            <div key={b.id}>
              <div className="n">{fmtKg(b.kg)}</div>
              <div className="l">
                {b.label} · {b.lots.size} lot{b.lots.size === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Review queue</h3>
            <a className="small" href="#/audit">
              All findings
            </a>
          </div>
          <div className="card-body">
            <FindingList findings={analysis.findings.filter((f) => f.severity !== 'info').slice(0, 5)} />
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3 className="row" style={{ gap: 8 }}>
                <UsersIcon size={16} /> Access
              </h3>
              <a className="small" href="#/users">
                Manage users
              </a>
            </div>
            <div className="card-body">
              <div className="kv-row">
                <span>Active users</span>
                <span className="v">{active}</span>
              </div>
              <div className="kv-row">
                <span>Suspended</span>
                <span className="v">{suspended}</span>
              </div>
              <div className="kv-row">
                <span>Pending invitations</span>
                <span className="v">{pending}</span>
              </div>
              <div className="kv-row">
                <span>Roles in use</span>
                <span className="v">{[...new Set(db.users.map((u) => ROLES[u.role].short))].join(', ')}</span>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="row" style={{ gap: 8 }}>
                <History size={16} /> Recent administrative & audit activity
              </h3>
            </div>
            <div className="card-body">
              {recent.map((e) => (
                <div key={e.id} className="kv-row">
                  <span className="small">{e.summary}</span>
                  <span className="tiny muted nowrap">{fmtRecorded(e.at)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
