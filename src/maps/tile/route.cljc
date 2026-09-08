(ns maps.tile.route
  "maps-tile-server appview — どのハンドラが答えるかを、データと純関数で決める。

  `.cljc` なのは意図的である。edge worker で検査する価値があるのは routing で
  あり、ここならブラウザもビルドもネットワークも無しに検査できる。
  Request/Response に触るのは `maps.tile.worker` だけで、そこにはこのファイルが
  既に決めたこと以外を置かない。

  ingress capability が qualify したら（`:native-aot`/`:wasm-aot` は今日
  pending —— ADR-2606290000）最初に `.kotoba` へ移るのもここである。route 表は
  スカラと文字列に対する決定で、その移行を生き延びる形をしている。"
  (:require [kotoba.lang.text :as str]))

(def routes
  "この Worker が実際に答える公開面を、データとして持つ。ランディングページは
  **この値を描く**ので、答えるものと表示がずれる余地が無い。

  移行前のページ（`svelte/src/routes/+page.svelte`）は `routeCount: 0`・
  `routes: []`・`vars: []` を literal で持っていて、隣の `wrangler.jsonc` が
  route 2 パターン・var 11 を宣言していることに気づけなかった。

  `:route/origin` は **移行前から deploy されていた面か、移行で足した面か**を
  区別する。足したものを「移してきた」と読ませないために値として持つ。"
  [{:route/path "/" :route/method :get :route/kind :page :route/origin :ported
    :route/doc "この appview の説明ページ"}
   {:route/path "/xrpc/:nsid" :route/method :post :route/kind :proxy :route/origin :ported
    :route/doc "XRPC を MCP router へ中継する"}
   {:route/path "/xrpc/*" :route/method :options :route/kind :cors :route/origin :ported
    :route/doc "CORS preflight"}
   {:route/path "/health" :route/method :get :route/kind :json :route/origin :added
    :route/doc "生存確認。移行で足した（下記）"}])

(def withheld
  "**移していない面**を、黙って消さずにデータとして残す。

  `src/app.ts` と `src/pmtiles.ts`（686 行）は MVT タイル配信を実装していたが、
  `wrangler.jsonc` の `main` は一度もそこを指しておらず（SvelteKit のビルド出力を
  指していた）、そのコードが要求する binding —— R2 `TILES` と KV `TILE_MANIFEST`
  —— は `wrangler.jsonc` に **1 つも宣言されていない**。つまり deploy されたことが
  無く、deploy しても binding が無くて動かない。

  動かない経路を移植して「移行済み」と言わないために、ここに理由付きで残す。
  binding が宣言され、上流の PMTiles が実在する時点で `routes` に足す。"
  [{:route/path "/v1/{z}/{x}/{y}.pbf" :withheld/reason "R2 binding TILES が wrangler.jsonc に無い"}
   {:route/path "/v1/manifest.json"   :withheld/reason "R2 binding TILES / KV binding TILE_MANIFEST が無い"}
   {:route/path "/v1/style.json"      :withheld/reason "KV binding TILE_MANIFEST が無い"}
   {:route/path "/_worker/health"     :withheld/reason "src/app.ts の別名 health。/health に一本化した"}
   {:route/path "/_app/meta"          :withheld/reason "src/app.ts の capability 要約。/ が同じ役割を果たす"}])

(defn- xrpc-nsid
  "`/xrpc/<nsid>` の nsid。**空文字だけが nil**。

  多段パス（`/xrpc/a/b`）も通す。移行前の SvelteKit route は rest parameter
  `[...path]` で受けており、`a/b` をそのまま tool 名として転送していた
  （`svelte/src/routes/xrpc/[...path]/+server.ts`: `const nsid = event.params.path;
  if (!nsid) return 400`）。ここで 1 セグメントに絞ると挙動が変わる —— NSID に
  `/` は現れないので上流で失敗するだけだが、**それは移行ではなく方針変更**であり、
  移行の commit に紛れ込ませるべきものではない。絞るなら別の決定として記録する。"
  [path]
  (when (str/starts-with? path "/xrpc/")
    (let [rest' (subs path (count "/xrpc/"))]
      (when (seq rest') rest'))))

(defn dispatch
  "method + path → 何をするか。Request も Response も知らない。

  返すのは `{:action …}` で、`:action` は
  `:page` / `:health` / `:xrpc` / `:cors-preflight` / `:not-found` /
  `:method-not-allowed` / `:bad-request` のいずれか。"
  [method path]
  (let [m (keyword (str/lower (or method "get")))
        p (or path "")]
    (cond
      (and (= m :options) (str/starts-with? p "/xrpc/"))
      {:action :cors-preflight}

      (str/starts-with? p "/xrpc/")
      (if (= m :post)
        (if-let [nsid (xrpc-nsid p)]
          {:action :xrpc :nsid nsid}
          {:action :bad-request :reason "Missing XRPC method"})
        {:action :method-not-allowed :allow "POST, OPTIONS"})

      (= p "/health") (if (= m :get)
                        {:action :health}
                        {:action :method-not-allowed :allow "GET"})
      (= p "/")       (if (= m :get)
                        {:action :page}
                        {:action :method-not-allowed :allow "GET"})
      :else {:action :not-found})))

(defn mcp-router-url
  "env の設定 → MCP router の URL。末尾スラッシュは落とす。

  既定値・優先順位とも移行前の `+server.ts` の `mcpRouterUrl()` そのままで、
  空白だけの値は未設定として扱う。既定値をここに焼くのは、設定が無いときに
  黙って何処かへ POST しないためではなく、**どこへ行くのかを 1 箇所で読める
  ようにする**ためである。"
  [{:keys [AGENTGATEWAY_MCP_ROUTER_URL MCP_ROUTER_URL]}]
  (let [pick (fn [s] (when (and (string? s) (seq (str/trim s))) (str/trim s)))]
    (-> (or (pick AGENTGATEWAY_MCP_ROUTER_URL)
            (pick MCP_ROUTER_URL)
            "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message")
        (str/replace #"/+$" ""))))

(defn unwrap-mcp
  "MCP router の応答から、呼び手に返す値を取り出す。

  `{:result {:structuredContent X}}` → X、`{:result X}` → X、それ以外は素通し。
  `{:error …}` は呼び出し側が 502 にするので、ここでは判定だけ返す。
  移行前の `+server.ts` 末尾 4 行と同じ剥がし方である。"
  [payload]
  (cond
    (and (map? payload) (contains? payload :error))
    {:ok? false :error (get-in payload [:error :message] "MCP router returned an error")
     :upstream payload}

    (and (map? payload) (contains? payload :result))
    (let [r (:result payload)]
      {:ok? true :value (if (and (map? r) (contains? r :structuredContent))
                          (:structuredContent r)
                          r)})

    :else {:ok? true :value payload}))
