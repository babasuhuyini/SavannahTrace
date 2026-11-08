// Data model for the SFCL traceability prototype.
// Everything here is plain JSON so it can live in localStorage today and be
// replaced by SFCL's own backend/API later without changing the screens much.

export type ProductCode = 'OFN' | 'ODK' | 'OSB' | 'ORSB' | 'OFSB' | 'OFSB-FFL';

export const PRODUCTS: Record<ProductCode, string> = {
  OFN: 'Organic Shea Fresh Nuts',
  ODK: 'Organic Shea Dried Kernel',
  OSB: 'Organic Shea Crude Butter',
  ORSB: 'Organic Shea Refined Butter',
  OFSB: 'Organic Shea Filtered Butter',
  'OFSB-FFL': 'Organic Shea Filtered Butter (Fair for Life)',
};

export type RoleId = 'nut-fo' | 'butter-fo' | 'supply-chain' | 'commercial' | 'it-admin' | 'auditor';

export type LocationKind =
  | 'phc'
  | 'butter-centre'
  | 'warehouse'
  | 'port'
  | 'terminal'
  | 'destination-warehouse'
  | 'refiner'
  | 'filterer'
  | 'client';

/** A facility or waypoint. Coordinates are WGS84 decimal degrees. */
export interface Location {
  id: string;
  name: string;
  kind: LocationKind;
  lat: number;
  lng: number;
  /** Short, customer-safe description used on the public trace page. */
  publicLabel: string;
  country: string;
  /** Account code used as the prefix of batches made here (PHC only). */
  accountCode?: string;
  /** True for fictional demo records. */
  demo: boolean;
  /** Public places (ports) may be shown exactly to customers. */
  publicPlace?: boolean;
  notes?: string;
}

/** A certified forest-reserve collection area. Polygon is [lng, lat] pairs (GeoJSON order). */
export interface CollectionArea {
  id: string;
  /** Operational-area prefix + CA code, e.g. DX01-CA9101 */
  code: string;
  name: string;
  operationalArea: string;
  polygon: [number, number][];
  demo: boolean;
  /** Where the geometry came from. Real data should record source + version. */
  geometrySource: string;
}

export interface Collector {
  id: string;
  /** Collector code = CA code + collector number, e.g. DX01-CA9101-004 */
  code: string;
  name: string;
  collectionAreaId: string;
  demo: boolean;
}

export interface ProcessingGroup {
  id: string;
  centreId: string;
  name: string;
  members: number;
  demo: boolean;
}

export interface Route {
  id: string;
  name: string;
  stops: string[]; // location ids in order
  demo: boolean;
}

/** One lot/batch line on an event. */
export interface LotQty {
  lotId: string; // operational identifier supplied by an officer
  product: ProductCode;
  qty: number; // kg
}

export type EventType = 'commission' | 'ship' | 'receive' | 'issue' | 'transform' | 'ready' | 'deliver';
export type TransformKind = 'kernel' | 'butter' | 'aggregation' | 'refine' | 'filter';

interface BaseEvent {
  id: string; // internal id (generated, never shown as a business identifier)
  type: EventType;
  /** When the activity happened, ISO 8601 with explicit offset. */
  eventTime: string;
  /** When the system learned about it (UTC ISO). Never derived from eventTime. */
  recordedAt: string;
  recordedBy: RoleId;
  /** The user who recorded it (drives own-entry visibility, like RLS `actor_id = auth.uid()`). */
  actorId?: string;
  /** Where the activity happened (collection area or location id). */
  locationId: string;
  notes?: string;
  evidence?: string[];
  demo?: boolean;
  version: number;
  idempotencyKey?: string;
}

export interface CommissionEvent extends BaseEvent {
  type: 'commission';
  collectorId: string;
  purchaseDate: string; // YYYY-MM-DD
  pricePerKg?: number;
  currency: string;
  outputs: [LotQty];
}

export interface ExportDetails {
  containerNo?: string;
  vessel?: string;
  eta?: string; // YYYY-MM-DD
  clientName?: string;
  orderRef?: string;
}

export interface ShipEvent extends BaseEvent {
  type: 'ship';
  fromId: string;
  toId: string;
  items: LotQty[];
  shipmentRef?: string;
  exportDetails?: ExportDetails;
}

export interface ReceiveEvent extends BaseEvent {
  type: 'receive';
  shipEventId: string;
  fromId: string;
  items: LotQty[]; // quantities actually received
  outcome: 'accepted' | 'discrepancy';
  discrepancyNote?: string;
  discrepancyResolution?: { at: string; note: string };
}

export interface IssueEvent extends BaseEvent {
  type: 'issue';
  groupId: string;
  items: LotQty[];
}

export interface TransformEvent extends BaseEvent {
  type: 'transform';
  kind: TransformKind;
  groupId?: string;
  inputs: LotQty[];
  outputs: LotQty[];
  /** SFCL aggregation only. */
  sfclStage?: 'in-progress' | 'finalized';
}

export interface ReadyEvent extends BaseEvent {
  type: 'ready';
  items: LotQty[];
  handoffId: string;
}

export interface DeliverEvent extends BaseEvent {
  type: 'deliver';
  toId: string;
  items: LotQty[];
}

export type TraceEvent =
  | CommissionEvent
  | ShipEvent
  | ReceiveEvent
  | IssueEvent
  | TransformEvent
  | ReadyEvent
  | DeliverEvent;

export type Disclosure = 'full' | 'generalized' | 'masked';

export interface Handoff {
  id: string;
  lotId: string;
  qty: number;
  product: ProductCode;
  locationId: string;
  readyEventId: string;
  token: string;
  clientName: string;
  orderRef: string;
  createdAt: string;
  status: 'new' | 'acknowledged';
  acknowledgedAt?: string;
  invoiceRef?: string;
  invoiceStatus: 'not-started' | 'in-preparation' | 'recorded-demo';
  disclosure: Disclosure;
  demo: boolean;
}

export interface DemoDocument {
  id: string;
  title: string;
  kind: 'certificate' | 'analysis' | 'shipping' | 'receipt';
  /** Lot ids this applies to; '*' for every trace. */
  appliesTo: string[] | '*';
  public: boolean;
  demo: true;
}

export interface AuditEntry {
  id: string;
  at: string; // recorded UTC
  actor: RoleId | 'system';
  actorId?: string;
  action:
    | 'event.recorded'
    | 'event.corrected'
    | 'event.duplicate-blocked'
    | 'discrepancy.resolved'
    | 'sfcl.finalized'
    | 'master.updated'
    | 'handoff.created'
    | 'handoff.updated'
    | 'user.invited'
    | 'user.invitation-resent'
    | 'user.invitation-revoked'
    | 'user.activated'
    | 'user.suspended'
    | 'user.reactivated'
    | 'user.access-changed'
    | 'user.recovery-sent'
    | 'demo.reset';
  targetId?: string;
  summary: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  demo?: boolean;
}

/** An application user. In live mode this comes from Supabase (profiles + role + location tables). */
export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: RoleId;
  /** Assigned locations (collection areas, centres, warehouse, ports…). */
  locationIds: string[];
  /** Commercial only: client accounts this user may see. */
  clientNames: string[];
  status: 'active' | 'suspended';
  lastSignInAt?: string;
  demo: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  name: string;
  role: RoleId;
  locationIds: string[];
  clientNames: string[];
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  invitedBy: string;
  acceptedAt?: string;
  demo: boolean;
}

export interface DemoDB {
  schemaVersion: number;
  seededAt: string;
  locations: Location[];
  collectionAreas: CollectionArea[];
  collectors: Collector[];
  groups: ProcessingGroup[];
  routes: Route[];
  events: TraceEvent[];
  handoffs: Handoff[];
  documents: DemoDocument[];
  audit: AuditEntry[];
  users: AppUser[];
  invitations: Invitation[];
  /** Live mode only: lots whose creating event is outside this user's visibility (opening stock only). */
  externalLots?: import('../backend/snapshot').ExternalLot[];
}
