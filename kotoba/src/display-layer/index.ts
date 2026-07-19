/**
 * Programmatic API for display layer.
 *
 *   import { defineDisplayLayer, listDisplayLayers, getDisplayLayer }
 *     from "@etzhayyim/maps-kotoba";
 *   // via the `displayLayer` namespace exported from the package root.
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import { isValidLayerId, isValidZoomRange, type DisplayLayerRecord } from "./types.js";

export type { DisplayLayerKind, DisplayLayerRecord } from "./types.js";
export { DISPLAY_LAYER_KINDS, isValidLayerId, isValidZoomRange } from "./types.js";

const COLLECTION = "com.etzhayyim.maps.displayLayer";

function defaultClient(): Etzhayyim {
  return new Etzhayyim({
    did: "did:web:maps.etzhayyim.com",
    pdsUrl: "https://pds.etzhayyim.com",
    ipfsGateway: "https://ipfs.etzhayyim.com",
    l2RpcUrl: "https://mainnet.base.org",
  });
}

export interface DefineDisplayLayerInput {
  layerId: string;
  name: string;
  description?: string;
  sourceDid: string;
  kind: DisplayLayerRecord["kind"];
  zoomMin?: number;
  zoomMax?: number;
  styleSpec?: Record<string, unknown>;
  labelCoordinatorDid?: string;
  supersedesLayerId?: string;
  /** Override the registered timestamp; defaults to `new Date().toISOString()`. */
  createdAt?: string;
}

/** Write a display layer. Idempotent: rkey == layerId. */
export async function defineDisplayLayer(
  input: DefineDisplayLayerInput,
  opts: { client?: Etzhayyim } = {},
): Promise<void> {
  if (!isValidLayerId(input.layerId)) {
    throw new Error(`invalid layerId: ${input.layerId}`);
  }
  if (!isValidZoomRange(input.zoomMin, input.zoomMax)) {
    throw new Error(`invalid zoom range: ${input.zoomMin}..${input.zoomMax}`);
  }
  const record: DisplayLayerRecord = {
    v: 1,
    layerId: input.layerId,
    name: input.name,
    description: input.description,
    sourceDid: input.sourceDid,
    kind: input.kind,
    zoomMin: input.zoomMin,
    zoomMax: input.zoomMax,
    styleSpec: input.styleSpec,
    labelCoordinatorDid: input.labelCoordinatorDid,
    supersedesLayerId: input.supersedesLayerId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const e = opts.client ?? defaultClient();
  await e.write({
    collection: COLLECTION,
    record: record as unknown as Record<string, unknown>,
    rkey: input.layerId,
  });
}

export interface ListDisplayLayersOpts {
  prefix?: string;
  limit?: number;
  client?: Etzhayyim;
}

export async function listDisplayLayers(
  opts: ListDisplayLayersOpts = {},
): Promise<DisplayLayerRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<DisplayLayerRecord>({
    collection: COLLECTION,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
  });
  return records.map((r) => r.value);
}

export async function getDisplayLayer(
  layerId: string,
  opts: { client?: Etzhayyim } = {},
): Promise<DisplayLayerRecord | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<DisplayLayerRecord>({
    collection: COLLECTION,
    rkey: layerId,
  });
  return records[0]?.value ?? null;
}
