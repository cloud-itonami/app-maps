# maps — kotoba reference implementation (Tier A)

Multi-topic kotoba port covering 5 Tier A surfaces + 1 Tier B surface per [`MIGRATION-TODO.md`](../MIGRATION-TODO.md)
Phase 1 / Phase 3 + [ADR-2605231400](../../../90-docs/adr/2605231400-kotoba-datomic-holochain-iso-substrate.md).
Mirrors the [`open-isic/kotoba/`](../../etzhayyim-project-open-isco/kotoba/) reference per topic.

> **Status**: scaffold v0.0.0, **235/235 vitest passing**. Live PDS
> seed run pending `ETZ_SEEDER_DID` + PDS auth credentials. Production
> witnessed write path exercised end-to-end against mock 30-cell fleet;
> Murakumo cell-runner endpoint TBD before live L1 writes.

## Topics covered in this package

| Topic | Tier | Lexicons | Seed | Tests |
|---|---|---|---|---|
| **source** (Source DID registry) | A | `com.etzhayyim.maps.source` | 24 records | 53 |
| **geo** (Geo DID Management — 8 commands) | A | `com.etzhayyim.maps.{region,geoAlias,verticalZone,naturalZone,layerCoordinator}` | 59 records + 29 schemes | 45 |
| **display-layer** (operator-defined overlays — 2 commands) | A | `com.etzhayyim.maps.displayLayer` | operator-driven | 21 |
| **registry** (Legal Entity + Registry + Ownership — 22 commands) | A | `com.etzhayyim.maps.{legalEntity,registry,ownership}` | pipeline-driven | 38 |
| **collection** (Job + state event log — 4 commands) | A | `com.etzhayyim.maps.{collectionJob,jobEvent}` | event-log shape | 45 |
| **feature** (Geography / Building / Asset registration) | **B (L0 + L1 witnessed)** | `com.etzhayyim.maps.feature` (existing) | label-discriminated | 33 |
| **TOTAL** | — | **11 new lexicons** | **83 seed records + 29 schemes** | **235 tests** |

## Tier B end-to-end demo

The `feature` module is the first surface that uses the full kotoba-datomic
L1 witness pipeline. Call shape:

```typescript
import { kotoba-datomic } from "@etzhayyim/sdk";
import { feature } from "@etzhayyim/maps-kotoba";

// L0 — no witnessing
const r0 = await feature.registerMountain({
  name: "Mount Fuji",
  lng: 138.7274, lat: 35.3606,
  elevationMeters: 3776,
  h3Cell: "8a30d8bd2477fff",
  rkey: "mount-fuji",
}, { client: etzhayyimClient });

// L1 — witnessed via Murakumo fleet
const r1 = await feature.registerMountain({ /* same */ }, {
  client: etzhayyimClient,
  witness: {
    fleet: fleetFromTomlSnapshot(),
    transport: kotoba-datomic.createPdsPollingWitnessTransport({
      client: etzhayyimClient,
      attestationRepo: "did:web:maps.etzhayyim.com",
      requestEndpoint: (cell) => `https://${cell.node}/kotoba-datomic/attest`,
    }),
  },
});
// r1.witnessState.kind === "witnessed" | "rejected" | "escalated" | "pending"
```

Test fixtures (`src/feature/witnessed.test.ts`) demonstrate the end-to-end
path against a mock 30-cell fleet with `createInMemoryWitnessTransport`,
covering all-accept quorum + 4 rejection paths. To run against a real
Murakumo fleet, swap `createInMemoryWitnessTransport` for
`createPdsPollingWitnessTransport` (operator wires cell-runner endpoints).

## What this proves (Tier A, first surface)

Source DID registry is the smallest, cleanest Tier A surface:

| Property | Why Source DID fits the substrate model |
|---|---|
| Cardinality = 24 | Trivially fits in MST; full-scan reads are sub-ms |
| Write rate ≈ 0 | New external API is rare (~quarterly cadence) |
| Public source (catalog) | No PII; redistribution under Charter §1 |
| rkey == slug | Stable, kebab-case slugs make MST lookup O(1) by primary key |
| Append-only + Supersedes edge | No mutation; revision = new record with `supersedesDid` |
| No spatial query | Doesn't need a kotoba-datomic-projection — pure MST works |

## Layout

```
kotoba/
├── README.md
├── package.json         # depends on @etzhayyim/sdk
├── tsconfig.json
├── data/
│   ├── sources.json              # 24 source DID seed
│   ├── vertical-zones.json       # 14 atmosphere/underground/ocean bands
│   ├── natural-zones.json        # 34 Köppen / WWF biome / tectonic
│   ├── layer-coordinators.json   # 11 KAMI visual layers
│   └── geo-schemes.json          # 29 scheme descriptors manifest
└── src/
    ├── index.ts         # top-level barrel — `source` / `geo` / `displayLayer` / `registry` namespaces
    ├── verify.ts        # shared CLI — SDK.verify() for any at-uri
    ├── source/
    │   ├── types.ts            # MapsSource + didForSlug / slugForDid / isValidTtl
    │   ├── seed.ts             # seeds sources.json → com.etzhayyim.maps.source records
    │   ├── query.ts            # CLI read with prefix/slug/category filters
    │   ├── index.ts            # programmatic listSources / getSource / resolveSourceDid
    │   └── *.test.ts           # 53 tests
    ├── geo/
    │   ├── types.ts            # Region / GeoAlias / VerticalZone / NaturalZone / LayerCoordinator + helpers
    │   ├── seed.ts             # seeds the 3 constant fixtures (no Region/Alias — pipeline-driven)
    │   ├── query.ts            # CLI read for any of the 5 collections + schemes manifest
    │   ├── index.ts            # listRegions / getRegion / resolveGeoAlias / listGeoAliases /
    │   │                       # listVerticalZones / listNaturalZones / listLayerCoordinators /
    │   │                       # resolveZones3d / listGeoSchemes
    │   └── *.test.ts           # 41 tests
    ├── display-layer/
    │   ├── types.ts            # DisplayLayer + isValidLayerId / isValidZoomRange
    │   ├── query.ts            # CLI read with prefix/kind/source filters
    │   ├── index.ts            # defineDisplayLayer / listDisplayLayers / getDisplayLayer
    │   └── types.test.ts       # 24 tests
    └── registry/
        ├── types.ts            # LegalEntity / Registry / Ownership + entityKeyFor / registryKeyFor / isValidLei
        ├── query.ts            # CLI read with entityKey/registryKey/subject/object filters
        ├── index.ts            # registerLegalEntity / registerRegistry / registerOwnership /
        │                       # ownershipChain / entityHistory + getters
        └── types.test.ts       # 34 tests
```

## SDK usage map (ADR-2605172000 §"Per-app-pattern migration guide")

Old (RW-backed `appview/maps-ui-uqpel6i6/src/app.ts` / `collection-commands.ts`):

```typescript
// registerSource handler
await createKyselyDb(env.HYPERDRIVE)
  .insertInto("vertex_maps_source")
  .values({ slug, did, display_name, external_source, ttl, status, ... })
  .onConflict((oc) => oc.column("slug").doUpdateSet({ ... }))
  .execute();

// listSources handler
const rows = await createKyselyDb(env.HYPERDRIVE)
  .selectFrom("vertex_maps_source")
  .where("status", "=", "active")
  .selectAll()
  .execute();
```

New (kotoba):

```typescript
import { listSources, getSource } from "@etzhayyim/maps-kotoba";

// registerSource handler (write-side)
import { Etzhayyim } from "@etzhayyim/sdk";
const e = new Etzhayyim({ /* ... */ });
await e.write({
  collection: "com.etzhayyim.maps.source",
  rkey: slug,
  record: { v: 1, slug, did, displayName, externalSource, ttl, status, registeredAt, ... },
});

// listSources handler (read-side)
const sources = await listSources({ prefix: "" });
const active = sources.filter((s) => s.status === "active");

// resolveSourceDid handler (lookup by DID)
import { resolveSourceDid } from "@etzhayyim/maps-kotoba";
const src = await resolveSourceDid("did:web:maps.etzhayyim.com:geocode");
```

## Lexicon

Record lexicon at [`orgs/etzhayyim/com-etzhayyim-maps/wire/lex/source.json`](../../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/source.json)
(NSID `com.etzhayyim.maps.source`).

`rkey` policy: `literal:{slug}` — the kebab-case slug is the MST key
verbatim. Idempotent re-seeds produce no new records.

## Seed

```bash
# Full seed (24 sources) from data/sources.json
pnpm tsx src/seed.ts

# Filtered
pnpm tsx src/seed.ts --only=geocode
pnpm tsx src/seed.ts --category=registry
```

Required env: `ETZ_PDS_URL` (default `https://pds.etzhayyim.com`) +
either an authenticated SDK session OR an SDK builder that resolves
credentials from the host (deploy-time concern; not in scope here).

## Query

```bash
pnpm tsx src/query.ts                          # all 24 sources
pnpm tsx src/query.ts --slug=geocode           # exact lookup
pnpm tsx src/query.ts --prefix=registry-       # all registry-* sources
pnpm tsx src/query.ts --category=satellite     # post-filter by category
pnpm tsx src/query.ts --status=active          # filter by status
```

## Verify

```bash
pnpm tsx src/verify.ts at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.source/geocode
```

Returns the Merkle path from the record to the MST root that was
anchored to Base L2 via the substrate pipeline. Any client (no
credentials) can re-check the proof.

## Tests

```bash
pnpm test
# ~45 tests:
#   - 25 didForSlug round-trip cases (all 24 seed slugs + one extras coverage)
#   - 8 slugForDid + invalid-DID-rejection cases
#   - 11 isValidTtl accept/reject cases
#   - 5 toMapsSource converter shape cases
```

## Status

| Surface | State |
|---|---|
| Record lexicon | ✅ `orgs/etzhayyim/com-etzhayyim-maps/wire/lex/source.json` |
| Seed data (24 entries) | ✅ `data/sources.json` |
| Seeder + helpers | ✅ |
| Pure-helper tests | ✅ |
| Live PDS seed run | ⏳ pending `ETZ_SEEDER_DID` + PDS auth credentials |
| Anchor verify against deployed contract | ⏳ pending `ETZ_ANCHOR_CONTRACT` deploy on target chain |
| L1-witnessed (Tier B promotion) | ⏳ pending kotoba-datomic-witnesses live in Murakumo (ADR-2605231400 impl plan #2-#3) |

## See also

- [`60-apps/etzhayyim-project-open-isic/kotoba/`](../../etzhayyim-project-open-isic/kotoba/) — pattern reference (ISIC-08 classification)
- [`60-apps/etzhayyim-project-open-isco/kotoba/`](../../etzhayyim-project-open-isco/kotoba/) — earlier reference (ISCO occupations)
- [`20-actors/etzhayyim-sdk/`](../../../20-actors/etzhayyim-sdk/) — the substrate-purity SDK
- [`50-infra/mst-projector/`](../../../50-infra/mst-projector/) — Stage 3 of the verification chain
- [`MIGRATION-TODO.md`](../MIGRATION-TODO.md) — full maps migration plan (Tiers A / B / C / D, Phases 0–6)
- [ADR-2605231400](../../../90-docs/adr/2605231400-kotoba-datomic-holochain-iso-substrate.md) — kotoba-datomic canonical name
- [ADR-2605172000](../../../90-docs/adr/2605172000-etzhayyim-kotoba-substrate.md) — substrate rules

## Next waves (Phase 1 remaining surfaces)

Per [`MIGRATION-TODO.md`](../MIGRATION-TODO.md) Phase 1 Tier A:

1. **Geo DID Management (8 commands)** — register_region / resolve_geo_alias / list_geo_aliases / list_vertical_zones / list_natural_zones / list_layer_coordinators / resolve_zones_3d / list_geo_schemes. Lexicon `com.etzhayyim.maps.{region,geoAlias,verticalZone,naturalZone,layerCoordinator}` (5 new lexicons).
2. **Display layer (2 commands)** — `display_layer_define` / `list_display_layers`. Lexicon `com.etzhayyim.maps.displayLayer`.
3. **Collection plumbing (4 commands)** — `createCollectionJob` / `advanceJob` / `listJobs` / `getJobStatus`. Lexicon `com.etzhayyim.maps.collectionJob`.
4. **Registry & Legal Entity register/list (22 commands)** — LegalEntity / LandRegistry / PropertyRegistry / BusinessRegistry / ConstructionPermit / OperatingLicense / ZoningRecord + ownership/registry-link. 7+ new lexicons.

All follow this same pattern: types + seed + query + verify + tests, sharing `@etzhayyim/sdk` as the only substrate seam.
