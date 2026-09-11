# app-maps

Spatial intelligence application extracted from the etzhayyim monorepo. It is
four separate subsystems that share a repository, not one program:

| subsystem | what it is | tracked | state, measured 2026-08-19 |
|---|---|---|---|
| `kotoba/` | TypeScript reference implementation of the maps lexicon surfaces | 59 files / 338,038 B | **9 of its files do not parse** — see below |
| `appview/maps-ui-uqpel6i6/` | Cloudflare Worker + SvelteKit UI for `maps.etzhayyim.com` | 73 files / 5,735,783 B | cannot build anywhere, and **was not migrated** — see §The migration |
| `appview/maps-tile-server-t1l3srv0/` | the Worker for `tiles-maps.etzhayyim.com` | 3 files / 10,390 B | **migrated to ClojureScript on 2026-08-19** — see §The migration |
| `bulk-ingest/` | 21 Python dumper/consumer pods + 13 Kubernetes manifests | 48 files / 394,844 B | all 21 files compile; not run here |

216 tracked files (219 before the migration removed 11 and added 8).
`runpod-endpoint/` and `runpod-endpoint-gsplat/` (11 files) hold RunPod handlers
for gaussian-splat work; `tools/` holds one operator note.

Start at [`docs/operator-quickstart.md`](docs/operator-quickstart.md). Every
number on this page is re-measured by
[`docs/verify-docs-claims.cljk`](docs/verify-docs-claims.cljk) (39 checks); run
it before trusting any of them.

## The migration — one appview of two

On 2026-08-19 the **`maps-tile-server`** appview moved from TypeScript/Svelte to
ClojureScript ([`docs/adr/0001`](docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn)).
The **`maps-ui`** appview did not. They are different shapes and the difference
decided the outcome:

```
src/maps/tile/route.cljk    判断（どの handler が答えるか）  ← 純 .cljc、テスト対象
src/maps/tile/view.cljk     ページ（jp-go-dds の hiccup）    ← 純 .cljc、テスト対象
src/maps/tile/worker.cljk   Request/Response に触る唯一の層
        ↓ shadow-cljs :target :esm
dist/worker.js              ← appview/maps-tile-server-t1l3srv0/wrangler.jsonc の "main"
```

**`maps-tile-server` before**: `main` pointed at
`svelte/.svelte-kit/cloudflare/_worker.js`, a SvelteKit build output that is not
in the tree. The files a reader opens — `src/app.ts` (284 lines) and
`src/pmtiles.ts` (402 lines) — were **in no bundle**, and the R2/KV bindings
they require are declared **nowhere** in that `wrangler.jsonc`. What was
deployed was the SvelteKit landing page, which reported `Routes 0` / `vars: []`
beside a config declaring 2 route patterns and 11 vars. That page is gone; the
new one renders the route table it is handed, so the two cannot drift.

**`maps-ui` was not migrated, and the reason is a measurement, not a
preference.** Its `main` *is* `src/app.ts` (7,895 lines) and its bindings *are*
declared (R2 ×2, Hyperdrive, 4 services, 21 secrets-store entries). But every
HTTP response it produces is assembled by `createWorkerExport` from
`@etzhayyim/kotodama-host-sdk` — a package that is not in this repository, not
on this machine, and not in any of the 4,212 projects of the surrounding
workspace (`nbb scripts/repo-search.cljs kotodama-host-sdk` → 0 hits). **Its
route surface cannot be read here, so it cannot be ported here**; porting it
would mean inventing behaviour and calling it a migration. It is also not
deleted: its 73 files match upstream SHA-for-SHA and record the intended
bindings. `docs/verify-docs-claims.cljk` pins that file count so the untouched
subsystem cannot grow silently.

Migrating it needs a ClojureScript face for that SDK. That is a separate
decision.

### What the migration did not carry over

The tile-serving surface in `src/app.ts` — `/v1/{z}/{x}/{y}.pbf`,
`/v1/manifest.json`, `/v1/style.json`, `/_worker/health`, `/_app/meta` — was
**not** ported: it was never deployed *and* its bindings are undeclared. It is
not silently gone either. It lives as data in `src/maps/tile/route.cljk`
(`withheld`), with a per-route reason, is rendered on the page, and the tests
assert that nothing appears in both `routes` and `withheld` and that every
withheld entry carries a reason.

A third measurement, found after the decision and pointing the same way: the
**only in-repo consumer of that surface rejects it**. `maps-ui`'s
`svelte/src/App.svelte:697` filters `tiles-maps.etzhayyim.com` out of the vector
tile URL it hands to the renderer, commented "Known-broken host … explicitly
rejected so stale server config … can't resurrect the black-tile path". So the
tile-serving code was never deployed, has no bindings, **and** its one client
had already blocklisted it.

`GET /health` went the other way: it is **added**, not ported. The route table
records that with `:route/origin :added` and the page prints it in an「出自」
column, so an added surface cannot be read as a migrated one.

Two defects were deliberately **kept**: `/xrpc/a/b` is relayed verbatim (the
SvelteKit rest parameter did that; narrowing it is a policy change, not a
migration), and the relay still forwards the client's headers — `authorization`
and `cookie` included — to the upstream router.

## Read this before you plan work here

**Nine of the 90 tracked TypeScript files are not valid TypeScript.** They
contain `kotoba-datomic` in identifier position:

```ts
import { kotoba-datomic } from "@etzhayyim/sdk";   // kotoba/src/feature/index.ts:22
type FleetCell = kotoba-datomic.FleetCell;
```

A JavaScript identifier cannot contain a `-`, so the parser reads `kotoba` minus
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
(`etzhayyim/root@45b5906`,
`60-apps/etzhayyim-project-maps/kotoba/src/feature/index.ts:22`), and custody
here is exact ([`docs/verify-custody.cljk`](docs/verify-custody.cljk)). So the
fix belongs upstream too.

## One tracked file has no target

`kotoba/CHARTER-RIDER.md` is a **symlink to `../../../CHARTER-RIDER.md`** — the
monorepo root, which the extraction left behind. It is **dangling**: the target
does not exist and cannot, because it was never inside this subtree.

It is worth naming because it is a trap for measuring code: `fs.statSync`
follows the link and throws `ENOENT`, so a byte count written the obvious way
turns a whole verification run into "could not answer". The verifier measures
with `lstat` (counting the 25-byte link itself) and **asserts the dangling count
is 1**, so the fact is recorded rather than tripping over. An earlier count of
this directory, "58 files / 338,013 B", was this same file excluded; the 25-byte
difference is the link text.

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
| building the `maps-ui` Worker | `wrangler.jsonc` `alias` maps 8 module specifiers to absolute paths under `/Users/junkawasaki/github/etzhayyim-apps-etzhayyimcojp/` | **no, and not on the author's machine either** — 0 of the 8 targets exist there today. Its SDK is absent from npm and from the workspace |
| building the `maps-tile-server` Worker | `shadow-cljs release worker` → `dist/worker.js`, then `nbb scripts/smoke-worker.cljk` | **fixed** by the migration. This is the green path in the repository today |
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
**The migration did not touch this file** and does not change the exposure.

## Tests that exist but have no runner

`appview/maps-ui-uqpel6i6/` ships 5 `*.test.ts` files under `src/` (23 cases)
and 5 Playwright specs under `svelte/e2e/` (22 cases). Its `package.json`
declares no `test` script, and `svelte/package.json` declares none either — so
nothing runs them. They are not counted in the 235 above.

The migrated appview does have a runner: `test/maps/tile/route_test.cljk`,
6 tests / 42 assertions, run by nbb with no build and no browser
(`docs/operator-quickstart.md` §3).

## Provenance

Extracted from `etzhayyim/root@45b5906`, path
`60-apps/etzhayyim-project-maps`, per `migration.edn`, which now declares three
kinds of divergence and `docs/verify-custody.cljk` checks all three **plus the
declarations themselves**:

| declaration | count | meaning |
|---|---|---|
| `:canonical-files` | 16 | added by this repository; must be tracked and absent upstream |
| `:modified-by-migration` | 3 | inherited but deliberately changed; must differ from upstream — a declared file that is byte-identical FAILS |
| `:removed-by-migration` | 11 | inherited but deliberately removed; must be absent here and present upstream — a declared file that is still tracked FAILS |

The 200 remaining inherited blobs match upstream path-for-path and SHA-for-SHA.

`CLAUDE.md` (48,528 B) is the pre-extraction design record and its relative
links point back into the monorepo; it opens by declaring the actor migrated to
`orgs/etzhayyim/com-etzhayyim-maps`, so treat it as history, not as
instructions for this tree. **The migration did not change it**: its
"TS Native" / "Hono + Svelte CSR" rows describe `maps-ui`, which was not
migrated, so they are still accurate. Licensing is Apache-2.0 plus the
etzhayyim Charter Compliance Rider v3.1 (`NOTICE`, `kotoba/CHARTER-RIDER.md` —
the dangling symlink above).
