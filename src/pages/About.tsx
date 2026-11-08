import { DEMO_TRACE_LOT } from '../data/seed';
import { traceHref } from '../router';
import { KindLabel } from '../components/ui';
import { MARKER_ORDER } from '../components/markers';

export function About() {
  return (
    <div className="stack" style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div>
          <h1>About the demo data</h1>
          <p>What this prototype is, what the sample scenario contains, and where real data would go later.</p>
        </div>
      </div>

      <div className="card card-pad stack-sm">
        <h2>What this is</h2>
        <p>
          A browser-only learning prototype of SFCL's own, independently owned traceability system. It shows the intended direct-entry workflows so the team can try them before
          choosing a database, cloud provider or production architecture. It does not connect to the current vendor platform, any cloud service, email or invoicing system.
          In demo mode, users are simulated through the Demo menu — there is no real login. With a Supabase project configured, the same screens run on invitation-only sign-in, and the database enforces each role's access.
        </p>
        <p>Data is kept in this browser's local storage, survives a refresh, and is restored to the original sample by <b>Reset demo data</b>.</p>
      </div>

      <div className="card card-pad stack-sm">
        <h2>The sample scenario (fictional)</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <b>Three fictional collection areas</b> (hexagons in northern Ghana): DEMO Kulaa sells fresh nut (OFN); DEMO Sabon and DEMO Tingbaa sell purchased dried kernel (ODK), which
            bypasses the post-harvest centre.
          </li>
          <li>
            <b>Fresh-nut route:</b> 12 OFN purchase lots → DEMO Nayiri PHC → two ODK batches (<code>DX01-CA9150-B001-073026</code>, <code>…B002-080626</code>).
          </li>
          <li>
            <b>Butter centres:</b> DEMO Tamba and DEMO Kalbe receive ODK, issue it to four named groups, and produce seven LPOs (<code>LPO-90411</code>…<code>LPO-90417</code>).
            Purchase lots and ODK batches split across several LPOs.
          </li>
          <li>
            <b>Warehouse:</b> the seven LPOs converge into <a href={traceHref(DEMO_TRACE_LOT)}>SFCL 26901</a> (exactly 21,000 kg, finalized). Remaining LPO balances start{' '}
            <a href={traceHref('SFCL 26902')}>SFCL 26902</a>, which is in progress.
          </li>
          <li>
            <b>Intentional review warning:</b> LPO-90411 contributes 3,660 kg — above the usual 3,000 kg — to close the shortfall left by LPO-90417 (only 2,340 kg produced). It is
            flagged for review, not blocked, and never exceeds what LPO-90411 actually produced.
          </li>
          <li>
            <b>Export:</b> warehouse → Tema → DEMO Amsterdam Bulk Liquid Terminal. In Amsterdam a shipment is either refined or filtered (Supply Chain): SFCL 26901 goes to DEMO Zaan Refining, becomes{' '}
            <a href={traceHref('ORSB 26901-R1')}>ORSB 26901-R1</a> and is marked <b>Arrived and ready for pickup</b>, which creates the Commercial handoff. The client's link shows the entire SFCL trace.
          </li>
          <li>
            <b>Open work:</b> an ODK consignment in transit to DEMO Kalbe (Butter FO can receive it), an unshipped ODK purchase at DEMO Sabon (Nut FO), 400 kg of unissued ODK at
            DEMO Tamba, and one past correction in the audit history.
          </li>
        </ul>
        <p className="small muted">
          All names, lot numbers, LPO/SFCL numbers, clients, invoice references, certificates and timestamps are invented. Seeded records carry a <span className="demo-badge">DEMO</span>{' '}
          badge, and demo timestamps are labelled as illustrative.
        </p>
      </div>

      <div className="card card-pad stack-sm">
        <h2>Map conventions</h2>
        <p>Each event type has its own marker shape, icon and label (colour is only a secondary cue):</p>
        <div className="row" style={{ gap: '8px 16px' }}>
          {MARKER_ORDER.map((k) => (
            <KindLabel key={k} kind={k} />
          ))}
        </div>
        <p>
          Dashed arcs connect the recorded sequence of custody locations. They are not roads, routes or GPS tracks; this demo has no GPS breadcrumbs. Customer pages default to a
          generalized origin (30 km circles, facilities rounded to ~25 km) or a masked mode; the internal map shows the full demo geometry. If online map tiles are unavailable, a
          built-in offline basemap (Natural Earth, public domain) is used and the timeline keeps working.
        </p>
      </div>

      <div className="card card-pad stack-sm">
        <h2>Replacing demo data with real, approved data</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <b>Facility coordinates:</b> <code>DEMO_LOCATIONS</code> in <code>src/data/geography.ts</code> (WGS84 latitude/longitude, plus a customer-safe label).
          </li>
          <li>
            <b>Collection-area polygons:</b> <code>DEMO_COLLECTION_AREAS</code> in the same file (GeoJSON <code>[lng, lat]</code> rings; record source and version).
          </li>
          <li>
            <b>Collectors, groups, routes:</b> <code>DEMO_COLLECTORS</code>, <code>DEMO_GROUPS</code>, <code>DEMO_ROUTES</code>.
          </li>
          <li>
            <b>Events:</b> <code>src/data/seed.ts</code>. The screens read everything through <code>src/domain/store.tsx</code>, which is the single place to swap local storage
            for SFCL's own API.
          </li>
        </ul>
        <p className="small muted">Real sourcing geometry is sensitive: keep exact polygons and facility points restricted to authorised staff unless a client is approved to see them.</p>
      </div>
    </div>
  );
}
