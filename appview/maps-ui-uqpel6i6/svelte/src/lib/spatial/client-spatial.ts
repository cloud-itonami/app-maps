import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { forward as toMGRS } from 'mgrs';

export function computeH3CellId(lat: number, lng: number, resolution: number): string {
  return latLngToCell(lat, lng, resolution);
}

export function computeH3CellBoundary(h3Index: string): [number, number][] {
  return cellToBoundary(h3Index);
}

export function computeH3GridDisk(h3Index: string, k: number): string[] {
  return gridDisk(h3Index, k);
}

export function computeMGRS(lat: number, lng: number, precision: number = 5): string {
  try {
    return toMGRS([lng, lat], precision);
  } catch {
    return '';
  }
}

/**
 * Simplified S2 Cell ID approximation using Hilbert curve mapping.
 * Produces a face/i,j representation (not the full uint64 token).
 */
export function computeS2CellId(lat: number, lng: number, level: number): string {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;

  // Convert to unit sphere (x, y, z)
  const x = Math.cos(latRad) * Math.cos(lngRad);
  const y = Math.cos(latRad) * Math.sin(lngRad);
  const z = Math.sin(latRad);

  // Determine S2 face (0-5) from largest absolute component
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);

  let face: number;
  let u: number;
  let v: number;

  if (ax >= ay && ax >= az) {
    face = x > 0 ? 0 : 3;
    u = y / ax;
    v = z / ax;
  } else if (ay >= ax && ay >= az) {
    face = y > 0 ? 1 : 4;
    u = x / ay;
    v = z / ay;
  } else {
    face = z > 0 ? 2 : 5;
    u = x / az;
    v = y / az;
  }

  // Quantize u,v to level-based grid
  const cells = 1 << level;
  const i = Math.min(cells - 1, Math.max(0, Math.floor(((u + 1) / 2) * cells)));
  const j = Math.min(cells - 1, Math.max(0, Math.floor(((v + 1) / 2) * cells)));

  return `${face}/${i.toString(16)},${j.toString(16)}`;
}

export interface H3HexDatum {
  h3Index: string;
  value: number;
}

export function buildH3HexData(
  centerLat: number,
  centerLng: number,
  resolution: number,
  ringSize: number
): H3HexDatum[] {
  const centerCell = latLngToCell(centerLat, centerLng, resolution);
  const cells = gridDisk(centerCell, ringSize);
  return cells.map((h3Index) => ({
    h3Index,
    value: h3Index === centerCell ? 1.0 : 0.2 + Math.random() * 0.3,
  }));
}

export function zoomToH3Resolution(zoom: number): number {
  if (zoom < 4) return 1;
  if (zoom < 6) return 2;
  if (zoom < 7) return 3;
  if (zoom < 8) return 4;
  if (zoom < 9) return 5;
  if (zoom < 10) return 6;
  if (zoom < 11) return 7;
  if (zoom < 13) return 8;
  if (zoom < 15) return 9;
  if (zoom < 17) return 10;
  return 11;
}

export function zoomToRingSize(zoom: number): number {
  return Math.min(30, Math.max(3, Math.floor(22 - zoom)));
}
