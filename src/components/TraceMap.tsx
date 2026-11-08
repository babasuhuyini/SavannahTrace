// Interactive trace map (MapLibre). Lazy-loaded: only Trace explorer and the
// customer page pull in maplibre-gl, so other screens stay light.
//
// Visual encodings (shape + label first, colour second):
//   collection area  → dashed-outline polygon (generalised circle for customers)
//   facility         → small square base marker + name
//   event            → distinct marker shape per event type, fanned around its facility
//   custody hand-off → dashed arc between recorded locations (never a GPS track)
//   current state    → pulsing ring + endpoint card

import maplibregl, { type LngLatBoundsLike, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Crosshair, Globe2, MapPinned, SlidersHorizontal, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DemoDB } from '../data/types';
import { MODE_LABEL, displayArea, displayPlace, type MapMode } from '../domain/disclosure';
import type { Analysis } from '../domain/engine';
import type { MarkerKind, Trace, Waypoint } from '../domain/trace';
import { MARKER_META, MARKER_ORDER, PRODUCT_COLOR, markerGlyphHtml } from './markers';
import { MarkerGlyph } from './ui';

export const ONLINE_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Basemap = 'online' | 'offline';

let offlineStyleCache: Promise<StyleSpecification> | null = null;
export function offlineStyle(): Promise<StyleSpecification> {
  offlineStyleCache ??= Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client')]).then(([topo, tc]) => {
    const t = (topo as unknown as { default: never }).default ?? topo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countries = tc.feature(t as any, (t as any).objects.countries);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const borders = tc.mesh(t as any, (t as any).objects.countries, (a: unknown, b: unknown) => a !== b);
    return {
      version: 8,
      sources: {
        land: { type: 'geojson', data: countries as GeoJSON.GeoJSON, attribution: 'Offline basemap: Natural Earth (public domain) via world-atlas' },
        borders: { type: 'geojson', data: borders as GeoJSON.GeoJSON },
      },
      layers: [
        { id: 'sea', type: 'background', paint: { 'background-color': '#d6e2df' } },
        { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#f3eee1' } },
        { id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': '#c6b996', 'line-width': 0.8 } },
      ],
    } satisfies StyleSpecification;
  });
  return offlineStyleCache;
}

function arc(a: [number, number], b: [number, number], curvature = 0.16, n = 48): [number, number][] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx = (x1 + x2) / 2 - dy * curvature;
  const cy = (y1 + y2) / 2 + dx * curvature;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
  }
  return pts;
}

export interface TraceMapProps {
  trace: Trace;
  db: DemoDB;
  analysis: Analysis;
  mode: MapMode;
  /** Offer these disclosure modes in the View menu (internal users only). */
  modeOptions?: MapMode[];
  onModeChange?: (m: MapMode) => void;
  selectedStepId?: string;
  highlightWaypointId?: string;
  onSelectWaypoint: (waypointId: string) => void;
  /** Current/final state shown in the endpoint card. */
  endpoint?: { title: string; detail?: string; locationId?: string };
  /** Ask the map to fit these locations (e.g. when a timeline stage opens). */
  focusRequest?: { ids: string[]; n: number };
  children?: ReactNode;
}

export default function TraceMap(props: TraceMapProps) {
  const [basemap, setBasemap] = useState<Basemap>(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online'));
  const [view3d, setView3d] = useState(() => !reduceMotion());
  const [tileProblem, setTileProblem] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<string>('');
  return (
    <div className="map-shell">
      <div style={{ position: 'relative' }}>
        <MapInner
          key={basemap}
          {...props}
          basemap={basemap}
          view3d={view3d}
          setView3d={setView3d}
          onStyleFailed={(why) => {
            setFallbackReason(why);
            setBasemap('offline');
          }}
          onTileProblem={setTileProblem}
          setBasemap={(b) => {
            setTileProblem(false);
            setFallbackReason('');
            setBasemap(b);
          }}
        />
        {(tileProblem || fallbackReason) && (
          <div className="map-banner" role="status">
            <WifiOff size={15} />
            <span>
              {fallbackReason || 'Some basemap tiles failed to load.'} The trace and timeline still work.
              {tileProblem && basemap === 'online' && (
                <>
                  {' '}
                  <button className="link-btn" onClick={() => setBasemap('offline')}>
                    Use offline basemap
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {props.children}
      </div>
      <Legend kinds={[...new Set(props.trace.waypoints.map((w) => w.kind))]} />
    </div>
  );
}

function Legend({ kinds }: { kinds: MarkerKind[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? MARKER_ORDER : MARKER_ORDER.filter((k) => kinds.includes(k));
  return (
    <div className="legend" aria-label="Map legend">
      <span className="legend-item">
        <i className="lg-area" /> Collection area
      </span>
      <span className="legend-item">
        <i className="lg-facility" /> Facility
      </span>
      <span className="legend-item">
        <i className="lg-line" /> Custody hand-off (not a GPS track)
      </span>
      {shown.map((k) => (
        <span key={k} className="legend-item">
          <MarkerGlyph kind={k} size={17} />
          {MARKER_META[k].label}
        </span>
      ))}
      <button className="link-btn tiny" onClick={() => setAll(!all)}>
        {all ? 'Only symbols in this trace' : 'All symbols'}
      </button>
    </div>
  );
}

interface InnerProps extends TraceMapProps {
  basemap: Basemap;
  view3d: boolean;
  setView3d: (v: boolean) => void;
  onStyleFailed: (why: string) => void;
  onTileProblem: (v: boolean) => void;
  setBasemap: (b: Basemap) => void;
}

function MapInner(p: InnerProps) {
  const { trace, db, analysis, mode, selectedStepId, highlightWaypointId, basemap, view3d } = p;
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [zoomTick, setZoomTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const cbRef = useRef(p);
  cbRef.current = p;

  // display positions for every place used in this trace (respecting disclosure mode)
  const display = useMemo(() => {
    const m = new Map<string, ReturnType<typeof displayPlace>>();
    const ids = new Set<string>([...trace.waypoints.map((w) => w.locationId), ...trace.edges.flatMap((e) => [e.fromId, e.toId])]);
    for (const id of ids) {
      const pl = analysis.places.get(id);
      if (pl) m.set(id, displayPlace(pl, mode));
    }
    return m;
  }, [trace, analysis, mode]);

  const areaFeatures = useMemo(() => {
    const feats: GeoJSON.Feature[] = [];
    for (const id of trace.areaIds) {
      const a = db.collectionAreas.find((x) => x.id === id);
      if (!a) continue;
      const d = displayArea(a, mode);
      if (!d) continue;
      feats.push({ type: 'Feature', properties: { name: d.label, generalized: d.generalized }, geometry: { type: 'Polygon', coordinates: [d.polygon] } });
    }
    return { type: 'FeatureCollection', features: feats } as GeoJSON.FeatureCollection;
  }, [trace, db, mode]);

  const edgeFeatures = useMemo(() => {
    const max = Math.max(1, ...trace.edges.map((e) => e.qty));
    const selEdge = (stepIds: string[]) => (selectedStepId ? stepIds.includes(selectedStepId) : false);
    const feats: GeoJSON.Feature[] = trace.edges
      .map((e) => {
        const a = display.get(e.fromId);
        const b = display.get(e.toId);
        if (!a || !b) return null;
        // long sea legs bend west, away from an overland straight line (still only a schematic arc)
        const long = Math.abs(a.lat - b.lat) > 10;
        return {
          type: 'Feature',
          properties: { color: PRODUCT_COLOR[e.product] ?? '#2d6a4a', w: 2 + 4.5 * Math.sqrt(e.qty / max), sel: selEdge(e.stepIds) },
          geometry: { type: 'LineString', coordinates: arc([a.lng, a.lat], [b.lng, b.lat], long ? 0.55 : 0.16) },
        } as GeoJSON.Feature;
      })
      .filter(Boolean) as GeoJSON.Feature[];
    return { type: 'FeatureCollection', features: feats } as GeoJSON.FeatureCollection;
  }, [trace, display, selectedStepId]);

  const areaPts = useMemo(() => areaFeatures.features.flatMap((f) => (f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]), [areaFeatures]);
  const allPoints = useMemo(() => [...[...display.values()].map((d) => [d.lng, d.lat] as [number, number]), ...areaPts], [display, areaPts]);
  const hasFar = useMemo(() => [...display.values()].some((d) => d.lat > 30), [display]);
  const nearPoints = useMemo(() => allPoints.filter((pt) => pt[1] < 30), [allPoints]);
  const farPoints = useMemo(() => allPoints.filter((pt) => pt[1] >= 30), [allPoints]);

  const boundsOf = (pts: [number, number][]): LngLatBoundsLike | null => {
    if (!pts.length) return null;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    pts.forEach((x) => b.extend(x));
    return b;
  };
  const padding = () => {
    const w = el.current?.clientWidth ?? 800;
    return w < 600 ? { top: 64, bottom: 90, left: 30, right: 30 } : { top: 70, bottom: 90, left: 60, right: 60 };
  };
  const fit = (pts: [number, number][], maxZoom = 11) => {
    const map = mapRef.current;
    const b = boundsOf(pts);
    if (map && b) map.fitBounds(b, { padding: padding(), maxZoom, duration: reduceMotion() ? 0 : 800, pitch: cbRef.current.view3d ? 40 : 0, bearing: 0 });
  };
  // Default view: origin → Tema (readable Ghana geography). The destination is shown in
  // the endpoint card and one click away; "Fit route" shows the whole intercontinental route.
  const fitDefault = () => fit(hasFar && nearPoints.length ? nearPoints : allPoints, 9);

  // ── create map ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const style = basemap === 'online' ? ONLINE_STYLE : await offlineStyle();
      if (cancelled || !el.current) return;
      const map = new maplibregl.Map({
        container: el.current,
        style,
        center: [-1.0, 9.0],
        zoom: 5.6,
        pitch: view3d ? 40 : 0,
        attributionControl: { compact: true, customAttribution: 'Trace geometry: fictional demo data' },
        maxPitch: 60,
        fadeDuration: 0,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      let loaded = false;
      let tileErrors = 0;
      if (basemap === 'online') {
        timer = setTimeout(() => !loaded && cbRef.current.onStyleFailed('The online basemap did not load (offline or blocked), so the built-in offline basemap is shown.'), 9000);
      }
      map.on('error', (ev) => {
        if (!loaded && basemap === 'online') {
          cbRef.current.onStyleFailed('The online basemap could not be reached, so the built-in offline basemap is shown.');
          return;
        }
        const msg = String((ev as { error?: Error }).error?.message ?? '');
        if (/tile|fetch|Failed|404|NetworkError/i.test(msg) && ++tileErrors > 4) cbRef.current.onTileProblem(true);
      });
      map.on('load', () => {
        loaded = true;
        if (timer) clearTimeout(timer);
        map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addSource('edges', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', paint: { 'fill-color': '#2d6a4a', 'fill-opacity': 0.14 } });
        map.addLayer({
          id: 'areas-extrude',
          type: 'fill-extrusion',
          source: 'areas',
          paint: { 'fill-extrusion-color': '#3f7d5a', 'fill-extrusion-height': 9000, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.5 },
        });
        map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': '#1c4532', 'line-width': 1.6, 'line-dasharray': [3, 2] } });
        map.addLayer({ id: 'edges-casing', type: 'line', source: 'edges', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fffdf8', 'line-width': ['+', ['get', 'w'], 2.5], 'line-opacity': 0.85 } });
        map.addLayer({
          id: 'edges',
          type: 'line',
          source: 'edges',
          layout: { 'line-cap': 'butt' },
          paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-dasharray': [2, 1.4], 'line-opacity': 0.9 },
        });
        map.addLayer({
          id: 'edges-sel',
          type: 'line',
          source: 'edges',
          filter: ['==', ['get', 'sel'], true],
          paint: { 'line-color': '#c4851a', 'line-width': ['+', ['get', 'w'], 2], 'line-opacity': 0.95 },
        });
        setReady(true);
      });
      map.on('zoomend', () => setZoomTick((t) => t + 1));
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('areas') as maplibregl.GeoJSONSource).setData(areaFeatures);
    (map.getSource('edges') as maplibregl.GeoJSONSource).setData(edgeFeatures);
  }, [ready, areaFeatures, edgeFeatures]);

  const fitKey = `${trace.target.lotId}|${trace.direction}|${mode}`;
  useEffect(() => {
    if (ready) fitDefault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey]);

  useEffect(() => {
    if (!ready || !p.focusRequest?.ids.length) return;
    const pts = p.focusRequest.ids.map((id) => display.get(id)).filter(Boolean).map((d) => [d!.lng, d!.lat] as [number, number]);
    if (p.focusRequest.ids.some((id) => analysis.places.get(id)?.kind === 'collection-area')) pts.push(...areaPts);
    const span = pts.length ? Math.max(...pts.map((x) => x[1])) - Math.min(...pts.map((x) => x[1])) : 0;
    if (pts.length) fit(pts, span > 20 ? 9 : pts.every((x) => x[1] > 30) ? 11.5 : 9);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, p.focusRequest?.n]);

  // 3D toggle (camera only when the user flips it, so the first fit isn't interrupted)
  const lastView3d = useRef(view3d);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty('areas-extrude', 'visibility', view3d ? 'visible' : 'none');
    map.setLayoutProperty('areas-fill', 'visibility', view3d ? 'none' : 'visible');
    if (lastView3d.current !== view3d) map.easeTo({ pitch: view3d ? 40 : 0, bearing: 0, duration: reduceMotion() ? 0 : 600 });
    lastView3d.current = view3d;
  }, [ready, view3d]);

  // ── markers ──────────────────────────────────────────────────────────────
  const selectedWp = useMemo(() => trace.steps.find((s) => s.id === selectedStepId)?.waypointId, [trace, selectedStepId]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const add = (m: maplibregl.Marker) => {
      m.addTo(map);
      markersRef.current.push(m);
    };

    const byLoc = new Map<string, Waypoint[]>();
    for (const w of trace.waypoints) {
      if (!display.has(w.locationId)) continue;
      byLoc.set(w.locationId, [...(byLoc.get(w.locationId) ?? []), w]);
    }
    const zoom = map.getZoom();
    const showLabels = zoom >= 8.3;
    // cluster places that overlap on screen
    const clusters: { ids: string[]; x: number; y: number }[] = [];
    for (const id of byLoc.keys()) {
      const d = display.get(id)!;
      const pt = map.project([d.lng, d.lat]);
      const c = clusters.find((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < 58);
      if (c) {
        c.ids.push(id);
        c.x = (c.x * (c.ids.length - 1) + pt.x) / c.ids.length;
        c.y = (c.y * (c.ids.length - 1) + pt.y) / c.ids.length;
      } else clusters.push({ ids: [id], x: pt.x, y: pt.y });
    }

    // origin region label at route-level zoom
    if (zoom < 7.4 && areaPts.length) {
      const lng = areaPts.reduce((s, x) => s + x[0], 0) / areaPts.length;
      const lat = Math.max(...areaPts.map((x) => x[1]));
      const lab = document.createElement('div');
      lab.className = 'region-label';
      lab.textContent = `Origin · ${trace.areaIds.length} collection area${trace.areaIds.length === 1 ? '' : 's'}, northern Ghana${mode === 'internal' ? ' (demo)' : ''}`;
      add(new maplibregl.Marker({ element: lab, anchor: 'bottom', offset: [0, -40] }).setLngLat([lng, lat]));
    }

    // "you are here" pulse at the current/final location (animation on an inner element)
    const here = trace.status.locationId && display.get(trace.status.locationId);
    if (here) {
      const wrap = document.createElement('div');
      wrap.style.pointerEvents = 'none';
      wrap.appendChild(Object.assign(document.createElement('div'), { className: 'here-pulse' }));
      add(new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([here.lng, here.lat]));
    }

    for (const c of clusters) {
      if (c.ids.length > 1) {
        const steps = c.ids.reduce((s, id) => s + byLoc.get(id)!.reduce((t, w) => t + w.stepIds.length, 0), 0);
        const hasSel = c.ids.some((id) => byLoc.get(id)!.some((w) => w.id === selectedWp));
        const btn = document.createElement('button');
        btn.className = `mk-cluster${hasSel ? ' sel' : ''}`;
        const far = c.ids.every((id) => display.get(id)!.lat > 30);
        btn.textContent = `${far ? 'Destination' : c.ids.length + ' places'} · ${steps} steps`;
        btn.title = c.ids.map((id) => display.get(id)!.name).join('\n');
        btn.setAttribute('aria-label', `Zoom to ${c.ids.length} places`);
        btn.onclick = (ev) => {
          ev.stopPropagation();
          fit(c.ids.map((id) => [display.get(id)!.lng, display.get(id)!.lat]), 12);
        };
        add(new maplibregl.Marker({ element: btn, anchor: 'center' }).setLngLat(map.unproject([c.x, c.y])));
        continue;
      }
      const id = c.ids[0];
      const d = display.get(id)!;
      const isArea = analysis.places.get(id)?.kind === 'collection-area';
      if (!isArea) {
        const f = document.createElement('div');
        f.className = 'facility-dot';
        f.setAttribute('aria-hidden', 'true');
        add(new maplibregl.Marker({ element: f, anchor: 'center' }).setLngLat([d.lng, d.lat]));
      }
      const wps = byLoc.get(id)!.sort((a, b) => +new Date(a.start) - +new Date(b.start));
      const n = wps.length;
      const r = n > 1 ? 17 + n * 3 : 0;
      wps.forEach((w, i) => {
        const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
        const off: [number, number] = n > 1 ? [Math.round(Math.cos(ang) * r), Math.round(Math.sin(ang) * r)] : [0, -18];
        const btn = document.createElement('button');
        const meta = MARKER_META[w.kind];
        const isSel = w.id === selectedWp;
        const isHl = w.id === highlightWaypointId;
        btn.className = `mk${isSel ? ' sel' : ''}${selectedWp && !isSel && !isHl ? ' dim' : ''}`;
        btn.innerHTML = `${markerGlyphHtml(w.kind, 25)}${showLabels || isSel || isHl ? `<span class="mk-label">${meta.short}</span>` : ''}`;
        btn.setAttribute('aria-label', `${meta.label} at ${d.name}, ${w.stepIds.length} step${w.stepIds.length > 1 ? 's' : ''}`);
        btn.title = `${meta.label} — ${d.name}`;
        btn.onclick = (ev) => {
          ev.stopPropagation();
          cbRef.current.onSelectWaypoint(w.id);
        };
        add(new maplibregl.Marker({ element: btn, anchor: 'center', offset: off }).setLngLat([d.lng, d.lat]));
      });
      if (zoom < 5.5) continue;
      const lab = document.createElement('div');
      lab.className = 'place-label';
      lab.textContent = d.approximate ? `${d.name} (approx.)` : d.name.replace(/^DEMO /, '');
      lab.title = d.name;
      add(new maplibregl.Marker({ element: lab, anchor: 'top', offset: [0, Math.max(r, 6) + (showLabels ? 24 : 12)] }).setLngLat([d.lng, d.lat]));
    }
  }, [ready, trace, display, selectedWp, highlightWaypointId, zoomTick, areaPts, analysis, mode]);

  // fly to the selected step
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedStepId) return;
    const s = trace.steps.find((x) => x.id === selectedStepId);
    const d = s && display.get(s.locationId);
    if (!d) return;
    const zoom = Math.max(map.getZoom(), d.lat > 30 ? 10.5 : 7.6);
    const wide = (el.current?.clientWidth ?? 0) > 700;
    map.flyTo({ center: [d.lng, d.lat], zoom, offset: wide ? [-170, 40] : [0, 0], duration: reduceMotion() ? 0 : 900, essential: false });
  }, [ready, selectedStepId, trace, display]);

  const endpointPlace = p.endpoint?.locationId ? display.get(p.endpoint.locationId) : undefined;

  return (
    <>
      <div ref={el} className="map-canvas" aria-label="Interactive trace map" role="region" />
      <div className="map-toolbar">
        <button className="map-btn" onClick={() => fit(allPoints)} title="Show the whole recorded route">
          <Crosshair size={14} /> Fit route
        </button>
        {hasFar && (
          <>
            <button className="map-btn" onClick={fitDefault} title="Collection areas to Tema">
              <MapPinned size={14} /> Origin
            </button>
            <button className="map-btn" onClick={() => fit(farPoints, 11.5)} title="Destination area">
              <Globe2 size={14} /> Destination
            </button>
          </>
        )}
        <div className="map-menu-wrap">
          <button className={`map-btn ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} aria-expanded={menu} aria-haspopup="menu">
            <SlidersHorizontal size={14} /> View
          </button>
          {menu && (
            <div className="map-menu" role="menu">
              <div className="mm-label">Perspective</div>
              <div className="seg">
                <button className={!view3d ? 'on' : ''} onClick={() => p.setView3d(false)}>
                  Flat 2D
                </button>
                <button className={view3d ? 'on' : ''} onClick={() => p.setView3d(true)}>
                  Tilted 3D
                </button>
              </div>
              <div className="mm-label">Basemap</div>
              <div className="seg">
                <button className={basemap === 'online' ? 'on' : ''} onClick={() => p.setBasemap('online')}>
                  Online
                </button>
                <button className={basemap === 'offline' ? 'on' : ''} onClick={() => p.setBasemap('offline')}>
                  Offline
                </button>
              </div>
              {p.modeOptions && p.onModeChange && (
                <>
                  <div className="mm-label">Location detail</div>
                  {p.modeOptions.map((m) => (
                    <label key={m} className="mm-radio">
                      <input type="radio" name="map-mode" checked={mode === m} onChange={() => p.onModeChange!(m)} /> {MODE_LABEL[m]}
                    </label>
                  ))}
                </>
              )}
              <button
                className="btn btn-sm"
                style={{ marginTop: 8, width: '100%' }}
                onClick={() => {
                  setMenu(false);
                  fitDefault();
                }}
              >
                Reset view
              </button>
            </div>
          )}
        </div>
      </div>
      {p.endpoint && (
        <div className="map-endpoint" role="status">
          <span className="dot" />
          <span style={{ minWidth: 0 }}>
            <b>{p.endpoint.title}</b>
            {p.endpoint.detail && <span className="ep-detail">{p.endpoint.detail}</span>}
          </span>
          {endpointPlace && (
            <button className="ep-btn" onClick={() => fit([[endpointPlace.lng, endpointPlace.lat]], endpointPlace.lat > 30 ? 11 : 9)}>
              Show
            </button>
          )}
        </div>
      )}
      <div className="map-note">Dashed arcs show the recorded order of custody between places — not roads or GPS tracks.</div>
    </>
  );
}
