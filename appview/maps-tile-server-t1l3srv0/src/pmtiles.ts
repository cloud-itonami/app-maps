/**
 * Minimal PMTiles v3 reader — self-contained, no dependencies.
 *
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * Design goals:
 *   - Zero npm deps (no @protomaps/pmtiles) per platform's "kami engine で自前"
 *     directive.
 *   - Single R2 binding interface; all blob access via HTTP Range.
 *   - Absolute minimum needed to resolve (z,x,y) → tile bytes for MVT serving.
 *
 * Non-goals:
 *   - Writing / mutating PMTiles archives.
 *   - ETag / versioning (caller resolves via manifest.json).
 *
 * Layout (PMTiles v3, all integers little-endian):
 *   [0  ..128)   fixed 127-byte header (+1 pad)
 *   [root_off   ..+root_len)    root directory (serialized, possibly compressed)
 *   [json_off   ..+json_len)    JSON metadata
 *   [leaves_off ..+leaves_len)  leaf directories (optional, for large archives)
 *   [tile_off   ..+tile_len)    tile data
 *
 * Tile coords use Hilbert curve → tile_id mapping (spec §"tile_id").
 *
 * R2 binding contract:
 *   env.TILES.get(key, { range: { offset, length } }) → R2ObjectBody | null
 */

// ── Hilbert curve tile_id (spec §Tile IDs) ───────────────────────────────────

/**
 * Convert (z, x, y) to a PMTiles v3 tile_id using the Hilbert curve ordering.
 * Required by both directory search and direct offset resolution.
 */
export function zxyToTileId(z: number, x: number, y: number): bigint {
  if (z > 31) throw new Error(`pmtiles: z=${z} exceeds max 31`);
  // Accumulated tile count for all zooms < z.
  // acc = (4^z - 1) / 3 = sum_{i=0..z-1} 4^i
  let acc = 0n;
  for (let t = 0; t < z; t++) {
    acc += 1n << BigInt(2 * t);
  }
  // Hilbert distance within the 2^z × 2^z grid.
  let rx: number;
  let ry: number;
  let d = 0n;
  let tx = x;
  let ty = y;
  for (let s = (1 << z) >>> 1; s > 0; s >>>= 1) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += BigInt(s) * BigInt(s) * BigInt((3 * rx) ^ ry);
    // rotate quadrant
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const tmp = tx;
      tx = ty;
      ty = tmp;
    }
  }
  return acc + d;
}

// ── Header (127 bytes) ───────────────────────────────────────────────────────

export type Compression =
  | 'none'      // 0x01
  | 'gzip'      // 0x02
  | 'brotli'    // 0x03
  | 'zstd'      // 0x04
  | 'unknown';

function decodeCompression(b: number): Compression {
  switch (b) {
    case 0x01: return 'none';
    case 0x02: return 'gzip';
    case 0x03: return 'brotli';
    case 0x04: return 'zstd';
    default:   return 'unknown';
  }
}

export type TileType =
  | 'unknown'   // 0x00
  | 'mvt'       // 0x01 application/vnd.mapbox-vector-tile
  | 'png'       // 0x02
  | 'jpg'       // 0x03
  | 'webp'      // 0x04
  | 'avif';     // 0x05

function decodeTileType(b: number): TileType {
  switch (b) {
    case 0x01: return 'mvt';
    case 0x02: return 'png';
    case 0x03: return 'jpg';
    case 0x04: return 'webp';
    case 0x05: return 'avif';
    default:   return 'unknown';
  }
}

export interface PmtilesHeader {
  specVersion: number;
  rootDirOffset: bigint;
  rootDirLength: bigint;
  jsonMetadataOffset: bigint;
  jsonMetadataLength: bigint;
  leafDirsOffset: bigint;
  leafDirsLength: bigint;
  tileDataOffset: bigint;
  tileDataLength: bigint;
  addressedTilesCount: bigint;
  tileEntriesCount: bigint;
  tileContentsCount: bigint;
  clustered: boolean;
  internalCompression: Compression;
  tileCompression: Compression;
  tileType: TileType;
  minZoom: number;
  maxZoom: number;
  minLonE7: number;
  minLatE7: number;
  maxLonE7: number;
  maxLatE7: number;
  centerZoom: number;
  centerLonE7: number;
  centerLatE7: number;
}

const HEADER_BYTES = 127;
const MAGIC = 0x504d5469; // "PMTi"

export function parseHeader(buf: ArrayBuffer): PmtilesHeader {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`pmtiles: header too short (${buf.byteLength} < ${HEADER_BYTES})`);
  }
  const dv = new DataView(buf);
  // Magic "PMTi" (0x50 0x4d 0x54 0x69) in little-endian uint32 at offset 0.
  const m0 = dv.getUint8(0);
  const m1 = dv.getUint8(1);
  const m2 = dv.getUint8(2);
  const m3 = dv.getUint8(3);
  const magic = (m0 << 24) | (m1 << 16) | (m2 << 8) | m3;
  if (magic !== MAGIC) {
    throw new Error(`pmtiles: bad magic 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`);
  }
  const specVersion = dv.getUint8(7);
  if (specVersion !== 3) {
    throw new Error(`pmtiles: unsupported spec version ${specVersion}, expected 3`);
  }
  return {
    specVersion,
    rootDirOffset:        dv.getBigUint64(8,  true),
    rootDirLength:        dv.getBigUint64(16, true),
    jsonMetadataOffset:   dv.getBigUint64(24, true),
    jsonMetadataLength:   dv.getBigUint64(32, true),
    leafDirsOffset:       dv.getBigUint64(40, true),
    leafDirsLength:       dv.getBigUint64(48, true),
    tileDataOffset:       dv.getBigUint64(56, true),
    tileDataLength:       dv.getBigUint64(64, true),
    addressedTilesCount:  dv.getBigUint64(72, true),
    tileEntriesCount:     dv.getBigUint64(80, true),
    tileContentsCount:    dv.getBigUint64(88, true),
    clustered:            dv.getUint8(96) === 1,
    internalCompression:  decodeCompression(dv.getUint8(97)),
    tileCompression:      decodeCompression(dv.getUint8(98)),
    tileType:             decodeTileType(dv.getUint8(99)),
    minZoom:              dv.getUint8(100),
    maxZoom:              dv.getUint8(101),
    minLonE7:             dv.getInt32(102, true),
    minLatE7:             dv.getInt32(106, true),
    maxLonE7:             dv.getInt32(110, true),
    maxLatE7:             dv.getInt32(114, true),
    centerZoom:           dv.getUint8(118),
    centerLonE7:          dv.getInt32(119, true),
    centerLatE7:          dv.getInt32(123, true),
  };
}

// ── Varint + directory decoder (spec §Directory encoding) ────────────────────

interface VarintCursor {
  readonly bytes: Uint8Array;
  pos: number;
}

function readVarint(c: VarintCursor): bigint {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (c.pos >= c.bytes.length) throw new Error('pmtiles: varint truncated');
    const b = c.bytes[c.pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result;
    shift += 7n;
    if (shift > 63n) throw new Error('pmtiles: varint overflow');
  }
}

export interface DirectoryEntry {
  tileId: bigint;
  offset: bigint;  // relative to tile_data section (leaf=0 → tile data; leaf=1 → leaf dir data)
  length: number;
  runLength: number; // 0 = leaf directory pointer; >0 = tile run
}

/**
 * Decode a PMTiles v3 directory blob (already decompressed) into entries.
 * Spec §"Directories": 5 varint streams — tile_id (delta), run_length,
 * length, offset (0 = continue), repeated for N entries, where N is the
 * first varint.
 */
export function decodeDirectory(blob: Uint8Array): DirectoryEntry[] {
  const c: VarintCursor = { bytes: blob, pos: 0 };
  const n = Number(readVarint(c));
  const entries: DirectoryEntry[] = new Array(n);
  // tile_id: delta-encoded
  let lastId = 0n;
  for (let i = 0; i < n; i++) {
    const delta = readVarint(c);
    lastId += delta;
    entries[i] = { tileId: lastId, offset: 0n, length: 0, runLength: 0 };
  }
  // run_length
  for (let i = 0; i < n; i++) {
    entries[i]!.runLength = Number(readVarint(c));
  }
  // length
  for (let i = 0; i < n; i++) {
    entries[i]!.length = Number(readVarint(c));
  }
  // offset: 0 → previous.offset + previous.length (contiguous); non-0 → literal - 1
  for (let i = 0; i < n; i++) {
    const raw = readVarint(c);
    if (raw === 0n && i > 0) {
      const prev = entries[i - 1]!;
      entries[i]!.offset = prev.offset + BigInt(prev.length);
    } else {
      entries[i]!.offset = raw - 1n;
    }
  }
  return entries;
}

/** Binary search for the entry covering tile_id. Returns the matching entry or the preceding leaf pointer. */
export function findTile(entries: DirectoryEntry[], tileId: bigint): DirectoryEntry | null {
  // Entries are sorted by tileId ascending.
  let lo = 0;
  let hi = entries.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const e = entries[mid]!;
    if (e.tileId === tileId) return e;
    if (e.tileId < tileId) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const e = entries[best]!;
  if (e.runLength === 0) {
    // leaf directory pointer — caller must descend
    return e;
  }
  if (tileId < e.tileId + BigInt(e.runLength)) return e;
  return null;
}

// ── Decompression (gzip only, via DecompressionStream) ───────────────────────

/**
 * Decompress a directory or tile payload according to the declared compression.
 * PMTiles v3 permits 'none' | 'gzip' | 'brotli' | 'zstd'. CF Workers only
 * guarantee 'gzip' + 'deflate' via DecompressionStream, so brotli/zstd
 * archives require a future rebuild with compression='gzip' or 'none'.
 */
export async function maybeDecompress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === 'none') return data;
  if (kind === 'gzip') {
    const ds = new DecompressionStream('gzip');
    const body = data.slice().buffer;
    const stream = new Response(body).body!.pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(`pmtiles: unsupported compression '${kind}' in CF Worker runtime (rebuild with gzip or none)`);
}

// ── R2-backed reader (with small in-memory header+root-dir cache) ────────────

/** Minimal subset of the R2 binding we need. */
export interface R2RangeReader {
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface PmtilesReaderOptions {
  /** Optional: reuse a header+root-dir cache across requests (per-isolate). */
  cache?: PmtilesCache;
}

export interface PmtilesCache {
  header?: PmtilesHeader;
  rootDir?: DirectoryEntry[];
  leafDirs?: Map<string, DirectoryEntry[]>; // key = `${offset}:${length}`
  key?: string; // pmtiles object key this cache is bound to
}

export function newPmtilesCache(): PmtilesCache {
  return { leafDirs: new Map() };
}

/**
 * Resolve (z,x,y) → tile bytes from a PMTiles archive stored as a single R2
 * object. Uses up to 3 Range GETs: (1) header, (2) root dir, (3) leaf dir
 * if needed, (4) tile bytes. Header + root dir are cached per-isolate.
 */
export async function readTile(
  r2: R2RangeReader,
  objectKey: string,
  z: number,
  x: number,
  y: number,
  opts: PmtilesReaderOptions = {},
): Promise<{ bytes: Uint8Array; header: PmtilesHeader } | null> {
  const cache = opts.cache && opts.cache.key === objectKey ? opts.cache : undefined;

  // 1. Header.
  let header: PmtilesHeader;
  if (cache?.header) {
    header = cache.header;
  } else {
    const hdrObj = await r2.get(objectKey, { range: { offset: 0, length: HEADER_BYTES } });
    if (!hdrObj) return null;
    const hdrBuf = await hdrObj.arrayBuffer();
    header = parseHeader(hdrBuf);
    if (opts.cache) {
      opts.cache.header = header;
      opts.cache.key = objectKey;
    }
  }

  if (z < header.minZoom || z > header.maxZoom) return null;
  const tileId = zxyToTileId(z, x, y);

  // 2. Root directory.
  let rootDir: DirectoryEntry[];
  if (cache?.rootDir) {
    rootDir = cache.rootDir;
  } else {
    const rootObj = await r2.get(objectKey, {
      range: {
        offset: Number(header.rootDirOffset),
        length: Number(header.rootDirLength),
      },
    });
    if (!rootObj) return null;
    const rootBuf = new Uint8Array(await rootObj.arrayBuffer());
    const rootDecoded = await maybeDecompress(rootBuf, header.internalCompression);
    rootDir = decodeDirectory(rootDecoded);
    if (opts.cache) opts.cache.rootDir = rootDir;
  }

  // 3. Find tile — possibly via one leaf-dir descent.
  let entry = findTile(rootDir, tileId);
  if (!entry) return null;

  if (entry.runLength === 0) {
    // Leaf directory pointer: offset + length are relative to leafDirsOffset.
    const leafOffset = Number(header.leafDirsOffset) + Number(entry.offset);
    const leafLength = entry.length;
    const cacheKey = `${leafOffset}:${leafLength}`;
    let leafDir: DirectoryEntry[] | undefined = cache?.leafDirs?.get(cacheKey);
    if (!leafDir) {
      const leafObj = await r2.get(objectKey, { range: { offset: leafOffset, length: leafLength } });
      if (!leafObj) return null;
      const leafBuf = new Uint8Array(await leafObj.arrayBuffer());
      const leafDecoded = await maybeDecompress(leafBuf, header.internalCompression);
      leafDir = decodeDirectory(leafDecoded);
      opts.cache?.leafDirs?.set(cacheKey, leafDir);
    }
    entry = findTile(leafDir, tileId);
    if (!entry || entry.runLength === 0) return null;
  }

  // 4. Tile payload: offset is relative to tileDataOffset.
  const tileOffset = Number(header.tileDataOffset) + Number(entry.offset);
  const tileLength = entry.length;
  const tileObj = await r2.get(objectKey, { range: { offset: tileOffset, length: tileLength } });
  if (!tileObj) return null;
  const rawBuf = new Uint8Array(await tileObj.arrayBuffer());
  const bytes = await maybeDecompress(rawBuf, header.tileCompression);
  return { bytes, header };
}
