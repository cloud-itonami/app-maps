(ns maps.tile.view
  "maps-tile-server appview の説明ページ。純 hiccup。

  基盤は `jp-go-dds`（デジタル庁デザインシステム）—— superproject の skill
  `kotoba-uiux` が定める新規 UI の base。色・寸法は `--hig-*` トークン契約で
  書き、raw hex も px フォントサイズも置かない。

  **表示する事実は引数で受け取る。ページの中に焼かない。** これは装飾の都合では
  なく、移行前のページが持っていた欠陥そのものへの答えである —— あちらは
  `routeCount: 0` / `routes: []` / `vars: []` を literal で持っており、隣の
  `wrangler.jsonc` が route 2 パターン・var 11 を宣言していることに気づけなかった。
  ここでは route 表と設定を渡す側が持ち、ページは描くだけなので、両者がずれる
  余地が無い。"
  (:require [jp-go-dds.core :as dds]
            [jp-go-dds.page :as page]
            [jp-go-dds.tokens :as tokens]
            [clojure.string :as str]))

(def app-css
  "app 固有の最小 CSS。`--hig-*` 契約だけを使う（bridge が DADS の上に再定義する）。
  DADS を base にした app の下には `shitsuke.hig` が居ないので、bridge が運んで
  いないトークンは何にも解決しない —— 使うのは運ばれているものの中だけ。"
  (str/join
   "\n"
   [".tile-lede { color: var(--hig-color-secondary-label); max-width: 42rem; }"
    ".tile-note { color: var(--hig-color-secondary-label); font-size: var(--hig-text-footnote-font-size); }"
    ".tile-mono { font-family: var(--hig-font-mono); }"]))

(defn- origin-label [origin]
  (case origin
    :ported "移行前から"
    :added  "移行で追加"
    (name (or origin :unknown))))

(defn- route-rows [routes]
  (mapv (fn [r]
          [(str/upper-case (name (:route/method r)))
           [:span {:class "tile-mono"} (:route/path r)]
           (:route/doc r)
           (dds/chip-label (origin-label (:route/origin r))
                           {:color (if (= :ported (:route/origin r)) "blue" "gray")})])
        routes))

(defn- withheld-rows [withheld]
  (mapv (fn [r] [[:span {:class "tile-mono"} (:route/path r)]
                 (:withheld/reason r)])
        withheld))

(defn body
  "opts:
   :routes    maps.tile.route/routes（この Worker が実際に答えるもの）
   :withheld  maps.tile.route/withheld（移していない面と、その理由）
   :vars      wrangler が渡した env のキー（**キー名だけ**。値は出さない）
   :mcp-url   XRPC の中継先（route/mcp-router-url の戻り値）
   :built-at  bundle のビルド時刻（不明なら nil）"
  [{:keys [routes withheld vars mcp-url built-at]}]
  (dds/container
   (dds/section
    {}
    (dds/heading 1 "maps-tile-server — appview")
    [:p {:class "tile-lede"}
     "地図タイル配信の公開面。タイルそのものの生成（tilemaker）と保管（R2 の "
     "PMTiles）はここには無い。この Worker が今日答えるのは下の表がすべてである。"])

   (dds/section
    {:title "この面が答えるもの"}
    (dds/table {:caption "公開ルート"
                :headers ["METHOD" "PATH" "何をするか" "出自"]
                :rows (route-rows routes)})
    [:p {:class "tile-note"}
     "この表は Worker の route 表そのものから描いている。ページに焼いた値では"
     "ないので、実際に答えるものと表示がずれない。"])

   (dds/section
    {:title "移していない面"}
    (dds/table {:caption "src/app.ts にあり、deploy されたことが無い面"
                :headers ["PATH" "移していない理由"]
                :rows (withheld-rows withheld)})
    [:p {:class "tile-note"}
     "移行前の wrangler.jsonc の main は SvelteKit のビルド出力を指しており、"
     "src/app.ts はどの bundle にも入っていなかった。加えて、そのコードが要求する "
     "R2 / KV の binding は 1 つも宣言されていない。動かない経路を移植して"
     "「移行済み」と言わないため、ここに理由付きで残している。"])

   (dds/section
    {:title "実行時の設定"}
    (if (seq vars)
      [:div (into [:p] (interpose " " (map (fn [k] (dds/chip-label (name k))) vars)))
       [:p {:class "tile-note"}
        "キー名のみ。**ただし下の中継先だけは値そのもの**（"
        [:span {:class "tile-mono"} "AGENTGATEWAY_MCP_ROUTER_URL"]
        "）—— どこへ中継するかは運用者が見る必要があるので意図的に出している。"
        "それ以外の値は出さない。"]]
      [:p {:class "tile-note"} "env が渡されていない（ローカル描画）。"])
    [:p {:class "tile-note"} "XRPC の中継先: "
     [:span {:class "tile-mono"} mcp-url]])

   (dds/section
    {:title "現在地"}
    [:p {:class "tile-lede"}
     "この appview は TypeScript/Svelte から ClojureScript へ移行済み。"
     "deploy される bundle は、いま読んでいるソースからコンパイルされたもので"
     "ある（docs/adr/0001）。"]
    (when built-at
      [:p {:class "tile-note"} "bundle build: " built-at]))))

(defn render
  "完全な HTML 文書。`css` は呼び出し側が渡す（ライブラリは I/O を持たない）。"
  [{:keys [css] :as opts}]
  (page/->page
   {:title "maps-tile-server — appview"
    :description "地図タイル配信 appview の公開面。route 表と実行時設定を、Worker 自身の値から描く。"
    :lang "ja"
    :css css
    :app-css (str tokens/bridge-css "\n" app-css)}
   (body opts)))
