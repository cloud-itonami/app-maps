/**
 * Mirrors com.etzhayyim.maps.displayLayer.
 * Source lexicon: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/displayLayer.json
 */

export type DisplayLayerKind =
  | "fill"
  | "line"
  | "circle"
  | "symbol"
  | "extrude"
  | "heatmap"
  | "raster"
  | "gsplat";

export const DISPLAY_LAYER_KINDS: readonly DisplayLayerKind[] = [
  "fill",
  "line",
  "circle",
  "symbol",
  "extrude",
  "heatmap",
  "raster",
  "gsplat",
];

export interface DisplayLayerRecord {
  v: 1;
  layerId: string;
  name: string;
  description?: string;
  sourceDid: string;
  kind: DisplayLayerKind;
  zoomMin?: number;
  zoomMax?: number;
  styleSpec?: Record<string, unknown>;
  labelCoordinatorDid?: string;
  createdAt: string;
  supersedesLayerId?: string;
}

/** Operator layerId — kebab-case, 1-96 chars, no leading/trailing/double hyphens. */
export function isValidLayerId(layerId: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(layerId) && layerId.length <= 96;
}

/** Validate zoom range — both endpoints in [0, 24], min ≤ max. */
export function isValidZoomRange(zoomMin?: number, zoomMax?: number): boolean {
  if (zoomMin === undefined && zoomMax === undefined) return true;
  const lo = zoomMin ?? 0;
  const hi = zoomMax ?? 24;
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
  return lo >= 0 && hi <= 24 && lo <= hi;
}
