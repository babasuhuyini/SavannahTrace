import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { CollectionArea, Location } from '../data/types';
import { ONLINE_STYLE, offlineStyle } from './TraceMap';

/** Simple map for viewing/editing demo master-data geometry. Click to pick a point. */
export function GeoMap({
  locations,
  areas,
  draftPoint,
  draftPolygon,
  onPick,
  onSelectLocation,
  height = 380,
  focus,
}: {
  locations: Location[];
  areas: CollectionArea[];
  draftPoint?: [number, number] | null; // [lng, lat]
  draftPolygon?: [number, number][];
  onPick?: (lat: number, lng: number) => void;
  onSelectLocation?: (id: string) => void;
  height?: number;
  focus?: 'ghana' | 'nl' | 'all';
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);
  const cb = useRef({ onPick, onSelectLocation });
  cb.current = { onPick, onSelectLocation };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const style = offline ? await offlineStyle() : ONLINE_STYLE;
      if (cancelled || !el.current) return;
      const m = new maplibregl.Map({ container: el.current, style, center: [-1.1, 9.9], zoom: 6.2, attributionControl: { compact: true, customAttribution: 'Demo geometry: fictional' } });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      let loaded = false;
      const t = setTimeout(() => !loaded && !offline && setOffline(true), 9000);
      m.on('error', () => !loaded && !offline && setOffline(true));
      m.on('load', () => {
        loaded = true;
        clearTimeout(t);
        m.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', paint: { 'fill-color': '#2d6a4a', 'fill-opacity': 0.18 } });
        m.addLayer({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': '#1c4532', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
        m.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#c4851a', 'fill-opacity': 0.25 } });
        m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#c4851a', 'line-width': 2.5 } });
        m.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#c4851a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        setReady(true);
      });
      m.on('click', (e) => cb.current.onPick?.(+e.lngLat.lat.toFixed(5), +e.lngLat.lng.toFixed(5)));
    })();
    return () => {
      cancelled = true;
      markers.current.forEach((x) => x.remove());
      map.current?.remove();
      map.current = null;
      setReady(false);
    };
  }, [offline]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('areas') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: areas.map((a) => ({ type: 'Feature', properties: { name: a.name }, geometry: { type: 'Polygon', coordinates: [a.polygon] } })),
    });
    const draftFeats: GeoJSON.Feature[] = [];
    if (draftPolygon && draftPolygon.length) {
      const ring = draftPolygon.length >= 3 ? [...draftPolygon, draftPolygon[0]] : draftPolygon;
      draftFeats.push({ type: 'Feature', properties: {}, geometry: draftPolygon.length >= 3 ? { type: 'Polygon', coordinates: [ring] } : { type: 'LineString', coordinates: ring } });
      draftPolygon.forEach((p) => draftFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    }
    if (draftPoint) draftFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: draftPoint } });
    (m.getSource('draft') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: draftFeats });

    markers.current.forEach((x) => x.remove());
    markers.current = [];
    for (const l of locations) {
      const d = document.createElement('button');
      d.className = 'place-label';
      d.style.pointerEvents = 'auto';
      d.style.cursor = onSelectLocation ? 'pointer' : 'default';
      d.textContent = l.name.replace('DEMO ', '');
      d.title = `${l.name} (${l.lat}, ${l.lng})`;
      d.onclick = (ev) => {
        ev.stopPropagation();
        cb.current.onSelectLocation?.(l.id);
      };
      const dot = document.createElement('div');
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#1c4532;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)';
      markers.current.push(new maplibregl.Marker({ element: dot }).setLngLat([l.lng, l.lat]).addTo(m));
      markers.current.push(new maplibregl.Marker({ element: d, anchor: 'top', offset: [0, 7] }).setLngLat([l.lng, l.lat]).addTo(m));
    }
  }, [ready, locations, areas, draftPoint, draftPolygon, onSelectLocation]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const pts: [number, number][] = [];
    if (draftPoint) pts.push(draftPoint);
    if (draftPolygon?.length) pts.push(...draftPolygon);
    if (!pts.length) {
      const all = [...locations.map((l) => [l.lng, l.lat] as [number, number]), ...areas.flatMap((a) => a.polygon)];
      const sel = focus === 'nl' ? all.filter((p) => p[1] > 30) : focus === 'all' ? all : all.filter((p) => p[1] < 30 && p[1] > 7);
      pts.push(...sel);
    }
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    m.fitBounds(b, { padding: 50, maxZoom: 9, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focus]);

  return (
    <div className="map-shell">
      <div ref={el} style={{ height }} />
      {offline && <div className="map-note" style={{ bottom: 10 }}>Offline basemap (Natural Earth)</div>}
    </div>
  );
}
