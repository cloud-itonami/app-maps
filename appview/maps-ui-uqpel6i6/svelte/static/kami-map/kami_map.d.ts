/* tslint:disable */
/* eslint-disable */

export class KamiMap {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add or replace a named circle (point) layer. `points_json` is a JSON array
     * of `[lng, lat]`. `radius` is in world pixels at current zoom.
     */
    add_circle_layer(id: string, points_json: string, color_hex: string, radius: number): void;
    /**
     * Add or replace a named 3D extrusion layer (building footprints → roof + walls).
     *
     * `rings_json`  : `[[[lng,lat], ...], ...]` polygon outer rings
     * `heights_json`: `[h, ...]` world-space extrusion height per polygon
     * `color_hex`   : `#rrggbb`
     * `opacity`     : 0..1
     *
     * Extrusions render only when the camera is tilted (pitch > 0). In pure
     * top-down orthographic view they appear as roof polygons only.
     */
    add_extrude_layer(id: string, rings_json: string, heights_json: string, color_hex: string, opacity: number): void;
    /**
     * Add or replace a named polygon fill layer. `rings_json` is a JSON array of
     * rings (outer only for now), each an array of `[lng, lat]`.
     */
    add_fill_layer(id: string, rings_json: string, color_hex: string, opacity: number): void;
    /**
     * Add or replace a named line layer. `lines_json` is a JSON array of polylines
     * where each polyline is an array of `[lng, lat]`.
     */
    add_line_layer(id: string, lines_json: string, color_hex: string, width: number): void;
    /**
     * Clear all overlay layers.
     */
    clear_layers(): void;
    /**
     * Initialize the map on a canvas element.
     */
    static create(canvas_id: string, options_json: string): Promise<KamiMap>;
    /**
     * Decode an MVT (Mapbox Vector Tile) PBF blob and return the named layer's
     * geometry as JSON `{ lines: [...], polygons: [...], points: [...] }` in
     * geographic coordinates. The bridge accumulates this across visible tiles
     * and feeds it back into add_line_layer / add_fill_layer / add_circle_layer.
     */
    decode_mvt_layer(z: number, x: number, y: number, layer_name: string, pbf: Uint8Array): string;
    /**
     * Decode an MVT (Mapbox Vector Tile) PBF blob and return the named layer's
     * features as GeoJSON-like `{ features: [{ geometry, properties }] }`.
     */
    decode_mvt_layer_features(z: number, x: number, y: number, layer_name: string, pbf: Uint8Array): string;
    /**
     * Adjust center + zoom so the bounding box fits the viewport with optional padding px.
     */
    fit_bounds(min_lng: number, min_lat: number, max_lng: number, max_lat: number, padding_px: number): void;
    fly_to(lng: number, lat: number, zoom: number, duration_ms: number): void;
    /**
     * Render one frame. Call from requestAnimationFrame.
     */
    frame(dt_ms: number): void;
    get_dem_tile_url(z: number, x: number, y: number): string;
    get_viewport(): string;
    get_zoom(): number;
    /**
     * Returns true if a named layer exists.
     */
    has_layer(id: string): boolean;
    /**
     * Invalidate cached meshes so named layers regenerate at the new zoom/center.
     */
    invalidate_layers(): void;
    /**
     * List named layer ids (JSON array).
     */
    list_layers(): string;
    on_pointer_down(x: number, y: number, button: number): void;
    on_pointer_move(_x: number, _y: number, dx: number, dy: number): void;
    on_pointer_up(_x: number, _y: number): void;
    on_wheel(delta: number): void;
    /**
     * Project a geographic coordinate to screen pixels. Returns JSON `[x, y]`.
     */
    project(lng: number, lat: number): string;
    /**
     * Remove a named layer.
     */
    remove_layer(id: string): void;
    resize(width: number, height: number): void;
    set_bearing(degrees: number): void;
    set_center(lng: number, lat: number): void;
    /**
     * Show/hide a named layer.
     */
    set_layer_visibility(id: string, visible: boolean): void;
    /**
     * Restrict the zoom range over which a layer is drawn.
     */
    set_layer_zoom_range(id: string, min_zoom: number, max_zoom: number): void;
    set_pitch(degrees: number): void;
    /**
     * Add a GeoJSON route (line) layer.
     */
    set_route(coords_json: string, color_hex: string, width: number): void;
    set_zoom(zoom: number): void;
    /**
     * Get tile URLs that need fetching for the current viewport.
     * Returns JSON array of {z, x, y, url} objects.
     */
    tiles_to_fetch(): string;
    unproject(screen_x: number, screen_y: number): string;
    upload_dem_tile(z: number, x: number, y: number, heights_m: Float32Array, width: number, height: number): void;
    /**
     * Upload a tile image (RGBA bytes) and register it for rendering.
     */
    upload_tile(z: number, x: number, y: number, rgba_data: Uint8Array, img_width: number, img_height: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_kamimap_free: (a: number, b: number) => void;
    readonly kamimap_add_circle_layer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly kamimap_add_extrude_layer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly kamimap_add_fill_layer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly kamimap_add_line_layer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly kamimap_clear_layers: (a: number) => void;
    readonly kamimap_create: (a: number, b: number, c: number, d: number) => any;
    readonly kamimap_decode_mvt_layer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly kamimap_decode_mvt_layer_features: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly kamimap_fit_bounds: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly kamimap_fly_to: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly kamimap_frame: (a: number, b: number) => void;
    readonly kamimap_get_dem_tile_url: (a: number, b: number, c: number, d: number) => [number, number];
    readonly kamimap_get_viewport: (a: number) => [number, number];
    readonly kamimap_get_zoom: (a: number) => number;
    readonly kamimap_has_layer: (a: number, b: number, c: number) => number;
    readonly kamimap_invalidate_layers: (a: number) => void;
    readonly kamimap_list_layers: (a: number) => [number, number];
    readonly kamimap_on_pointer_down: (a: number, b: number, c: number, d: number) => void;
    readonly kamimap_on_pointer_move: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly kamimap_on_pointer_up: (a: number, b: number, c: number) => void;
    readonly kamimap_on_wheel: (a: number, b: number) => void;
    readonly kamimap_project: (a: number, b: number, c: number) => [number, number];
    readonly kamimap_remove_layer: (a: number, b: number, c: number) => void;
    readonly kamimap_resize: (a: number, b: number, c: number) => void;
    readonly kamimap_set_bearing: (a: number, b: number) => void;
    readonly kamimap_set_center: (a: number, b: number, c: number) => void;
    readonly kamimap_set_layer_visibility: (a: number, b: number, c: number, d: number) => void;
    readonly kamimap_set_layer_zoom_range: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly kamimap_set_pitch: (a: number, b: number) => void;
    readonly kamimap_set_route: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly kamimap_set_zoom: (a: number, b: number) => void;
    readonly kamimap_tiles_to_fetch: (a: number) => [number, number];
    readonly kamimap_unproject: (a: number, b: number, c: number) => [number, number];
    readonly kamimap_upload_dem_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly kamimap_upload_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly wasm_bindgen__closure__destroy__h2999ab7c8b76f609: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7fab2cc70c6a6a11: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h5db5e8dc2faf8fdd: (a: number, b: number, c: any, d: any) => void;
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
