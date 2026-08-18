# Operator quickstart

Walked end-to-end on 2026-08-18 from a fresh clone of this branch, on macOS
15 (Darwin 25.3.0) with node v26.3.0 / npm 11.16.0 / python 3.14.5. Every
figure below is that walk's output. Where a step fails, this document says so
and does not offer a workaround it has not run.

Read [`../README.md`](../README.md) first. The short version: one of the four
subsystems installs cleanly, and the other three are blocked on causes outside
this repository.

## 1. Clone and check what you were given

```bash
git clone git@github.com:cloud-itonami/app-maps.git && cd app-maps
git ls-files | wc -l          # 219
nbb docs/verify-custody.cljs     # PASS — 211 blobs match etzhayyim/root@45b5906
nbb docs/verify-docs-claims.cljs # PASS — the numbers in README.md are current
```

`verify-custody.cljs` needs network (it asks GitHub for the upstream subtree)
and `gh` authenticated. Both verifiers exit **3**, not 0 and not 1, when they
cannot answer — a network failure must not read as a clean tree.

## 2. Build a toolchain, because `npm install` does not work here

The declared install fails, and it fails for a reason you cannot fix in this
repository:

```bash
cd kotoba && npm install
# npm error code EALLOWSCRIPTS
# npm error --allow-scripts is not allowed in project-scoped installs.
# npm error git dep preparation failed
```

`@etzhayyim/sdk@0.1.0-alpha` points `main` at `./dist/index.js`, commits no
`dist/`, and builds it from `prepare: tsc`. npm 11 will not run that script for
a project-scoped git dependency. Install the four dev tools somewhere else and
carry them in:

```bash
mkdir -p /tmp/maps-toolchain && cd /tmp/maps-toolchain
printf '{"name":"maps-scratch","private":true,"type":"module"}\n' > package.json
npm install --no-audit --no-fund vitest@^4.1.0 typescript@^5.6.0 tsx@^4.19.0 @types/node@^22.0.0
# added 50 packages in 10s
cp -R node_modules <path-to-clone>/kotoba/node_modules
```

`.gitignore` keeps that tree out of git; confirm with `git status` before you
commit anything.

## 3. Run the suite as it is declared, then as it is written

```bash
cd kotoba && npx vitest run
#  Test Files  1 passed (1)
#       Tests  1 passed (1)
```

That one test is `expect(true).toBe(true)`. `vitest.config.ts` collects only
`test/**/*.test.ts`, and `kotoba/test/` holds nothing else. The 18 real suites
are under `src/`. To see them, point vitest at them **without editing the
committed config**:

```bash
cat > /tmp/vitest.src.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
EOF
cp /tmp/vitest.src.config.ts ./vitest.src.config.ts
npx vitest run --config vitest.src.config.ts
#  Test Files  11 failed | 7 passed (18)
#       Tests  235 passed (235)
rm vitest.src.config.ts
```

Seven `types.test.ts` suites pass — 235 assertions, zero failures. Eleven
suites never reach an assertion: seven die in the parser on
`import { kotoba-datomic }`, four on `Cannot find package '@etzhayyim/sdk'`.
README.md §"What the test suite actually runs" explains why widening the glob
in the committed config would not be an improvement on its own.

Typecheck reports the same nine files:

```bash
npx tsc --noEmit; echo $?    # 2
# 47 errors, all TS1005 / TS1128 / TS1434, in 9 files
```

Do not read `$?` through a pipe. `npx tsc --noEmit | head` reports **head's**
exit status, which is 0, and the typecheck looks clean when it is not.

## 4. The subsystem that works

```bash
cd appview/maps-tile-server-t1l3srv0
npm install            # added 2 packages in 1s
npx tsc --noEmit; echo $?    # 0 — zero errors
```

This is the whole green path in the repository today. `npm install` writes a
`package-lock.json` that is not tracked; decide deliberately before committing
it. The Worker still cannot be **deployed** — see §6.

## 5. The Python pods

```bash
cd bulk-ingest
git ls-files '*.py' | while read -r f; do python3 -m py_compile "$f" || echo "FAIL $f"; done
# all 21 files compile
```

Compiling is not running. `requirements.txt` was not installed on this walk and
no pod was executed, so nothing here is a statement about whether the dumpers
work against live sources. `k8s/` holds 13 manifests; none were applied.

## 6. Deployment — not attempted, and why

Neither Worker was deployed and neither could have been.

`appview/maps-ui-uqpel6i6/wrangler.jsonc` rewrites 8 module specifiers to
absolute paths under `/Users/junkawasaki/github/etzhayyim-apps-etzhayyimcojp/`,
a monorepo checkout that does not exist on this machine — 0 of the 8 targets
resolve — and its SvelteKit half cannot install at all
(`EUNSUPPORTEDPROTOCOL`, `workspace:*` with no workspace root in this repo).

Every hostname either Worker claims is unresolvable:

```bash
for h in maps.etzhayyim.com uqpel6i6.etzhayyim.com \
         tiles-maps.etzhayyim.com t1l3srv0.etzhayyim.com \
         mcp.etzhayyim.com maps-langserver.etzhayyim.com; do
  printf '%-32s %s\n' "$h" "$(dig +short "$h" | head -1)"
done
# all six print nothing; only the apex etzhayyim.com resolves
```

Run that yourself rather than trusting this page: the verifiers deliberately do
not check DNS, because a lookup that cannot be performed offline would return
the same value as a lookup that found nothing, and "no network" would be
recorded as "host is gone".

## 7. Before you change anything

`migration.edn` declares which files this repository added to what it was
given; `docs/verify-custody.cljs` fails if that declaration stops being true.
If you add a file, add it to `:canonical-files` in the same commit — otherwise
the next custody run reports a divergence that is really just an undeclared
addition, and the real signal gets trained away.
