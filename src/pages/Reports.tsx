import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Field } from '../components/ui';
import { findingsFor, handoffVisible, visibleDb } from '../domain/access';
import { fmtKg } from '../domain/format';
import { auditCsv, downloadCsv, findingsCsv, handoffsCsv, lineageCsv, purchasesCsv, sfclCsv, shipmentsCsv, stockCsv, traceEventsCsv, transformationsCsv, type Csv, type Privacy } from '../domain/reports';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { buildTrace, eventLines } from '../domain/trace';

/** Downloadable CSV reports. Each file holds only what the signed-in role can see. */
export function Reports() {
  const { db, analysis, viewer, user } = useSession();
  const role = user.role;
  const can = ROLES[role].can;
  const privacy: Privacy = { pii: can.collectorPersonalData, prices: can.prices, internal: role !== 'commercial' };
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const vdb = useMemo(() => ({ ...visibleDb(db, viewer), handoffs: db.handoffs.filter((h) => handoffVisible(viewer, h)) }), [db, viewer]);

  // products a trace report can be made for: SFCLs and refined/filtered products in scope
  const traceable = useMemo(() => {
    const ids = new Set<string>();
    if (role === 'commercial') vdb.handoffs.forEach((h) => ids.add(h.lotId));
    else for (const e of vdb.events) for (const l of eventLines(e)) if (['sfcl', 'refined', 'filtered'].includes(analysis.lots.get(l.lotId)?.kind ?? '')) ids.add(l.lotId);
    return [...ids].sort();
  }, [vdb, analysis, role]);
  const [lot, setLot] = useState<string>('');
  const target = lot || traceable[0] || '';
  const trace = useMemo(() => (target ? buildTrace(analysis, db, target, 'backward') : null), [analysis, db, target]);

  const registers: { key: string; name: string; what: string; make: () => Csv; show: boolean }[] = [
    { key: 'p', name: 'Purchases register', what: privacy.pii ? 'Every purchase lot with collector, area, quantity, dates' + (privacy.prices ? ' and price' : '') : 'Every purchase lot with area, quantity and dates', make: () => purchasesCsv(vdb, analysis, privacy, from, to), show: ['nut-fo', 'it-admin', 'auditor'].includes(role) },
    { key: 's', name: 'Shipments and receipts', what: 'Each lot shipped, where from and to, received quantity and discrepancies', make: () => shipmentsCsv(vdb, analysis, from, to), show: role !== 'commercial' },
    { key: 't', name: 'Transformations', what: 'OFN → ODK, ODK → OSB (LPO), SFCL aggregation, refining and filtering with yields', make: () => transformationsCsv(vdb, analysis, from, to), show: role !== 'commercial' },
    { key: 'f', name: 'SFCL summary', what: 'Each SFCL: stage, total, LPO draws, draws above 3,000 kg, destination and client', make: () => sfclCsv(vdb, analysis), show: ['butter-fo', 'supply-chain', 'it-admin', 'auditor'].includes(role) },
    { key: 'k', name: 'Stock position', what: 'What is on hand, issued to groups or in transit now', make: () => stockCsv(analysis, (loc) => role === 'it-admin' || viewer.locations.has(loc)), show: role !== 'commercial' },
    { key: 'h', name: 'Commercial handoffs', what: 'Ready-for-pickup products, clients, orders and illustrative invoice references', make: () => handoffsCsv(vdb, analysis), show: can.handoffRead },
    { key: 'v', name: 'Validation findings', what: 'Blocking, review and information findings with their rule', make: () => findingsCsv(findingsFor(viewer, analysis), analysis), show: role !== 'commercial' },
    { key: 'a', name: 'Audit history', what: 'Every recorded change, correction and access action', make: () => auditCsv(role === 'it-admin' ? db : { ...db, audit: db.audit.filter((x) => !x.action.startsWith('user.')) }), show: can.auditRead },
  ];
  const counts = useMemo(() => Object.fromEntries(registers.filter((r) => r.show).map((r) => [r.key, r.make().rows.length])), [vdb, analysis, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p>CSV files that open in Excel. Each file contains only what your role can see{privacy.pii ? '' : ' — no collector names'}{privacy.prices ? '' : ' or prices'}.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Trace report</h2>
          <span className="meta">Full backward trace of one SFCL or finished product</span>
        </div>
        <div className="panel-body">
          {traceable.length === 0 ? (
            <p className="muted">No SFCL or finished product is in your scope yet.</p>
          ) : (
            <div className="form-row">
              <Field label="Product or SFCL">
                <select value={target} onChange={(e) => setLot(e.target.value)}>
                  {traceable.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </Field>
              {trace && (
                <div className="report-facts">
                  <span>{trace.steps.length} steps</span>
                  <span>{trace.lotSet.size} lots</span>
                  <span>{fmtKg(trace.target.createdQty)}</span>
                </div>
              )}
              <div className="row">
                <button className="btn btn-primary" disabled={!trace} onClick={() => trace && downloadCsv(traceEventsCsv(trace, analysis, db, privacy))}>
                  <Download size={15} /> Download trace events
                </button>
                <button className="btn" disabled={!trace} onClick={() => trace && downloadCsv(lineageCsv(trace, analysis))}>
                  <Download size={15} /> Download lineage
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Registers</h2>
          <div className="row">
            <label className="inline-field">
              From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="inline-field">
              To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Contents</th>
              <th className="num">Rows</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {registers
              .filter((r) => r.show)
              .map((r) => (
                <tr key={r.key}>
                  <td className="strong">{r.name}</td>
                  <td className="muted">{r.what}</td>
                  <td className="num">{counts[r.key]}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => downloadCsv(r.make())} disabled={!counts[r.key]}>
                      <Download size={14} /> CSV
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="panel-foot">The date range applies to event dates. Dates are written as YYYY-MM-DD and times in the place's own time zone, with the UTC offset in its own column.</p>
      </section>
    </div>
  );
}
