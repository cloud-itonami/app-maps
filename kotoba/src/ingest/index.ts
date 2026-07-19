/**
 * Programmatic API for Phase 3 Tier B ingest surfaces.
 *
 *   - registerVisionResult     — Murakumo Vision analysis output
 *   - registerSatelliteScene   — STAC scene metadata
 *   - registerMapralyPoi       — Mapraly POI / route
 *   - registerWebCrawlGeoEntity — web crawl extracted entity
 *
 * Per ADR-2605231400 (Phase 3 Tier B) + ADR-2605241500 (DataLad + IPFS
 * dataset substrate). Each helper writes ONLY metadata to PDS — the
 * actual data payload (image, COG asset, POI photo, WET record) lives
 * in a DataLad subdataset pinned to IPFS, referenced from the record
 * via `payloadKind` + `datasetPinUri` (or raw `payloadCid` when no
 * DataLad superdataset is used).
 *
 * Operator workflow (per ADR-2605241500):
 *   1. Add the payload file under the relevant DataLad subdataset (e.g.,
 *      `90-docs/baien/datasets/vision-2026Q2/qwen3-vl/r0001.json`).
 *   2. `datalad save -m "..." && datalad publish` or run `e7m-dataset
 *      publish-ipfs` to mirror to IPFS via the sidecar pinner.
 *   3. The sidecar emits an `com.etzhayyim.substrate.datasetPin` record
 *      to PDS, returning its AT URI.
 *   4. Caller passes that URI as `datasetPinUri` to the helper here;
 *      the maps record then carries the cross-reference.
 *
 * L0 (plain write) + L1 (witnessed) both supported via `opts.witness`,
 * same shape as Geography / Transport / Digital Twin helpers.
 */

import { kotoba-datomic } from "@etzhayyim/sdk";

type FleetCell = kotoba-datomic.FleetCell;
type QuorumState = kotoba-datomic.QuorumState;
type WitnessTransport = kotoba-datomic.WitnessTransport;
type MembraneRule = kotoba-datomic.MembraneRule;
const writeWithWitnesses = kotoba-datomic.writeWithWitnesses;

import {
  isValidConfidence01,
  isValidIngestId,
  isValidPctBps,
  validateSatellitePayloadRef,
  validateVisionPayloadRef,
  type MapralyPoiRecord,
  type SatelliteSceneRecord,
  type VisionResultRecord,
  type WebCrawlGeoEntityRecord,
  type MapralyPhotoPayloadKind,
  type SatelliteScenePayloadKind,
  type SatelliteSensor,
  type VisionAnalysisKind,
  type VisionEntity,
  type VisionPayloadKind,
  type WebCrawlEntityType,
  type WetPayloadKind,
} from "./types.js";

export type {
  MapralyPhotoPayloadKind,
  MapralyPoiRecord,
  SatelliteScenePayloadKind,
  SatelliteSceneRecord,
  SatelliteSensor,
  VisionAnalysisKind,
  VisionEntity,
  VisionPayloadKind,
  VisionResultRecord,
  WebCrawlEntityType,
  WebCrawlGeoEntityRecord,
  WetPayloadKind,
} from "./types.js";
export {
  isValidConfidence01,
  isValidIngestId,
  isValidPctBps,
  validateSatellitePayloadRef,
  validateVisionPayloadRef,
} from "./types.js";

const COLLECTION_VISION = "com.etzhayyim.maps.visionResult";
const COLLECTION_SATELLITE = "com.etzhayyim.maps.satelliteScene";
const COLLECTION_MAPRALY = "com.etzhayyim.maps.mapralyPoi";
const COLLECTION_WEB_CRAWL = "com.etzhayyim.maps.webCrawlGeoEntity";

// ─── shared client + opts ───────────────────────────────────────────

export interface IngestClient {
  write(opts: { collection: string; record: Record<string, unknown>; rkey?: string }): Promise<{ uri: string; cid: string }>;
}

export interface IngestWitnessOpts {
  fleet: readonly FleetCell[];
  transport: WitnessTransport;
  rule: MembraneRule;
  timeoutMs?: number;
}

export interface IngestOpts {
  client: IngestClient;
  witness?: IngestWitnessOpts;
}

export interface IngestResult {
  uri: string;
  cid: string;
  witnessState?: QuorumState;
}

async function _write(
  collection: string,
  record: Record<string, unknown>,
  rkey: string | undefined,
  opts: IngestOpts,
): Promise<IngestResult> {
  if (opts.witness) {
    const r = await writeWithWitnesses({
      client: opts.client,
      writeOpts: { collection, record, rkey },
      fleet: opts.witness.fleet,
      rule: opts.witness.rule,
      transport: opts.witness.transport,
      timeoutMs: opts.witness.timeoutMs,
    });
    return { uri: r.uri, cid: r.cid, witnessState: r.state };
  }
  const receipt = await opts.client.write({ collection, record, rkey });
  return { uri: receipt.uri, cid: receipt.cid };
}

// ─── registerVisionResult ───────────────────────────────────────────

export interface RegisterVisionResultInput {
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
  analyzedAt?: string;
  sourceDid?: string;
}

export async function registerVisionResult(
  input: RegisterVisionResultInput,
  opts: IngestOpts,
): Promise<IngestResult> {
  if (!isValidIngestId(input.resultId)) {
    throw new Error(`registerVisionResult: invalid resultId: ${input.resultId}`);
  }
  if (!isValidConfidence01(input.confidence)) {
    throw new Error(`registerVisionResult: confidence must be in [0, 1]`);
  }
  const refErr = validateVisionPayloadRef(input);
  if (refErr) throw new Error(`registerVisionResult: ${refErr}`);
  const record: VisionResultRecord = {
    v: 1,
    resultId: input.resultId,
    subjectUri: input.subjectUri,
    analysisKind: input.analysisKind,
    visionModel: input.visionModel,
    entities: input.entities,
    confidence: input.confidence,
    payloadKind: input.payloadKind,
    datasetPinUri: input.datasetPinUri,
    datasetPath: input.datasetPath,
    payloadCid: input.payloadCid,
    externalUrl: input.externalUrl,
    inlineJson: input.inlineJson,
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
    sourceDid: input.sourceDid,
  };
  return _write(COLLECTION_VISION, record as unknown as Record<string, unknown>, input.resultId, opts);
}

// ─── registerSatelliteScene ─────────────────────────────────────────

export interface RegisterSatelliteSceneInput {
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
  /** JSON-encoded {asset_key: ipfs_cid}. */
  assetCids?: string;
  registeredAt?: string;
  sourceDid?: string;
}

export async function registerSatelliteScene(
  input: RegisterSatelliteSceneInput,
  opts: IngestOpts,
): Promise<IngestResult> {
  if (!input.sceneId || input.sceneId.length > 128) {
    throw new Error(`registerSatelliteScene: invalid sceneId`);
  }
  if (!isValidPctBps(input.cloudCoverPctBps)) {
    throw new Error(`registerSatelliteScene: cloudCoverPctBps must be integer in [0, 10000]`);
  }
  const refErr = validateSatellitePayloadRef(input);
  if (refErr) throw new Error(`registerSatelliteScene: ${refErr}`);
  const record: SatelliteSceneRecord = {
    v: 1,
    sceneId: input.sceneId,
    sensor: input.sensor,
    stacCollectionId: input.stacCollectionId,
    bboxWestE7: input.bboxWestE7,
    bboxSouthE7: input.bboxSouthE7,
    bboxEastE7: input.bboxEastE7,
    bboxNorthE7: input.bboxNorthE7,
    acquiredAt: input.acquiredAt,
    cloudCoverPctBps: input.cloudCoverPctBps,
    sunElevationDegBps: input.sunElevationDegBps,
    payloadKind: input.payloadKind,
    stacItemUrl: input.stacItemUrl,
    datasetPinUri: input.datasetPinUri,
    assetCids: input.assetCids,
    registeredAt: input.registeredAt ?? new Date().toISOString(),
    sourceDid: input.sourceDid,
  };
  // sceneId can contain underscores/uppercase per provider conventions
  // so we don't apply isValidIngestId here. PDS rkey validation accepts
  // free-form per `key: "literal:{sceneId}"`.
  return _write(COLLECTION_SATELLITE, record as unknown as Record<string, unknown>, input.sceneId, opts);
}

// ─── registerMapralyPoi ─────────────────────────────────────────────

export interface RegisterMapralyPoiInput {
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
  ingestedAt?: string;
  sourceDid?: string;
}

export async function registerMapralyPoi(
  input: RegisterMapralyPoiInput,
  opts: IngestOpts,
): Promise<IngestResult> {
  if (!isValidIngestId(input.poiId)) {
    throw new Error(`registerMapralyPoi: invalid poiId: ${input.poiId}`);
  }
  if (input.rating !== undefined && (input.rating < 0 || input.rating > 5)) {
    throw new Error(`registerMapralyPoi: rating must be in [0, 5]`);
  }
  if (input.photoPayloadKind) {
    if (input.photoPayloadKind === "datalad-pin" && !input.datasetPinUri) {
      throw new Error(`registerMapralyPoi: photoPayloadKind=datalad-pin requires datasetPinUri`);
    }
    if (input.photoPayloadKind === "ipfs" && (!input.photoCids || input.photoCids.length === 0)) {
      throw new Error(`registerMapralyPoi: photoPayloadKind=ipfs requires non-empty photoCids`);
    }
    if (input.photoPayloadKind === "external-url" && (!input.photoUrls || input.photoUrls.length === 0)) {
      throw new Error(`registerMapralyPoi: photoPayloadKind=external-url requires non-empty photoUrls`);
    }
  }
  const record: MapralyPoiRecord = {
    v: 1,
    poiId: input.poiId,
    name: input.name,
    category: input.category,
    lng: input.lng,
    lat: input.lat,
    address: input.address,
    rating: input.rating,
    batchId: input.batchId,
    photoPayloadKind: input.photoPayloadKind,
    datasetPinUri: input.datasetPinUri,
    photoCids: input.photoCids,
    photoUrls: input.photoUrls,
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
    sourceDid: input.sourceDid,
  };
  return _write(COLLECTION_MAPRALY, record as unknown as Record<string, unknown>, input.poiId, opts);
}

// ─── registerWebCrawlGeoEntity ──────────────────────────────────────

export interface RegisterWebCrawlGeoEntityInput {
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
  extractedAt?: string;
  sourceDid?: string;
}

export async function registerWebCrawlGeoEntity(
  input: RegisterWebCrawlGeoEntityInput,
  opts: IngestOpts,
): Promise<IngestResult> {
  if (!isValidIngestId(input.entityId)) {
    throw new Error(`registerWebCrawlGeoEntity: invalid entityId: ${input.entityId}`);
  }
  if (!isValidConfidence01(input.nerConfidence)) {
    throw new Error(`registerWebCrawlGeoEntity: nerConfidence must be in [0, 1]`);
  }
  if (input.wetPayloadKind) {
    switch (input.wetPayloadKind) {
      case "datalad-pin":
        if (!input.datasetPinUri) throw new Error(`wetPayloadKind=datalad-pin requires datasetPinUri`);
        break;
      case "ipfs":
        if (!input.wetRecordCid) throw new Error(`wetPayloadKind=ipfs requires wetRecordCid`);
        break;
      case "cross-actor":
        if (!input.wetRecordUri) throw new Error(`wetPayloadKind=cross-actor requires wetRecordUri`);
        break;
      case "inline":
        if (!input.inlineSnippet) throw new Error(`wetPayloadKind=inline requires inlineSnippet`);
        if (input.inlineSnippet.length > 4096) throw new Error(`inlineSnippet exceeds 4KB lexicon cap`);
        break;
    }
  }
  const record: WebCrawlGeoEntityRecord = {
    v: 1,
    entityId: input.entityId,
    name: input.name,
    entityType: input.entityType,
    domain: input.domain,
    lng: input.lng,
    lat: input.lat,
    linkedFeatureUri: input.linkedFeatureUri,
    nerConfidence: input.nerConfidence,
    wetPayloadKind: input.wetPayloadKind,
    datasetPinUri: input.datasetPinUri,
    wetRecordCid: input.wetRecordCid,
    wetRecordUri: input.wetRecordUri,
    inlineSnippet: input.inlineSnippet,
    crawledAt: input.crawledAt,
    extractedAt: input.extractedAt ?? new Date().toISOString(),
    sourceDid: input.sourceDid,
  };
  return _write(COLLECTION_WEB_CRAWL, record as unknown as Record<string, unknown>, input.entityId, opts);
}
