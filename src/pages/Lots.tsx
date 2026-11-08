import { useMemo, useState } from 'react';
import { Drawer, DemoBadge, Seg } from '../components/ui';
import { PRODUCTS } from '../data/types';
import { eventVisible } from '../domain/access';
import { fmtDate, fmtEventTime, fmtKg } from '../domain/format';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { ancestors, eventLines, lotStatus } from '../domain/trace';

/**
 * Lots and stock in the officer's own scope. Butter officers get only the source
 * detail needed to receive and process (lot code, product, origin area) — never
 * collector names or prices.
 */
export function Lots() {
  const { viewer, analysis, db } = useSession();
  const [filter, setFilter] = useState<'here' | 'all'>('here');
  const [open, setOpen] = useState<string | null>(null);
  const L = viewer.locations;
  const pii = ROLES[viewer.user.role].can.collectorPersonalData;
  const myGroups = new Set(db.groups.filter((g) => L.has(g.centreId)).map((g) => g.id));

  const rows = useMemo(() => {
    const out: { lotId: string; here: number; issued: number; inbound: number }[] = [];
    for (const [lotId, lot] of analysis.lots) {
      const here = [...(analysis.stock.get(lotId) ?? new Map())].filter(([loc]) => L.has(loc)).reduce((s, [, q]) => s + q, 0);
      const issued = [...(analysis.allocated.get(lotId) ?? new Map())].filter(([g]) => myGroups.has(g)).reduce((s, [, q]) => s + q, 0);
      const inbound = analysis.openShipments.filter((s) => L.has(s.toId)).flatMap((s) => s.items).filter((i) => i.lotId === lotId).reduce((s, i) => s + i.qty, 0);
      const madeHere = L.has(lot.createdAtLocation);
      if (here > 0 || issued > 0 || inbound > 0 || (filter === 'all' && madeHere)) out.push({ lotId, here, issued, inbound });
    }
    return out.sort((a, b) => a.lotId.localeCompare(b.lotId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, filter, viewer]);

  const originOf = (lotId: string) => {
    const ids = [lotId, ...ancestors(analysis, lotId)];
    const areas = new Set(ids.map((id) => analysis.lots.get(id)).filter((l) => l?.kind === 'purchase').map((l) => l!.collectionAreaId!));
    return [...areas].map((id) => db.collectionAreas.find((a) => a.id === id)?.code ?? id).join(', ');
  };
  const name = (id: string) => analysis.places.get(id)?.name.replace(/^DEMO /, '') ?? id;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>My lots & stock</h1>
          <p>Lots at, issued at, or on their way to your locations: {[...L].map(name).join(', ')}.</p>
        </div>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            { v: 'here', l: 'Held or inbound now' },
            { v: 'all', l: 'Include used / shipped' },
          ]}
        />
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lot / batch</th>
                <th>Product</th>
                <th>Origin area</th>
                <th className="num">At my locations</th>
                <th className="num">Issued to groups</th>
                <th className="num">Inbound</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No lots in your scope.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const lot = analysis.lots.get(r.lotId)!;
                const st = lotStatus(analysis, r.lotId);
                return (
                  <tr key={r.lotId} className="clickable" onClick={() => setOpen(r.lotId)}>
                    <td>
                      <span className="id">{r.lotId}</span>
                      <DemoBadge show={!!lot.demo} />
                    </td>
                    <td>{lot.product}</td>
                    <td className="mono small">{originOf(r.lotId)}</td>
                    <td className="num">{r.here ? fmtKg(r.here) : '—'}</td>
                    <td className="num">{r.issued ? fmtKg(r.issued) : '—'}</td>
                    <td className="num">{r.inbound ? fmtKg(r.inbound) : '—'}</td>
                    <td>
                      <span className={`status ${st.tone === 'done' ? 'ok' : st.tone === 'transit' ? 'info' : 'wait'}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Drawer title={<span className="id" style={{ fontSize: 18 }}>{open}</span>} subtitle={`${PRODUCTS[analysis.lots.get(open)!.product]} · source detail limited to your role`} onClose={() => setOpen(null)}>
          <LotDetail lotId={open} pii={pii} />
        </Drawer>
      )}
    </div>
  );
}

function LotDetail({ lotId, pii }: { lotId: string; pii: boolean }) {
  const { viewer, analysis, db } = useSession();
  const lot = analysis.lots.get(lotId)!;
  const name = (id: string) => analysis.places.get(id)?.name ?? id;
  const events = analysis.sorted.filter((e) => eventLines(e).some((l) => l.lotId === lotId) && eventVisible(viewer, e));
  const parents = lot.parents;
  const anc = [...ancestors(analysis, lotId)].map((id) => analysis.lots.get(id)!).filter((l) => l.kind === 'purchase');
  const areas = [...new Set(anc.map((l) => l.collectionAreaId!))];
  const own = lot.kind === 'purchase' ? db.events.find((e) => e.id === lot.createdBy) : undefined;

  return (
    <div className="stack">
      <div className="card card-pad">
        <dl className="kv">
          <dt>Created</dt>
          <dd>
            {fmtEventTime(lot.createdAt)} at {name(lot.createdAtLocation)}
          </dd>
          <dt>Quantity created</dt>
          <dd>{fmtKg(lot.createdQty)}</dd>
          <dt>Status</dt>
          <dd>{lotStatus(analysis, lotId).label}</dd>
          {own && own.type === 'commission' && pii && (
            <>
              <dt>Collector</dt>
              <dd>{db.collectors.find((c) => c.id === own.collectorId)?.name}</dd>
              <dt>Purchase date</dt>
              <dd>{fmtDate(own.purchaseDate)}</dd>
            </>
          )}
          {areas.length > 0 && (
            <>
              <dt>Origin areas</dt>
              <dd>{areas.map((id) => db.collectionAreas.find((a) => a.id === id)?.code).join(', ')}</dd>
            </>
          )}
        </dl>
      </div>
      {parents.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Made from (Input rows)</h3>
            <span className="tiny muted">{pii ? '' : 'Collector names and prices are not shown for your role'}</span>
          </div>
          <table className="table">
            <tbody>
              {parents.map((p) => (
                <tr key={p.lotId}>
                  <td className="id">{p.lotId}</td>
                  <td>{analysis.lots.get(p.lotId)?.product}</td>
                  <td className="num">{fmtKg(p.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h3>Activity you can see</h3>
        </div>
        <table className="table">
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtEventTime(e.eventTime)}</td>
                <td>{e.type}</td>
                <td>{name(e.locationId)}</td>
                <td className="num">{fmtKg(eventLines(e).filter((l) => l.lotId === lotId).reduce((s, l) => s + l.qty, 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
