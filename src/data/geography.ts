// ─────────────────────────────────────────────────────────────────────────────
//  DEMO GEOGRAPHY — FICTIONAL. REPLACE WITH APPROVED SFCL MASTER DATA.
//
//  Every facility, collection area and coordinate below is invented for the
//  prototype. Facilities have fictional names and were deliberately placed away
//  from known SFCL operating towns. Collection areas are regular hexagons so
//  nobody mistakes them for surveyed boundaries.
//
//  To use real data later, replace `DEMO_LOCATIONS` and `DEMO_COLLECTION_AREAS`
//  (or load them from SFCL's backend) keeping the same shape:
//    Location        → { id, name, kind, lat, lng, publicLabel, country, ... }
//    CollectionArea  → { id, code, name, polygon: [lng, lat][] , ... }
//  Coordinates are WGS84 decimal degrees. Polygons use GeoJSON [lng, lat] order.
//  The only public places are Tema Port and the Amsterdam port area; the
//  Amsterdam facilities themselves are fictional.
// ─────────────────────────────────────────────────────────────────────────────

import type { CollectionArea, Collector, Location, ProcessingGroup, Route } from './types';

/** Regular hexagon around a centre (radius in degrees of latitude). */
function hexagon(lat: number, lng: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  const kx = 1 / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push([+(lng + r * kx * Math.cos(a)).toFixed(5), +(lat + r * Math.sin(a)).toFixed(5)]);
  }
  pts.push(pts[0]);
  return pts;
}

export const DEMO_COLLECTION_AREAS: CollectionArea[] = [
  {
    id: 'ca-kulaa',
    code: 'DX01-CA9101',
    name: 'DEMO Kulaa Forest Reserve',
    operationalArea: 'DX01 · Demo North-West',
    polygon: hexagon(10.55, -1.65, 0.12),
    demo: true,
    geometrySource: 'Fictional hexagon (prototype only)',
  },
  {
    id: 'ca-sabon',
    code: 'DX02-CA9204',
    name: 'DEMO Sabon Forest Reserve',
    operationalArea: 'DX02 · Demo West',
    polygon: hexagon(9.95, -2.05, 0.11),
    demo: true,
    geometrySource: 'Fictional hexagon (prototype only)',
  },
  {
    id: 'ca-tingbaa',
    code: 'DX03-CA9307',
    name: 'DEMO Tingbaa Forest Reserve',
    operationalArea: 'DX03 · Demo North-East',
    polygon: hexagon(10.45, -0.4, 0.12),
    demo: true,
    geometrySource: 'Fictional hexagon (prototype only)',
  },
];

export const DEMO_LOCATIONS: Location[] = [
  {
    id: 'phc-nayiri',
    name: 'DEMO Nayiri Post Harvest Centre',
    kind: 'phc',
    lat: 10.15,
    lng: -1.25,
    publicLabel: 'Post-harvest centre, northern Ghana',
    country: 'Ghana',
    accountCode: 'DX01-CA9150',
    demo: true,
  },
  {
    id: 'bc-tamba',
    name: 'DEMO Tamba Butter Centre',
    kind: 'butter-centre',
    lat: 9.7,
    lng: -1.62,
    publicLabel: 'Shea butter processing centre, northern Ghana',
    country: 'Ghana',
    demo: true,
  },
  {
    id: 'bc-kalbe',
    name: 'DEMO Kalbe Butter Centre',
    kind: 'butter-centre',
    lat: 9.95,
    lng: -0.75,
    publicLabel: 'Shea butter processing centre, northern Ghana',
    country: 'Ghana',
    demo: true,
  },
  {
    id: 'wh-central',
    name: 'DEMO Savanna Central Warehouse',
    kind: 'warehouse',
    lat: 9.05,
    lng: -0.45,
    publicLabel: 'Consolidation warehouse, northern Ghana',
    country: 'Ghana',
    demo: true,
  },
  {
    id: 'port-tema',
    name: 'Tema Port',
    kind: 'port',
    lat: 5.6372,
    lng: 0.0119,
    publicLabel: 'Tema Port, Ghana',
    country: 'Ghana',
    demo: true,
    publicPlace: true,
    notes: 'Public port. Approximate point for the demo.',
  },
  {
    id: 'nl-terminal',
    name: 'DEMO Amsterdam Bulk Liquid Terminal',
    kind: 'terminal',
    lat: 52.415,
    lng: 4.79,
    publicLabel: 'Port of Amsterdam, Netherlands',
    country: 'Netherlands',
    demo: true,
    publicPlace: true,
    notes: 'Fictional terminal name in the public Amsterdam port area.',
  },
  {
    id: 'nl-zaan',
    name: 'DEMO Zaan Refining B.V.',
    kind: 'refiner',
    lat: 52.468,
    lng: 4.842,
    publicLabel: 'Refinery, Amsterdam area',
    country: 'Netherlands',
    demo: true,
  },
  {
    id: 'nl-clearfilter',
    name: 'DEMO Clearwater Filtration',
    kind: 'filterer',
    lat: 52.33,
    lng: 4.86,
    publicLabel: 'Filtration facility, Amsterdam area',
    country: 'Netherlands',
    demo: true,
  },
  {
    id: 'client-lumiere',
    name: 'DEMO Lumière Naturals B.V. (client site)',
    kind: 'client',
    lat: 51.92,
    lng: 4.48,
    publicLabel: 'Customer site, Netherlands',
    country: 'Netherlands',
    demo: true,
  },
];

const C = (ca: string, n: string, name: string, caId: string): Collector => ({
  id: `col-${ca}-${n}`,
  code: `${ca}-${n}`,
  name,
  collectionAreaId: caId,
  demo: true,
});

// Fictional collectors. Names are invented for the prototype.
export const DEMO_COLLECTORS: Collector[] = [
  C('DX01-CA9101', '001', 'Adisa Kpembiri', 'ca-kulaa'),
  C('DX01-CA9101', '002', 'Fuseina Dazaali', 'ca-kulaa'),
  C('DX01-CA9101', '003', 'Mariama Tongbo', 'ca-kulaa'),
  C('DX01-CA9101', '004', 'Hawa Nayiri', 'ca-kulaa'),
  C('DX01-CA9101', '005', 'Salamatu Bawuni', 'ca-kulaa'),
  C('DX01-CA9101', '006', 'Rahinatu Gbengu', 'ca-kulaa'),
  C('DX02-CA9204', '011', 'Zenabu Kalaa', 'ca-sabon'),
  C('DX02-CA9204', '012', 'Ayishetu Dombo', 'ca-sabon'),
  C('DX02-CA9204', '013', 'Memuna Tiyumba', 'ca-sabon'),
  C('DX02-CA9204', '014', 'Abiba Nantogma', 'ca-sabon'),
  C('DX02-CA9204', '015', 'Fati Bugri', 'ca-sabon'),
  C('DX02-CA9204', '016', 'Lariba Zakpaa', 'ca-sabon'),
  C('DX03-CA9307', '021', 'Asana Gbanzaba', 'ca-tingbaa'),
  C('DX03-CA9307', '022', 'Kande Wumbei', 'ca-tingbaa'),
  C('DX03-CA9307', '023', 'Sanatu Mbayu', 'ca-tingbaa'),
  C('DX03-CA9307', '024', 'Hamdia Tampuli', 'ca-tingbaa'),
  C('DX03-CA9307', '025', 'Barikisu Nyoo', 'ca-tingbaa'),
  C('DX03-CA9307', '026', 'Ramatu Kunkon', 'ca-tingbaa'),
];

export const DEMO_GROUPS: ProcessingGroup[] = [
  { id: 'grp-tamba-a', centreId: 'bc-tamba', name: 'Group A', members: 14, demo: true },
  { id: 'grp-tamba-b', centreId: 'bc-tamba', name: 'Group B', members: 11, demo: true },
  { id: 'grp-kalbe-a', centreId: 'bc-kalbe', name: 'Group A', members: 16, demo: true },
  { id: 'grp-kalbe-c', centreId: 'bc-kalbe', name: 'Group C', members: 9, demo: true },
];

export const DEMO_ROUTES: Route[] = [
  {
    id: 'route-ams-refine',
    name: 'Export via Tema → Amsterdam → refiner',
    stops: ['wh-central', 'port-tema', 'nl-terminal', 'nl-zaan'],
    demo: true,
  },
  {
    id: 'route-ams-filter',
    name: 'Export via Tema → Amsterdam → filtration',
    stops: ['wh-central', 'port-tema', 'nl-terminal', 'nl-clearfilter'],
    demo: true,
  },
];
