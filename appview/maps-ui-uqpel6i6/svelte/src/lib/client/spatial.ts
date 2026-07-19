import {
  computeH3CellId,
  computeMGRS,
  computeS2CellId,
} from '$lib/spatial/client-spatial';

export interface SpatialIdentity {
  s2CellId: string;
  h3CellId: string;
  mgrsCoordinate: string;
}

export function getSpatialIdentity(
  lat: number,
  lng: number,
  h3Resolution: number = 9,
  s2Level: number = 12
): SpatialIdentity {
  return {
    s2CellId: computeS2CellId(lat, lng, s2Level),
    h3CellId: computeH3CellId(lat, lng, h3Resolution),
    mgrsCoordinate: computeMGRS(lat, lng),
  };
}
