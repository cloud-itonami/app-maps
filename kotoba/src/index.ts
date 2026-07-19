/**
 * @etzhayyim/maps-kotoba
 *
 * Top-level barrel re-export. Each topic is also available as a subpath
 * import (e.g., `@etzhayyim/maps-kotoba/source` once the package.json
 * `exports` map is populated — currently consumers import from the
 * package root).
 *
 * Topics implemented in this package:
 *   - source        — Source DID registry (Tier A, 24 records)
 *   - geo           — Geo DID Management (Tier A, region/alias/vertical/natural/layer-coord)
 *   - display-layer — Display layer definitions (Tier A, operator-defined)
 *   - registry      — Legal Entity + Registry (Tier A, Land/Property/Business/Permit/License/Zoning) + Ownership
 *   - collection    — Collection job descriptor + state-event log (Tier A)
 *   - feature       — Geo / Building / Asset feature registration (Tier B, L0 or L1 witnessed via @etzhayyim/sdk/kotoba-datomic)
 */

export * as source from "./source/index.js";
export * as geo from "./geo/index.js";
export * as displayLayer from "./display-layer/index.js";
export * as registry from "./registry/index.js";
export * as collection from "./collection/index.js";
export * as feature from "./feature/index.js";
