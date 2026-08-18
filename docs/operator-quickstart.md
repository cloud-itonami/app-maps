# Operator quickstart

Walked end-to-end on 2026-08-18/19 from a fresh worktree of this branch, on
macOS 15 (Darwin 25.3.0) with git 2.51.0 / node v26.3.0 / npm 11.16.0 /
nbb v1.4.208 / Clojure CLI 1.12.5.1654 / wrangler 4.124.0 / python 3.14.5.
Where a step fails, this document says so and does not offer a workaround it
has not run.

**Which figures come from which walk.** §1 and §3–§9 were re-walked on
2026-08-19 and every number in them is that run's output. **§2 was not
re-walked**: its `npm install` / `vitest` / `tsc` figures are carried unchanged
from the 2026-08-18 walk recorded in
[`../docs/adr/2608180800-app-maps-inherited-defects.edn`](adr/2608180800-app-maps-inherited-defects.edn).
The migration did not touch `kotoba/`, and `docs/verify-custody.cljs` shows its
59 files are byte-identical to upstream — but that is an argument that they
*should* be unchanged, not a re-measurement, so they are labelled rather than
claimed. §8 (Python) was re-run: 21 files, 0 failures, python 3.14.5.

Read [`../README.md`](../README.md) first. The short version: one of the two
appviews is now a ClojureScript Worker that builds and answers; everything
else in the repository is blocked on causes outside it.

## 1. Clone and check what you were given

```bash
git clone git@github.com:cloud-itonami/app-maps.git && cd app-maps
git ls-files | wc -l               # 216
npx nbb docs/verify-custody.cljs      # PASS — 200 blobs match etzhayyim/root@45b5906
npx nbb docs/verify-docs-claims.cljs  # PASS — 39 checks
```

`verify-custody.cljs` needs network (it asks GitHub for the upstream subtree)
and `gh` authenticated. Both verifiers exit **3**, not 0 and not 1, when they
cannot answer — a network failure must not read as a clean tree.

`migration.edn` now declares three kinds of divergence from upstream —
`:canonical-files` (added), `:modified-by-migration` (changed),
`:removed-by-migration` (removed) — and the custody verifier checks the
**declarations themselves**, so writing one does not buy silence:

```
  ok   :removed-by-migration と申告しながら tracked のまま 0
  ok   :modified-by-migration と申告しながら upstream と同一 0
  ok   :canonical-files と申告しながら upstream にも在る 0
```

## 2. `kotoba/` — a toolchain, because `npm install` does not work here

> **Not re-walked on 2026-08-19.** The outputs in this section are from the
> 2026-08-18 walk. Nothing in `kotoba/` changed since (custody verifies it),
> but nobody re-ran these commands.

This subsystem was not migrated. Its declared install fails, for a reason you
cannot fix in this repository:

```bash
cd kotoba && npm install
# npm error code EALLOWSCRIPTS
# npm error --allow-scripts is not allowed in project-scoped installs.
# npm error git dep preparation failed
```

`@etzhayyim/sdk@0.1.0-alpha` points `main` at `./dist/index.js`, commits no
`dist/`, and builds it from `prepare: tsc`. npm 11 will not run that script for
a project-scoped git dependency. Install the dev tools somewhere else and carry
them in:

```bash
mkdir -p /tmp/maps-toolchain && cd /tmp/maps-toolchain
printf '{"name":"maps-scratch","private":true,"type":"module"}\n' > package.json
npm install --no-audit --no-fund vitest@^4.1.0 typescript@^5.6.0 tsx@^4.19.0 @types/node@^22.0.0
cp -R node_modules <path-to-clone>/kotoba/node_modules
```

`.gitignore` keeps that tree out of git. Then, as it is declared and as it is
written:

```bash
cd kotoba && npx vitest run
#  Test Files  1 passed (1)   ← that one test is expect(true).toBe(true)
npx tsc --noEmit; echo $?      # 2 — 47 errors, all TS1005/TS1128/TS1434, in 9 files
```

Do not read `$?` through a pipe. `npx tsc --noEmit | head` reports **head's**
exit status, which is 0, and the typecheck looks clean when it is not.
`README.md` §"What the test suite actually runs" explains the 18 suites that
`vitest.config.ts` never collects.

## 3. The migrated appview — tests, with no build and no browser

Judgement (`route.cljc`) and rendering (`view.cljc`) are pure `.cljc`, so nbb
runs them alone:

```bash
K=~/github/com-junkawasaki/orgs/kotoba-lang
CP="src:test:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
cat > /tmp/run.cljs <<'EOF'
(require '[cljs.test :refer [run-tests]] 'maps.tile.route-test)
(run-tests 'maps.tile.route-test)
EOF
npx --yes nbb --classpath "$CP" /tmp/run.cljs
```

Actual output:

```
Testing maps.tile.route-test

Ran 6 tests containing 42 assertions.
0 failures, 0 errors.
```

What it pins: `/xrpc/` is 400 for the **empty** nsid only (`/xrpc/a/b` is
relayed, as the SvelteKit rest parameter did — narrowing it would be a policy
change, not a migration); the MCP router URL resolution; the
`result` / `structuredContent` unwrapping; that `routes` and `withheld` never
overlap and every withheld route carries a reason; and that the page is drawn
**from the route table**.

That last one had to be repaired before it meant anything. Asserting "the path
appears in the page" could not fail: emptying the route table left `/health`
and `/` green, because both occur as substrings elsewhere (a withheld reason
reads「`/health` に一本化した」). The assertion now looks for the table cell,
`<span class="tile-mono">/health</span>`, and emptying the table turns all four
red.

## 4. Render the page and score it

```bash
K=~/github/com-junkawasaki/orgs/kotoba-lang
CP="src:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
cat > /tmp/render.cljs <<'EOF'
(require '["node:fs" :as fs] '[maps.tile.view :as view] '[maps.tile.route :as route])
(let [css (.readFileSync fs (str (.-DDS js/process.env) "/resources/jp_go_dds/dds.css") "utf8")]
  (.writeFileSync fs "/tmp/maps-tile-page.html"
    (view/render {:css css :routes route/routes :withheld route/withheld
                  :vars [:APP_NANOID :APP_UI_TYPE :TILE_ATTRIBUTION]
                  :mcp-url "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message"}))
  (println "ok"))
EOF
DDS="$K/jp-go-digital-design-system" npx --yes nbb --classpath "$CP" /tmp/render.cljs

cd $K/design-quality && npx --yes nbb -m design-quality.cli score /tmp/maps-tile-page.html --min 95
```

Actual output (tail):

```
  100.00  /tmp/maps-tile-page.html
aggregate: 100.00
axes scored: 10 (viewport, safe-area, dynamic-viewport, tap-targets, focus-visible,
                 reduced-motion, overflow-guard, color-scheme, responsive, semantics)
NOT scored: input-zoom, contrast — pass --extra-axes to include the optional ones
gate: aggregate 100.00 >= min 95.00 -> PASS
```

`--extra-axes` scores all 12 and also returns 100.00.

**Read that number for what it is.** The same page rendered with the design
system's CSS removed entirely scores **96.63 and still passes the gate**. This
score does not say a design system is present; only the smoke's stylesheet
check does (§6). What the gate does catch: strip the `<meta name=viewport>`
from the scored file and it drops to **88.76 → FAIL**.

## 5. Build the bundle

**High-load builds are limited to one at a time** across this workspace
(the resource governor in the superproject `CLAUDE.md`). Do not call the
compiler directly:

```bash
node ~/github/com-junkawasaki/scripts/resource-guard.mjs run build -- \
  npx shadow-cljs release worker
ls -la dist/worker.js
```

Exit 2 from the guard is **queued, not failed** — another session holds the
lock. Retry; do not route around it.

Actual output (tail):

```
[:worker] Build completed. (55 files, 12 compiled, 0 warnings, 9.06s)
-rw-r--r--  247656  dist/worker.js
sha256 242c733402992693d35e76ad7d6e7a3956246cd362a291e505d83d0ff67c9ca4
```

### A broken var **fails** the build (measured 2026-08-19)

`shadow-cljs.edn` carries `:warnings-as-errors true` **inside
`:compiler-options`**. Without it, an undeclared or renamed var is a *warning*,
shadow exits 0, and it ships the bundle anyway.

Renaming `route/dispatch` to `route/dispatch-nonexistent` and rebuilding:

```
------ ERROR -------------------------------------------------------------------
 File: src/maps/tile/worker.cljs:124:44
```

| | exit | `dist/worker.js` sha256 | bytes |
|---|---|---|---|
| before the rename | **0** | `242c7334…f67c9ca4` | 247656 |
| after the rename | **1** | `242c7334…f67c9ca4` (**unchanged**) | 247656 |
| restored, rebuilt | **0** | `242c7334…f67c9ca4` | 247656 |

A failed build ships nothing — the sha not moving is what says so.

The key must be under `:compiler-options`, **not `:build-options`**; shadow
reads `[:compiler-options :warnings-as-errors]` and silently ignores the other
placement. Measured here, with the key moved *and* the same var broken:

```
[:worker] Build completed. (55 files, 1 compiled, 1 warnings, 6.54s)   ← exit 0
 Use of undeclared Var maps.tile.route/dispatch-nonexistent
sha256 26bbca65…471aa497   ← a DIFFERENT bundle was written and shipped
```

and that bundle throws on import: `Cannot read properties of undefined
(reading 'h')`. So the misplacement is not cosmetic — it restores exactly the
failure the option exists to prevent. `docs/verify-docs-claims.cljs` asserts
the placement by **reading `shadow-cljs.edn` as EDN**, never by grepping: a
grep would match the comment that explains this.

## 6. Exercise the bundle you built

```bash
npx --yes nbb scripts/smoke-worker.cljs dist/worker.js
```

24 checks, actual output (abridged):

```
PASS	default export has fetch
PASS	GET / status	expected=200	actual=200
PASS	page advertises /xrpc/:nsid
PASS	page hides other var values	expected=false	actual=false
PASS	page shows the relay target it uses
PASS	page uses the design system components
PASS	page carries the stylesheet itself
PASS	single-segment xrpc is relayed (502 unreachable)
PASS	multi-segment xrpc is relayed too, not rejected
PASS	withheld tile route is 404
OK	the built bundle answers as the route table says
```

**No bundle → exit 2** ("could not answer"), which is neither a pass nor a
failure.

Two of these checks exist as pairs on purpose:

- **design system.** `class="dads-table"` says the view called the library;
  `--color-primitive-blue` says the stylesheet is actually in the bundle. They
  are different claims. Measured on this page: `dads-table` appears 79× with
  the CSS and **11×** without (it never reaches 0 — it is markup);
  `--color-primitive-blue` appears 45× with and **0×** without. Rebuilding with
  `(rc/inline "jp_go_dds/dds.css")` replaced by `""` turns the second red and
  leaves the first green.
- **env values.** One sentinel must *not* appear (a value put on `APP_UI_TYPE`)
  and one must (the relay target, on an `.invalid` host so the check needs no
  DNS). One alone would admit both "hide everything" and "show everything".
  Leaking values turns the first red and leaves the second green; dropping the
  relay line from the page does the reverse.

### 6.1 Run it on the real Workers runtime

Stronger than importing it in Node — this is `workerd`:

```bash
cd appview/maps-tile-server-t1l3srv0
npx --yes wrangler@latest dev --local --port 8847 --ip 127.0.0.1
# in another shell:
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8847/
curl -s http://127.0.0.1:8847/health
curl -s -X POST http://127.0.0.1:8847/xrpc/a/b
```

Actual output:

```
200 text/html; charset=utf-8
{"ok":true,"app":"maps-tile-server","runtime":"cljs","routes":["/","/xrpc/:nsid","/xrpc/*","/health"]}
{"error":"MCP router unreachable","detail":"internal error; reference = …",
 "url":"https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message"}   ← 502
```

and, for the rest of the surface: `POST /xrpc/` → 400, `OPTIONS /xrpc/x` → 204,
`GET /v1/0/0/0.pbf` → 404, `POST /health` → 405.

`compatibility_flags` (`nodejs_compat` / `nodejs_als`) came from SvelteKit's
adapter-cloudflare and this bundle does not need them. **They were removed only
after this run showed every route answering without them** — not by assumption.

## 7. Reachability — run this yourself

```bash
for h in maps.etzhayyim.com uqpel6i6.etzhayyim.com \
         tiles-maps.etzhayyim.com t1l3srv0.etzhayyim.com \
         mcp.etzhayyim.com maps-langserver.etzhayyim.com etzhayyim.com; do
  printf '%-32s %s\n' "$h" "$(dig +short "$h" | head -1)"
done
```

On this walk the first six printed nothing and `etzhayyim.com` printed
`172.67.179.128`. The verifiers deliberately do **not** check DNS: a lookup
that cannot be performed offline returns the same value as a lookup that found
nothing, so "no network" would be recorded as "the host is gone".

## 8. The Python pods

Run this from the repository root, not from `bulk-ingest/` — two of the 21
Python files (`runpod-endpoint/handler.py`, `runpod-endpoint-gsplat/handler.py`)
live outside it:

```bash
git ls-files '*.py' > /tmp/pyf.txt
wc -l < /tmp/pyf.txt      # 21
while IFS= read -r f; do python3 -m py_compile "$f" || echo "FAIL $f"; done < /tmp/pyf.txt
# no FAIL lines: all 21 compile
find . -name __pycache__ -prune -exec rm -rf {} +
```

Use `while read` rather than `for f in $(...)`: zsh does not word-split
unquoted expansions, so the `for` form passes the whole list as one filename.

Compiling is not running. `requirements.txt` was not installed on this walk and
no pod was executed. `bulk-ingest/k8s/` holds 13 manifests; none were applied.

## 9. Deployment — not attempted

`wrangler deploy` was **not run**. §6.1 goes as far as `wrangler dev --local`,
which starts nothing outside this machine.

Even if it were run, the tile-server's routes (`tiles-maps.etzhayyim.com`,
`t1l3srv0.etzhayyim.com`) do not resolve, and the relay target
`mcp.etzhayyim.com` does not either — `/xrpc/` would answer **502 naming the
URL it tried**, which is the point: it does not hide an unreachable upstream
behind a 200.

`appview/maps-ui-uqpel6i6/` cannot be deployed at all: its `alias` block
rewrites 8 module specifiers to absolute paths under a monorepo checkout that
does not exist, its SvelteKit half cannot install (`workspace:*`), and the SDK
that defines its entire HTTP surface is not in this repository, on this
machine, or in the surrounding workspace.

The superproject's deploy guard additionally refuses `wrangler deploy` from a
checkout behind `origin/main`.

## 10. Before you change anything

`migration.edn` declares what this repository added to, changed in, and removed
from what it was given; `docs/verify-custody.cljs` fails if any of those
declarations stops being true — **including a declaration that is itself
false**. If you add a file, add it to `:canonical-files` in the same commit;
if you remove an inherited one, add it to `:removed-by-migration`. Otherwise
the next custody run reports a divergence that is really an undeclared change,
and the real signal gets trained away.
