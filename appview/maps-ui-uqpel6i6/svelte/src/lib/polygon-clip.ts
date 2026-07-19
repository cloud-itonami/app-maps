/**
 * Sutherland-Hodgman polygon clipping against an axis-aligned rectangle.
 *
 * Why this exists: KAMI / wgpu discards triangles whose clip-space vertices
 * all fall outside a driver-dependent "guard band" (~±32 NDC on many GPUs).
 * At zoom 12 with a Japan-sized polygon (12° × 10° = ~35K world-px), vertex
 * NDC reaches ±70, beyond the guard band → triangle dropped even though
 * the triangle spans the visible viewport. Standard fix used by every tile
 * renderer (Mapbox / Google Maps / OpenLayers) is to clip polygons to a
 * small world-space rect matching the viewport + margin, so no vertex is
 * far outside the frustum and guard-band logic is never triggered.
 *
 * The algorithm keeps vertices on the "inside" side of each of the 4
 * rectangle edges in turn, emitting intersection points when an edge is
 * crossed. Output is a (possibly empty) closed ring.
 */

export type Ring = [number, number][];
export type BBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

type Side = "left" | "right" | "bottom" | "top";

function isInside(p: [number, number], side: Side, b: BBox): boolean {
  switch (side) {
    case "left":   return p[0] >= b.minLng;
    case "right":  return p[0] <= b.maxLng;
    case "bottom": return p[1] >= b.minLat;
    case "top":    return p[1] <= b.maxLat;
  }
}

function intersect(
  a: [number, number], b: [number, number], side: Side, bb: BBox,
): [number, number] {
  const [ax, ay] = a;
  const [bx, by] = b;
  switch (side) {
    case "left": {
      const t = (bb.minLng - ax) / (bx - ax);
      return [bb.minLng, ay + t * (by - ay)];
    }
    case "right": {
      const t = (bb.maxLng - ax) / (bx - ax);
      return [bb.maxLng, ay + t * (by - ay)];
    }
    case "bottom": {
      const t = (bb.minLat - ay) / (by - ay);
      return [ax + t * (bx - ax), bb.minLat];
    }
    case "top": {
      const t = (bb.maxLat - ay) / (by - ay);
      return [ax + t * (bx - ax), bb.maxLat];
    }
  }
}

function clipAgainstSide(ring: Ring, side: Side, bb: BBox): Ring {
  if (ring.length === 0) return [];
  const out: Ring = [];
  let prev = ring[ring.length - 1];
  let prevIn = isInside(prev, side, bb);
  for (const curr of ring) {
    const currIn = isInside(curr, side, bb);
    if (currIn) {
      if (!prevIn) out.push(intersect(prev, curr, side, bb));
      out.push(curr);
    } else if (prevIn) {
      out.push(intersect(prev, curr, side, bb));
    }
    prev = curr;
    prevIn = currIn;
  }
  return out;
}

/**
 * Clip a single ring (outer boundary) against `bbox`. Returns at most one
 * ring — Sutherland-Hodgman doesn't split concave polygons into multiple
 * components even if the rect cuts them into pieces. For the map-basemap
 * use case that's fine: we just want to keep vertex coords small so the
 * GPU guard band doesn't discard us.
 */
export function clipRingToBBox(ring: Ring, bbox: BBox): Ring {
  let out = clipAgainstSide(ring, "left", bbox);
  out = clipAgainstSide(out, "right", bbox);
  out = clipAgainstSide(out, "bottom", bbox);
  out = clipAgainstSide(out, "top", bbox);
  return out;
}

/** Quick reject: skip rings whose bbox doesn't intersect the clip bbox. */
export function ringBBoxIntersects(ring: Ring, bbox: BBox): boolean {
  if (ring.length === 0) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return !(maxX < bbox.minLng || minX > bbox.maxLng || maxY < bbox.minLat || minY > bbox.maxLat);
}
