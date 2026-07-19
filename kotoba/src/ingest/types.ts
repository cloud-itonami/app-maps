/**
 * Mirrors the 4 Phase 3 Tier B ingest lexicons:
 *   - com.etzhayyim.maps.visionResult
 *   - com.etzhayyim.maps.satelliteScene
 *   - com.etzhayyim.maps.mapralyPoi
 *   - com.etzhayyim.maps.webCrawlGeoEntity
 *
 * All four follow the same payloadRef pattern from ADR-2605241500:
 * record holds metadata + a discriminated reference to where the actual
 * payload bytes live (DataLad-pinned, raw IPFS, external URL, or inline).
 */

// ─── shared payload discriminator ────────────────────────────────────

export type VisionPayloadKind = "datalad-pin" | "ipfs" | "inline" | "external-url";
export type SatelliteScenePayloadKind = "stac-url" | "datalad-pin" | "ipfs" | "external-url";
export type MapralyPhotoPayloadKind = "datalad-pin" | "ipfs" | "external-url";
export type WetPayloadKind = "datalad-pin" | "ipfs" | "cross-actor" | "inline";

// ─── visionResult ────────────────────────────────────────────────────

export type VisionAnalysisKind =
  | "classification"
  | "object-detection"
  | "change-detection"
  | "ocr"
  | "ner"
  | "caption"
  | "feature-extraction"
  | "custom";

export interface VisionEntity {
  label: string;
  confidence?: number;
  bbox?: string;
}

export interface VisionResultRecord {
  v: 1;
  resultId: string;
  subjectUri?: string;
  analysisKind: VisionAnalysisKind;
  visionModel: string;
  entities?: VisionEntity[];
  confidence?: number;
  payloadKind: VisionPayloadKind;
  datasetPinUri?: string;
  datasetPath?: string;
  payloadCid?: string;
  externalUrl?: string;
  inlineJson?: string;
  analyzedAt: string;
  sourceDid?: string;
  supersededByUri?: string;
}

// ─── satelliteScene ──────────────────────────────────────────────────

export type SatelliteSensor =
  | "sentinel-2"
  | "landsat-8"
  | "landsat-9"
  | "sentinel-1"
  | "hls"
  | "copernicus-dem"
  | "naip"
  | "other";

export interface SatelliteSceneRecord {
  v: 1;
  sceneId: string;
  sensor: SatelliteSensor;
  stacCollectionId?: string;
  bboxWestE7: number;
  bboxSouthE7: number;
  bboxEastE7: number;
  bboxNorthE7: number;
  acquiredAt: string;
  cloudCoverPctBps?: number;
  sunElevationDegBps?: number;
  payloadKind: SatelliteScenePayloadKind;
  stacItemUrl?: string;
  datasetPinUri?: string;
  /** JSON-encoded string {asset_key: ipfs_cid}. */
  assetCids?: string;
  registeredAt: string;
  sourceDid?: string;
  supersededBySceneId?: string;
}

// ─── mapralyPoi ──────────────────────────────────────────────────────

export interface MapralyPoiRecord {
  v: 1;
  poiId: string;
  name: string;
  category: string;
  lng: number;
  lat: number;
  address?: string;
  rating?: number;
  batchId?: string;
  photoPayloadKind?: MapralyPhotoPayloadKind;
  datasetPinUri?: string;
  photoCids?: ReadonlyArray<string>;
  photoUrls?: ReadonlyArray<string>;
  ingestedAt: string;
  sourceDid?: string;
  supersededByPoiId?: string;
}

// ─── webCrawlGeoEntity ───────────────────────────────────────────────

export type WebCrawlEntityType =
  | "place"
  | "organization"
  | "facility"
  | "event"
  | "geographic-feature"
  | "transport-node"
  | "other";

export interface WebCrawlGeoEntityRecord {
  v: 1;
  entityId: string;
  name: string;
  entityType: WebCrawlEntityType;
  domain: string;
  lng?: number;
  lat?: number;
  linkedFeatureUri?: string;
  nerConfidence?: number;
  wetPayloadKind?: WetPayloadKind;
  datasetPinUri?: string;
  wetRecordCid?: string;
  wetRecordUri?: string;
  inlineSnippet?: string;
  crawledAt: string;
  extractedAt: string;
  sourceDid?: string;
  supersededByEntityId?: string;
}

// ─── shared validators ──────────────────────────────────────────────

/** kebab-case id, 1-96 chars, no leading/trailing/double hyphens. */
export function isValidIngestId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 96;
}

export function isValidPctBps(n: number | undefined): boolean {
  if (n === undefined) return true;
  return Number.isInteger(n) && n >= 0 && n <= 10000;
}

export function isValidConfidence01(n: number | undefined): boolean {
  if (n === undefined) return true;
  return typeof n === "number" && n >= 0 && n <= 1;
}

/** Enforces the payloadKind discriminator — exactly one of the matching
 *  ref fields must be set. Returns null when valid, error string when not. */
export function validateVisionPayloadRef(r: Pick<VisionResultRecord,
  "payloadKind" | "datasetPinUri" | "datasetPath" | "payloadCid" | "externalUrl" | "inlineJson"
>): string | null {
  switch (r.payloadKind) {
    case "datalad-pin":
      if (!r.datasetPinUri) return "payloadKind=datalad-pin requires datasetPinUri";
      return null;
    case "ipfs":
      if (!r.payloadCid) return "payloadKind=ipfs requires payloadCid";
      return null;
    case "inline":
      if (!r.inlineJson) return "payloadKind=inline requires inlineJson";
      if (r.inlineJson.length > 16384) return "inlineJson exceeds 16KB cap";
      return null;
    case "external-url":
      if (!r.externalUrl) return "payloadKind=external-url requires externalUrl";
      return null;
    default:
      return `unknown payloadKind: ${r.payloadKind as string}`;
  }
}

export function validateSatellitePayloadRef(r: Pick<SatelliteSceneRecord,
  "payloadKind" | "stacItemUrl" | "datasetPinUri" | "assetCids"
>): string | null {
  switch (r.payloadKind) {
    case "stac-url":
      if (!r.stacItemUrl) return "payloadKind=stac-url requires stacItemUrl";
      return null;
    case "datalad-pin":
      if (!r.datasetPinUri) return "payloadKind=datalad-pin requires datasetPinUri";
      return null;
    case "ipfs":
      if (!r.assetCids) return "payloadKind=ipfs requires assetCids JSON";
      return null;
    case "external-url":
      if (!r.stacItemUrl) return "payloadKind=external-url requires stacItemUrl (or assetCids)";
      return null;
    default:
      return `unknown payloadKind: ${r.payloadKind as string}`;
  }
}
