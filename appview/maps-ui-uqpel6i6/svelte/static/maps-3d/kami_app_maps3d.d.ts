/* tslint:disable */
/* eslint-disable */

/**
 * Drop a previously-loaded splat tile so its GPU buffers can be
 * released. Used by the JS host's tile cache eviction.
 */
export function remove_gsplat_asset(tile_h3: string): void;

/**
 * Drop a previously-loaded photogrammetry tile so its GPU buffers can
 * be released. Used by the JS host's tile cache eviction.
 */
export function remove_mesh_tile(tile_h3: string): void;

/**
 * Boot the 3D map walker on the given canvas.
 *
 * ```js
 * import init, { run_maps3d } from './kami_app_maps3d.js';
 * await init();
 * await run_maps3d('gc');
 * ```
 */
export function run_maps3d(canvas_id: string): Promise<void>;

export function set_atoms_json(json: string): void;

export function set_buildings_json(json: string): void;

/**
 * Push a fresh atom set from JS. Each item carries CPK colour + sphere
 * radius (pm) + world position. Radius is scaled `× 0.001` so a
 * 150 pm atom renders at ~0.15 m diameter in world space.
 *
 * ```js
 * set_atoms_json(JSON.stringify([
 *   { symbol:"C", colorR:0.2, colorG:0.2, colorB:0.2,
 *     sphereRPm:77, worldX:0, worldY:1.5, worldZ:0 }
 * ]));
 * ```
 * Push a splat tile from JS. `format` is `"ply"` (default) or
 * `"splat"` (antimatter15 32-byte compact). Returns the parsed splat
 * count so the host UI can show a "loaded N splats" toast.
 *
 * Capped at `kami_pipelines::MAX_SPLATS_PER_CLOUD = 100_000`
 * (preview/QC scope, ADR-2605092800). Use the bake pipeline for
 * heavier scenes.
 *
 * ```js
 * const ply = await fetch(asset.signedUrl).then(r => r.arrayBuffer());
 * const n = set_gsplat_asset(asset.tileH3, new Uint8Array(ply), "ply");
 * console.log(`loaded ${n} splats for ${asset.tileH3}`);
 * ```
 */
export function set_gsplat_asset(tile_h3: string, bytes: Uint8Array, format: string): number;

/**
 * Push a fresh building set from JS. Returns parse error as a string
 * so the caller can surface it. See `buildings.rs::BuildingBoxJson`
 * for the expected JSON shape.
 *
 * ```js
 * set_buildings_json(JSON.stringify([
 *   { minX: -10, maxX: 10, minZ: -10, maxZ: 10, baseY: 0, height: 24 }
 * ]));
 * ```
 * Upsert a photogrammetry tile from GLB bytes. Called by the JS host
 * after fetching `b2://etzhayyim-nats/maps3d/tile/{tile_h3}.glb` (output
 * of the `maps3d.simplifyAndExport` BPMN task). Replaces any prior
 * mesh for the same tile.
 *
 * ```js
 * const glb = await fetch(meshUri).then(r => r.arrayBuffer());
 * set_mesh_tile(tileH3, new Uint8Array(glb));
 * ```
 */
export function set_mesh_tile(tile_h3: string, glb: Uint8Array): void;

/**
 * Push a fresh vegetation set from JS. Each item's `renderProfileJson`
 * encodes an `OwnedTaxonomicProfile` (camelCase, from the
 * `seibutsu.renderProfile` XRPC shape). World position + scale are
 * applied at build time so the GPU sees pre-transformed geometry.
 *
 * ```js
 * set_vegetation_json(JSON.stringify([
 *   { renderProfileJson: '{"canopy":"Blade",...}',
 *     worldX: 5.0, worldY: 0.0, worldZ: -3.0,
 *     scaleX: 1.0, scaleY: 1.2, scaleZ: 1.0 }
 * ]));
 * ```
 */
export function set_vegetation_json(json: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly remove_gsplat_asset: (a: number, b: number) => void;
    readonly remove_mesh_tile: (a: number, b: number) => void;
    readonly run_maps3d: (a: number, b: number) => any;
    readonly set_atoms_json: (a: number, b: number) => [number, number];
    readonly set_buildings_json: (a: number, b: number) => [number, number];
    readonly set_gsplat_asset: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly set_mesh_tile: (a: number, b: number, c: number, d: number) => [number, number];
    readonly set_vegetation_json: (a: number, b: number) => [number, number];
    readonly wasm_bindgen__closure__destroy__h5c1f4f983c7f8bff: (a: number, b: number) => void;
    readonly wasm_bindgen__closure__destroy__h11c703ba9d5e808e: (a: number, b: number) => void;
    readonly wasm_bindgen__closure__destroy__h2999ab7c8b76f609: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7fab2cc70c6a6a11: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h5db5e8dc2faf8fdd: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3a6f88c67b5f8bee: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3a6f88c67b5f8bee_1: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3a6f88c67b5f8bee_2: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3a6f88c67b5f8bee_3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hb54b292a3b272ca1: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
