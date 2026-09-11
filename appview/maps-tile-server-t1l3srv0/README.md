# maps-tile-server (nanoid `t1l3srv0`)

**この appview は 2026-08-19 に TypeScript/Svelte から ClojureScript へ移行した**
（[`../../docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn`](../../docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn)）。
このページは移行前の内容を保存したものではない —— 移行前の記述は、deploy された
ことの無い実装を「Routes」として説明していた。git 履歴に残っている。

## deploy されるものは、いま読んでいるソースである

```
../../src/maps/tile/route.cljk    判断（どの handler が答えるか） ← 純 .cljc、テスト対象
../../src/maps/tile/view.cljk     ページ（jp-go-dds の hiccup）   ← 純 .cljc、テスト対象
../../src/maps/tile/worker.cljk   Request/Response に触る唯一の層
        ↓ shadow-cljs :target :esm
../../dist/worker.js              ← wrangler.jsonc の "main" が指すもの
```

移行前の `main` は `svelte/.svelte-kit/cloudflare/_worker.js` を指していた。
**その dir は tree に無い**（`.gitignore` が `.svelte-kit/` を無視している）。
一方で読み手が開く `src/app.ts` は**どの bundle にも入っていなかった**。

## この Worker が答えるもの

| METHOD | PATH | 何をするか | 出自 |
|---|---|---|---|
| GET | `/` | この appview の説明ページ（route 表と env のキーを描く） | 移行前から |
| POST | `/xrpc/:nsid` | XRPC を MCP router へ中継する | 移行前から |
| OPTIONS | `/xrpc/*` | CORS preflight | 移行前から |
| GET | `/health` | 生存確認 JSON | **移行で追加** |

出所は `../../src/maps/tile/route.cljk` の `routes` で、**ページもそこから描く**。
移行前のページは `routeCount: 0` / `routes: []` / `vars: []` を literal で持って
おり、隣の `wrangler.jsonc` が route 2 パターン・var 11 を宣言していることに
気づけなかった。

`/health` は移行前の SvelteKit には**無かった**（`src/app.ts` は宣言していたが、
それは deploy されていない）。移してきたものではなく足したものなので、route 表の
`:route/origin` が `:added` と持ち、ページにもそう出る。

## この Worker が答えないもの（黙って消していない）

`src/app.ts`（284 行）と `src/pmtiles.ts`（402 行）は MVT タイル配信 —— PMTiles v3
ヘッダ解析、Hilbert 曲線の `(z,x,y) → tile_id`、ディレクトリ varint デコーダ、
R2 の range read —— を実装していた。**移していない。**

| PATH | 理由（実測） |
|---|---|
| `/v1/{z}/{x}/{y}.pbf` | R2 binding `TILES` が `wrangler.jsonc` に無い |
| `/v1/manifest.json` | R2 binding `TILES` / KV binding `TILE_MANIFEST` が無い |
| `/v1/style.json` | KV binding `TILE_MANIFEST` が無い |
| `/_worker/health` | `src/app.ts` の別名 health。`/health` に一本化した |
| `/_app/meta` | `src/app.ts` の capability 要約。`/` が同じ役割を果たす |

`wrangler.jsonc` には `r2_buckets` も `kv_namespaces` も**1 つも無い**。つまり
このコードは deploy されたことが無く、deploy しても binding が無くて動かない。
動かない経路を移植して「移行済み」と言わないための除外である。表そのものは
`route.cljc` の `withheld` に理由付きで残っており、ページにも出る。復活させる
なら binding の宣言と PMTiles の実在が先で、それは別の決定である。

`TILE_MANIFEST_KEY` / `TILE_MANIFEST_TTL_SECONDS` / `TILE_ATTRIBUTION` の 3 つの
var は、その動かない経路が読むはずだった値である。**移行では消していない** ——
今日は誰も読まないが、移行前も読んでいなかった。

## 到達性（移行では直らない）

| ホスト | 役割 | DNS |
|---|---|---|
| `tiles-maps.etzhayyim.com` | 公開ホスト（wrangler の route） | **NXDOMAIN** |
| `t1l3srv0.etzhayyim.com` | 同（nanoid 側） | **NXDOMAIN** |
| `mcp.etzhayyim.com` | `/xrpc/:nsid` の中継先 | **NXDOMAIN** |

deploy 先も中継先も、いま存在しない。`/xrpc/` は到達できなければ **502 を返し、
試した URL を本文に書く** —— 成功と同じ形で隠さない。自分で引くこと
（コマンドは `../../docs/operator-quickstart.md` §7）。

## 中継の header — 移行で直していない欠陥

`/xrpc/:nsid` は client の header を（`host` を落として）そのまま上流へ渡す。
`authorization` も `cookie` も渡る。**移行前の `+server.ts` がそうしていた**ので
そのまま移した。中継先の header 方針は移行とは別の決定である。変えたのは
`x-etzhayyim-bff` の値だけ（`sveltekit-edge-bff` → `cljs-edge-bff`。SvelteKit で
ないものが SvelteKit を名乗るのは、直せる嘘だから）。

## 検査とビルド

`../../docs/operator-quickstart.md` の §3〜§7。要点だけ:

```bash
cd ../..                                          # repo root
npx nbb docs/verify-docs-claims.cljk              # 文書の数値が実測と一致するか
npx nbb docs/verify-custody.cljk                  # 申告なしに upstream から動いていないか
node ~/github/com-junkawasaki/scripts/resource-guard.mjs run build -- npx shadow-cljs release worker
npx nbb scripts/smoke-worker.cljk dist/worker.js  # ビルドした bundle を実際に叩く
```
