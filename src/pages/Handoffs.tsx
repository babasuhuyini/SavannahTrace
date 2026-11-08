import { CheckCircle2, Download, ExternalLink, Receipt, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { TraceLinkPanel } from '../components/QrCode';
import { DemoBadge, Empty, Field, LotLink } from '../components/ui';
import { PRODUCTS, type Disclosure, type Handoff } from '../data/types';
import { fmtEventTime, fmtKg, fmtRecorded } from '../domain/format';
import { handoffVisible } from '../domain/access';
import { ROLES } from '../domain/roles';
import { useSession } from '../domain/store';
import { downloadCsv, traceEventsCsv } from '../domain/reports';
import { buildTrace } from '../domain/trace';

const INVOICE_LABEL: Record<Handoff['invoiceStatus'], string> = {
  'not-started': 'Not started',
  'in-preparation': 'In preparation (demo)',
  'recorded-demo': 'Reference recorded (demo — nothing sent)',
};

export function Handoffs() {
  const { db, user, viewer } = useSession();
  const canEdit = ROLES[user.role].can.handoffEdit;
  const list = db.handoffs.filter((h) => handoffVisible(viewer, h)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Commercial handoffs</h1>
          <p>
            Created automatically when Supply Chain marks a shipment <b>Arrived and ready for pickup</b>. Commercial uses the trace link and QR while preparing the invoice.
            Invoices are not issued or sent from this prototype.
          </p>
        </div>
        {!canEdit && <span className="chip chip-info">Read-only for {ROLES[user.role].label}</span>}
      </div>
      {list.length === 0 && (
        <div className="card">
          <Empty>{canEdit ? 'No handoffs for your assigned clients yet.' : 'No handoffs in your scope yet.'}</Empty>
        </div>
      )}
      {list.map((h) => (
        <HandoffCard key={h.id} h={h} canEdit={canEdit} />
      ))}
    </div>
  );
}

function HandoffCard({ h, canEdit }: { h: Handoff; canEdit: boolean }) {
  const { analysis, db, updateHandoff, traceLink } = useSession();
  const [invoiceRef, setInvoiceRef] = useState(h.invoiceRef ?? '');
  const [invoiceStatus, setInvoiceStatus] = useState(h.invoiceStatus);
  const ready = analysis.byId.get(h.readyEventId);
  const place = analysis.places.get(h.locationId);
  const dirty = invoiceRef !== (h.invoiceRef ?? '') || invoiceStatus !== h.invoiceStatus;

  return (
    <article className="card">
      <div className="card-head">
        <div className="row">
          <ShieldCheck size={18} color="#c4851a" />
          <h3>
            <LotLink id={h.lotId} demo={h.demo} /> · {fmtKg(h.qty)} {h.product}
          </h3>
          <span className={`chip ${h.status === 'acknowledged' ? 'chip-forest' : 'chip-amber'}`}>{h.status === 'acknowledged' ? 'Acknowledged by Commercial' : 'New — awaiting Commercial'}</span>
        </div>
        <span className="small muted">Created {fmtRecorded(h.createdAt)}</span>
      </div>
      <div className="card-body grid-2">
        <div className="stack">
          <dl className="kv">
            <dt>Product</dt>
            <dd>
              {PRODUCTS[h.product]} ({h.product})
            </dd>
            <dt>Client</dt>
            <dd>
              {h.clientName}
              <DemoBadge />
            </dd>
            <dt>Order reference</dt>
            <dd className="mono">{h.orderRef}</dd>
            <dt>Ready at</dt>
            <dd>{place?.name}</dd>
            <dt>Ready since</dt>
            <dd>{ready ? fmtEventTime(ready.eventTime) : '—'}</dd>
            <dt>Customer view</dt>
            <dd>
              <select
                value={h.disclosure}
                disabled={!canEdit}
                onChange={(e) => updateHandoff(h.id, { disclosure: e.target.value as Disclosure }, `Customer map disclosure set to ${e.target.value} for ${h.lotId}`)}
                style={{ width: 'auto' }}
              >
                <option value="full">Full trace (default)</option>
                <option value="generalized">Generalised origin</option>
                <option value="masked">Masked coordinates</option>
              </select>
            </dd>
          </dl>
          <div className="row">
            <button className="btn btn-sm" onClick={async () => { const u = await traceLink(h); if (u) window.open(u, '_blank', 'noopener'); }}>
              <ExternalLink size={14} /> Preview customer page
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                const tr = buildTrace(analysis, db, h.lotId, 'backward', h.locationId);
                if (tr) downloadCsv(traceEventsCsv(tr, analysis, db, { pii: false, prices: false, internal: false }));
              }}
              title="The same trace the customer sees, as a CSV"
            >
              <Download size={14} /> Trace CSV
            </button>
            {h.status === 'new' ? (
              <button className="btn btn-sm btn-primary" disabled={!canEdit} onClick={() => updateHandoff(h.id, { status: 'acknowledged', acknowledgedAt: new Date().toISOString() }, `Handoff for ${h.lotId} acknowledged by Commercial`)}>
                <CheckCircle2 size={14} /> Acknowledge handoff
              </button>
            ) : (
              <span className="small muted">Acknowledged {h.acknowledgedAt ? fmtRecorded(h.acknowledgedAt) : ''}</span>
            )}
          </div>
          <div className="sub-panel">
            <div className="row" style={{ marginBottom: 10 }}>
              <Receipt size={16} />
              <b>Illustrative invoice reference</b>
              <span className="chip">demo only · nothing is issued or sent</span>
            </div>
            <div className="form-grid">
              <Field label="Invoice reference">
                <input value={invoiceRef} disabled={!canEdit} onChange={(e) => setInvoiceRef(e.target.value)} placeholder="e.g. DEMO-INV-2026-0412" />
              </Field>
              <Field label="Status">
                <select value={invoiceStatus} disabled={!canEdit} onChange={(e) => setInvoiceStatus(e.target.value as Handoff['invoiceStatus'])}>
                  {Object.entries(INVOICE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button
              className="btn btn-sm"
              style={{ marginTop: 10 }}
              disabled={!canEdit || !dirty}
              onClick={() => updateHandoff(h.id, { invoiceRef: invoiceRef.trim() || undefined, invoiceStatus }, `Invoice reference updated for ${h.lotId} (illustrative)`)}
            >
              Save reference
            </button>
          </div>
        </div>
        <div>
          <TraceLinkPanel handoff={h} />
        </div>
      </div>
    </article>
  );
}
