import { FileSpreadsheet, Info, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { GeoMap } from '../components/GeoMap';
import { BulkImport } from '../components/BulkImport';
import { DemoBadge, Drawer, Field, Modal, Seg } from '../components/ui';
import { MASTER_KINDS, type ImportKind } from '../domain/import/specs';
import type { CollectionArea, Location, LocationKind, ProcessingGroup, Route } from '../data/types';
import { areaCentroid } from '../domain/engine';
import { uid } from '../domain/format';
import { useStore } from '../domain/store';

const KINDS: { v: LocationKind; l: string }[] = [
  { v: 'phc', l: 'Post Harvest Centre' },
  { v: 'butter-centre', l: 'Butter centre' },
  { v: 'warehouse', l: 'Warehouse' },
  { v: 'port', l: 'Port' },
  { v: 'terminal', l: 'Arrival terminal' },
  { v: 'destination-warehouse', l: 'Destination warehouse' },
  { v: 'refiner', l: 'Refiner' },
  { v: 'filterer', l: 'Filterer' },
  { v: 'client', l: 'Client site' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.v === k)?.l ?? k;

type Tab = 'locations' | 'areas' | 'groups' | 'routes';

export function Locations() {
  const { db, mode } = useStore();
  const [tab, setTab] = useState<Tab>('locations');
  const [bulk, setBulk] = useState<ImportKind | 'any' | null>(null);
  const UploadBtn = ({ kind }: { kind: ImportKind }) => (
    <button className="btn btn-sm" onClick={() => setBulk(kind)} title="Upload many at once from a CSV or Excel file">
      <FileSpreadsheet size={14} /> Upload
    </button>
  );
  const [editLoc, setEditLoc] = useState<Location | null>(null);
  const [editArea, setEditArea] = useState<CollectionArea | null>(null);
  const [editGroup, setEditGroup] = useState<ProcessingGroup | null>(null);
  const [editRoute, setEditRoute] = useState<Route | null>(null);
  const [focus, setFocus] = useState<'ghana' | 'nl' | 'all'>('ghana');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{mode === 'demo' ? 'Locations & sample data' : 'Master data'}</h1>
          <p>
            Facilities, collection areas with their boundaries, collectors and processing groups. Add them one by one or upload a spreadsheet. Changes apply immediately to traces and
            maps, and are recorded in the audit history.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setBulk('any')}>
            <FileSpreadsheet size={16} /> Bulk upload
          </button>
        </div>
      </div>
      {mode === 'demo' && (
      <div className="finding review">
        <Info size={16} />
        <div>
          <div className="rule">Local demo records only</div>
          Every place, coordinate and polygon here is fictional and stored only in this browser. They are not SFCL's real facility coordinates or collection boundaries. To load
          approved data later, replace <code>DEMO_LOCATIONS</code> and <code>DEMO_COLLECTION_AREAS</code> in <code>src/data/geography.ts</code> (or feed the same shape from SFCL's
          backend).
        </div>
      </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Demo geography</h3>
          <Seg
            value={focus}
            onChange={setFocus}
            options={[
              { v: 'ghana', l: 'Ghana' },
              { v: 'nl', l: 'Netherlands' },
              { v: 'all', l: 'All' },
            ]}
          />
        </div>
        <GeoMap locations={db.locations} areas={db.collectionAreas} focus={focus} onSelectLocation={(id) => setEditLoc(db.locations.find((l) => l.id === id) ?? null)} height={340} />
      </div>

      <div className="tabs">
        {(['locations', 'areas', 'groups', 'routes'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {{ locations: 'Facilities', areas: 'Collection areas', groups: 'Collectors & groups', routes: 'Routes' }[t]}
          </button>
        ))}
      </div>

      {tab === 'locations' && (
        <div className="card">
          <div className="card-head">
            <h3>Facilities & waypoints</h3>
            <span className="row" style={{ gap: 6 }}>
            <UploadBtn kind="locations" />
            <button className="btn btn-sm btn-primary" onClick={() => setEditLoc({ id: uid('loc'), name: '', kind: 'phc', lat: 0, lng: 0, publicLabel: '', country: 'Ghana', demo: true })}>
              <Plus size={14} /> Add location
            </button>
            </span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="num">Latitude</th>
                  <th className="num">Longitude</th>
                  <th>Customer label</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {db.locations.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.name}
                      <DemoBadge show={l.demo} />
                      {l.publicPlace && <span className="chip" style={{ marginLeft: 6 }}>public place</span>}
                    </td>
                    <td>{kindLabel(l.kind)}</td>
                    <td className="num mono">{l.lat.toFixed(4)}</td>
                    <td className="num mono">{l.lng.toFixed(4)}</td>
                    <td className="muted">{l.publicLabel}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditLoc(l)}>
                        <Pencil size={13} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'areas' && (
        <div className="card">
          <div className="card-head">
            <h3>Collection areas (certified forest reserves)</h3>
            <span className="row" style={{ gap: 6 }}>
            <UploadBtn kind="collection_areas" />
            <button className="btn btn-sm btn-primary" onClick={() => setEditArea({ id: uid('ca'), code: '', name: '', operationalArea: '', polygon: [], demo: true, geometrySource: 'Drawn in prototype' })}>
              <Plus size={14} /> Add area
            </button>
            </span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Operational area</th>
                  <th className="num">Vertices</th>
                  <th>Centroid</th>
                  <th>Geometry source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {db.collectionAreas.map((a) => {
                  const [lng, lat] = areaCentroid(a);
                  return (
                    <tr key={a.id}>
                      <td className="id">{a.code}</td>
                      <td>
                        {a.name}
                        <DemoBadge show={a.demo} />
                      </td>
                      <td>{a.operationalArea}</td>
                      <td className="num">{Math.max(0, a.polygon.length - 1)}</td>
                      <td className="mono small">
                        {lat.toFixed(3)}, {lng.toFixed(3)}
                      </td>
                      <td className="muted">{a.geometrySource}</td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditArea(a)}>
                          <Pencil size={13} /> Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'groups' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h3>Processing groups</h3>
              <span className="row" style={{ gap: 6 }}>
              <UploadBtn kind="groups" />
              <button className="btn btn-sm btn-primary" onClick={() => setEditGroup({ id: uid('grp'), centreId: db.locations.find((l) => l.kind === 'butter-centre')?.id ?? '', name: '', members: 10, demo: true })}>
                <Plus size={14} /> Add group
              </button>
              </span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Centre</th>
                  <th>Group</th>
                  <th className="num">Members</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {db.groups.map((g) => (
                  <tr key={g.id}>
                    <td>{db.locations.find((l) => l.id === g.centreId)?.name}</td>
                    <td>
                      {g.name}
                      <DemoBadge show={g.demo} />
                    </td>
                    <td className="num">{g.members}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditGroup(g)}>
                        <Pencil size={13} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>{mode === 'demo' ? 'Collectors (fictional)' : `Collectors (${db.collectors.length})`}</h3>
              <UploadBtn kind="collectors" />
            </div>
            <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Collector code</th>
                    <th>Name</th>
                    <th>Area</th>
                  </tr>
                </thead>
                <tbody>
                  {db.collectors.map((c) => (
                    <tr key={c.id}>
                      <td className="id">{c.code}</td>
                      <td>
                        {c.name}
                        <DemoBadge show={c.demo} />
                      </td>
                      <td>{db.collectionAreas.find((a) => a.id === c.collectionAreaId)?.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'routes' && (
        <div className="card">
          <div className="card-head">
            <h3>Planned export routes</h3>
            <button className="btn btn-sm btn-primary" onClick={() => setEditRoute({ id: uid('route'), name: '', stops: [], demo: true })}>
              <Plus size={14} /> Add route
            </button>
          </div>
          <div className="card-body stack-sm">
            <p className="small muted">Routes only suggest the next stop on the shipment form. The trace always follows the shipment legs actually recorded — not every shipment ends at the same place.</p>
            {db.routes.map((r) => (
              <div key={r.id} className="task">
                <div className="body">
                  <div className="title">
                    {r.name}
                    <DemoBadge show={r.demo} />
                  </div>
                  <div className="small muted">{r.stops.map((s) => db.locations.find((l) => l.id === s)?.name ?? s).join(' → ')}</div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditRoute(r)}>
                  <Pencil size={13} /> Edit
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {bulk && (
        <Drawer title="Bulk upload: master data" subtitle="CSV or Excel · reviewed before anything is saved · all valid rows are saved together" onClose={() => setBulk(null)} icon={<FileSpreadsheet size={26} />}>
          <BulkImport kinds={MASTER_KINDS} initial={bulk === 'any' ? undefined : bulk} onDone={() => setBulk(null)} />
        </Drawer>
      )}
      {editLoc && <LocationEditor loc={editLoc} onClose={() => setEditLoc(null)} />}
      {editArea && <AreaEditor area={editArea} onClose={() => setEditArea(null)} />}
      {editGroup && <GroupEditor group={editGroup} onClose={() => setEditGroup(null)} />}
      {editRoute && <RouteEditor route={editRoute} onClose={() => setEditRoute(null)} />}
    </div>
  );
}

function LocationEditor({ loc, onClose }: { loc: Location; onClose: () => void }) {
  const { db, upsertLocation } = useStore();
  const [l, setL] = useState<Location>(loc);
  const [lat, setLat] = useState(String(loc.lat || ''));
  const [lng, setLng] = useState(String(loc.lng || ''));
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  const errors = [!l.name.trim() && 'Name is required', !(latN >= -90 && latN <= 90) && 'Latitude must be between −90 and 90', !(lngN >= -180 && lngN <= 180) && 'Longitude must be between −180 and 180'].filter(Boolean) as string[];
  return (
    <Modal title={db.locations.some((x) => x.id === loc.id) ? 'Edit location' : 'Add location'} onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name">
            <input value={l.name} onChange={(e) => setL({ ...l, name: e.target.value })} />
          </Field>
          <Field label="Type">
            <select value={l.kind} onChange={(e) => setL({ ...l, kind: e.target.value as LocationKind })}>
              {KINDS.map((k) => (
                <option key={k.v} value={k.v}>
                  {k.l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Latitude" hint="WGS84 decimal">
            <input type="number" step="any" value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude" hint="WGS84 decimal">
            <input type="number" step="any" value={lng} onChange={(e) => setLng(e.target.value)} />
          </Field>
          <Field label="Customer-facing label" hint="shown instead of the name" span={2}>
            <input value={l.publicLabel} onChange={(e) => setL({ ...l, publicLabel: e.target.value })} placeholder="e.g. Butter processing centre, northern Ghana" />
          </Field>
          {l.kind === 'phc' && (
            <Field label="Account code" hint="prefix of ODK batch IDs">
              <input className="mono" value={l.accountCode ?? ''} onChange={(e) => setL({ ...l, accountCode: e.target.value })} />
            </Field>
          )}
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!l.publicPlace} onChange={(e) => setL({ ...l, publicPlace: e.target.checked })} /> Public place (exact point may be shown to customers)
          </label>
        </div>
        <div className="small muted">Click the map to set the point.</div>
        <GeoMap locations={db.locations.filter((x) => x.id !== l.id)} areas={db.collectionAreas} draftPoint={latN && lngN ? [lngN, latN] : null} onPick={(a, b) => (setLat(String(a)), setLng(String(b)))} height={260} focus={latN > 30 ? 'nl' : 'ghana'} />
        {errors.length > 0 && <div className="tiny" style={{ color: 'var(--danger)' }}>{errors.join(' · ')}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={errors.length > 0}
            onClick={() => {
              upsertLocation({ ...l, name: l.name.trim(), lat: latN, lng: lngN, publicLabel: l.publicLabel.trim() || kindLabel(l.kind) });
              onClose();
            }}
          >
            Save demo location
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AreaEditor({ area, onClose }: { area: CollectionArea; onClose: () => void }) {
  const { db, upsertArea } = useStore();
  const [a, setA] = useState(area);
  const open = area.polygon.length > 1 ? area.polygon.slice(0, -1) : area.polygon;
  const [text, setText] = useState(open.map(([lng, lat]) => `${lat}, ${lng}`).join('\n'));
  const parsed = text
    .split('\n')
    .map((r) => r.split(/[,\s]+/).filter(Boolean).map(Number))
    .filter((r) => r.length === 2 && r.every((n) => Number.isFinite(n)))
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  const bad = text.split('\n').filter((r) => r.trim()).length !== parsed.length;
  const errors = [!a.code.trim() && 'Code is required', !a.name.trim() && 'Name is required', parsed.length < 3 && 'At least 3 vertices', bad && 'Every line must be “lat, lng”'].filter(Boolean) as string[];
  return (
    <Modal title={db.collectionAreas.some((x) => x.id === area.id) ? 'Edit collection area' : 'Add collection area'} onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Code" hint="prefix + CA, e.g. DX04-CA9410">
            <input className="mono" value={a.code} onChange={(e) => setA({ ...a, code: e.target.value })} />
          </Field>
          <Field label="Name">
            <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
          </Field>
          <Field label="Operational area">
            <input value={a.operationalArea} onChange={(e) => setA({ ...a, operationalArea: e.target.value })} />
          </Field>
          <Field label="Geometry source">
            <input value={a.geometrySource} onChange={(e) => setA({ ...a, geometrySource: e.target.value })} />
          </Field>
        </div>
        <Field label="Polygon vertices" hint="one “lat, lng” per line, or click the map to add">
          <textarea rows={5} className="mono" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setText('')}>
            Clear vertices
          </button>
          <span className="tiny muted">{parsed.length} vertices · the ring is closed automatically on save</span>
        </div>
        <GeoMap locations={db.locations} areas={db.collectionAreas.filter((x) => x.id !== a.id)} draftPolygon={parsed} onPick={(lat, lng) => setText((t) => (t.trim() ? t.trim() + '\n' : '') + `${lat}, ${lng}`)} height={280} />
        {errors.length > 0 && <div className="tiny" style={{ color: 'var(--danger)' }}>{errors.join(' · ')}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={errors.length > 0}
            onClick={() => {
              upsertArea({ ...a, code: a.code.trim(), name: a.name.trim(), polygon: [...parsed, parsed[0]] });
              onClose();
            }}
          >
            Save demo area
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GroupEditor({ group, onClose }: { group: ProcessingGroup; onClose: () => void }) {
  const { db, upsertGroup } = useStore();
  const [g, setG] = useState(group);
  const centres = db.locations.filter((l) => l.kind === 'butter-centre');
  const dup = db.groups.some((x) => x.id !== g.id && x.centreId === g.centreId && x.name.trim().toLowerCase() === g.name.trim().toLowerCase());
  return (
    <Modal title="Processing group" onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Centre">
            <select value={g.centreId} onChange={(e) => setG({ ...g, centreId: e.target.value })}>
              {centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Group name">
            <input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="Group D" />
          </Field>
          <Field label="Members">
            <input type="number" min={1} value={g.members} onChange={(e) => setG({ ...g, members: parseInt(e.target.value, 10) || 0 })} />
          </Field>
        </div>
        {dup && <div className="tiny" style={{ color: 'var(--danger)' }}>That centre already has a group with this name (a group is its centre plus its name).</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!g.name.trim() || !g.centreId || dup}
            onClick={() => {
              upsertGroup({ ...g, name: g.name.trim() });
              onClose();
            }}
          >
            Save group
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RouteEditor({ route, onClose }: { route: Route; onClose: () => void }) {
  const { db, upsertRoute } = useStore();
  const [r, setR] = useState(route);
  const [add, setAdd] = useState('');
  return (
    <Modal title="Planned route" onClose={onClose}>
      <div className="stack">
        <Field label="Name">
          <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
        </Field>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {r.stops.map((s, i) => (
            <li key={i} className="row-between" style={{ padding: '3px 0' }}>
              {db.locations.find((l) => l.id === s)?.name ?? s}
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setR({ ...r, stops: r.stops.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </li>
          ))}
        </ol>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Add a stop…</option>
            {db.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!add} onClick={() => (setR({ ...r, stops: [...r.stops, add] }), setAdd(''))}>
            Add
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!r.name.trim() || r.stops.length < 2}
            onClick={() => {
              upsertRoute(r);
              onClose();
            }}
          >
            Save route
          </button>
        </div>
      </div>
    </Modal>
  );
}
