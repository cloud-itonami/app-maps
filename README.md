# app-maps

Spatial intelligence application extracted from the etzhayyim monorepo. It is
four separate subsystems that share a repository, not one program:

| subsystem | what it is | tracked | state, measured 2026-08-18 |
|---|---|---|---|
| `kotoba/` | TypeScript reference implementation of the maps lexicon surfaces | 58 files / 338,013 B | **9 of its files do not parse** — see below |
| `appview/maps-ui-uqpel6i6/` | Cloudflare Worker + SvelteKit UI for `maps.etzhayyim.com` | 73 files / 5,735,783 B | cannot build anywhere — see §Blockers |
| `appview/maps-tile-server-t1l3srv0/` | Worker that serves MVT tiles out of PMTiles in R2 | 14 files / 40,787 B | **the one subsystem that installs and typechecks clean** |
| `bulk-ingest/` | 21 Python dumper/consumer pods + 13 Kubernetes manifests | 48 files / 394,844 B | all 21 files compile; not run here |

213 tracked files before this documentation was added. `runpod-endpoint/` and
`runpod-endpoint-gsplat/` (11 files) hold RunPod handlers for gaussian-splat
work; `tools/` holds one operator note.

Start at [`docs/operator-quickstart.md`](docs/operator-quickstart.md). Every
number on this page is re-measured by
[`docs/verify-docs-claims.cljs`](docs/verify-docs-claims.cljs); run it before
trusting any of them.

## Read this before you plan work here

**Nine of the 94 tracked TypeScript files are not valid TypeScript.** They
contain `kotoba-datomic` in identifier position:

```ts
import { kotoba-datomic } from "@etzhayyim/sdk";   // kotoba/src/feature/index.ts:22
type FleetCell = kotoba-datomic.FleetCell;
```

A JavaScript identifier cannot contain `-`, so the parser reads `kotoba` minus
`datomic`. Two independent parsers agree on the same nine files: esbuild
(`Expected "}" but found "-"`) and `tsc --noEmit`, which exits 2 with 47 errors,
all of them TS1005 / TS1128 / TS1434 and all inside those nine files.

The SDK these files import spells the export `kotobaDatomic`
(`etzhayyim/com-etzhayyim-sdk@12314a0c`, `src/index.ts:629`:
`export * as kotobaDatomic from "./kotoba-datomic/index.js"`). The nine files
use the *directory* name where the *export* name belongs — the signature of a
kebab-case rename that reached code as well as prose.

**This is inherited, not an extraction defect.** The upstream monorepo carries
the identical broken lines at the revision `migration.edn` pins
(`etzhayyim/root@45b5906`, `60-apps/etzhayyim-project-maps/kotoba/src/feature/index.ts:22`),
and custody here is exact: all 211 non-canonical blobs match that upstream
subtree path-for-path and SHA-for-SHA
([`docs/verify-custody.cljs`](docs/verify-custody.cljs)). So the fix belongs
upstream too, and this repository has not drifted from what it was given.

## What the test suite actually runs

`kotoba/package.json` declares `"test": "vitest run"`. Running it produces
**one passing test**, because `kotoba/vitest.config.ts` sets
`include: ["test/**/*.test.ts"]` and `kotoba/test/` holds a single 155-byte
file whose only case is `expect(true).toBe(true)`.

The real suites — 18 files — live under `kotoba/src/` and are never collected.
Point vitest at them and you get:

```
Test Files  11 failed | 7 passed (18)
     Tests  235 passed (235)
```

`kotoba/README.md` says "**235/235 vitest passing**". The 235 is real. The
denominator is not: 11 suites fail before a single assertion runs, so nothing
in them is counted on either side of that fraction. The seven that do run are
all `types.test.ts` — collection 45, source 48, geo 40, registry 38, feature 24,
display-layer 21, twin 19. `kotoba/README.md`'s per-topic table
(source 53 / geo 45 / display-layer 21 / registry 38 / collection 45 /
feature 33) also sums to 235 but does not match those counts topic by topic,
and it omits `twin` — which `kotoba/src/index.ts` likewise does not re-export,
though `src/twin/` exists and its 19 tests pass.

**Fixing the identifier is necessary but not sufficient.** Measured on a
throwaway copy: renaming `kotoba-datomic` to `kotobaDatomic` drops parse errors
from 7 to 0, and the result is still `11 failed | 7 passed` — every failure now
reading `Cannot find package '@etzhayyim/sdk'`. `tsc` on that copy goes from 47
syntax errors to 89 semantic ones (22 TS2307, 22 TS2305, 36 TS7006, 7 TS2339,
and one each of TS2724 / TS2694).

At least one suite would still fail on its merits.
`kotoba/src/feature/geography.test.ts` imports `registerAdminArea`,
`registerCoastline`, `registerLake`, `registerMaritimeZone`, `registerRiver`,
`registerSpot` and `listFeatures` from `./index.js`. None of those names appear
anywhere in `kotoba/src/feature/` outside test files; the module exports three
`register*` functions (`registerFeature`, `registerMountain`,
`registerBuilding`). The test was written against a larger API than the module
has.

## Blockers, and which of them this repository can fix

| blocker | measured | fixable here? |
|---|---|---|
| `npm install` in `kotoba/` | `EALLOWSCRIPTS` — "git dep preparation failed" | **no.** `@etzhayyim/sdk@0.1.0-alpha` declares `main: ./dist/index.js` but commits no `dist/`, delegating the build to `prepare: tsc`, which npm 11 refuses to run for project-scoped git deps. Same upstream cause recorded in app-live `docs/adr/2608180536` |
| `npm install` in `appview/maps-ui-uqpel6i6/svelte/` | `EUNSUPPORTEDPROTOCOL` — `workspace:*` | **no.** Two dependencies use `workspace:*` and no tracked `package.json` in this repository declares `workspaces` |
| building the `maps-ui` Worker | `wrangler.jsonc` `alias` maps 8 module specifiers to absolute paths under `/Users/junkawasaki/github/etzhayyim-apps-etzhayyimcojp/` | **no, and not on the author's machine either** — 0 of the 8 targets exist there today |
| all four declared Worker routes | `maps.etzhayyim.com`, `uqpel6i6.etzhayyim.com`, `tiles-maps.etzhayyim.com`, `t1l3srv0.etzhayyim.com` are all NXDOMAIN; so are the declared upstreams `mcp.etzhayyim.com` and `maps-langserver.etzhayyim.com`. Only the apex `etzhayyim.com` resolves | DNS, not code |
| the broken identifier | 9 files | **yes** — but see the parity note above, and fix upstream first so custody stays exact |

## Credential exposure — needs an owner, now

`MAPILLARY_ACCESS_TOKEN` is committed in cleartext in two tracked files of this
**public** repository: `appview/maps-ui-uqpel6i6/wrangler.jsonc:24` and
`appview/maps-ui-uqpel6i6/kotodama.jsonld:7`. Deleting the lines does not
un-publish it. It needs rotation at Mapillary and re-issue through the
`secrets_store_secrets` binding the same file already uses for 21 other
secrets. Left in place here deliberately: removing it would hide the exposure
without ending it. Recorded as decision 1 of
[`docs/adr/2608180800-app-maps-inherited-defects.edn`](docs/adr/2608180800-app-maps-inherited-defects.edn).

## Tests that exist but have no runner

`appview/maps-ui-uqpel6i6/` ships 5 `*.test.ts` files under `src/` (23 cases)
and 5 Playwright specs under `svelte/e2e/` (22 cases). Its `package.json`
declares no `test` script, and `svelte/package.json` declares none either — so
nothing runs them. They are not counted in the 235 above.

## Provenance

Extracted from `etzhayyim/root@45b5906`, path
`60-apps/etzhayyim-project-maps`, per `migration.edn`. `CLAUDE.md` (48,528 B)
is the pre-extraction design record and its relative links point back into the
monorepo; it opens by declaring the actor migrated to
`orgs/etzhayyim/com-etzhayyim-maps`, so treat it as history, not as
instructions for this tree. Licensing is Apache-2.0 plus the etzhayyim Charter
Compliance Rider v3.1 (`NOTICE`, `kotoba/CHARTER-RIDER.md`).
