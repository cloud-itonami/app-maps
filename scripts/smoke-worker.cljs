#!/usr/bin/env nbb
;; smoke-worker — 実際にビルドされた bundle を import して叩く。
;;
;; ここが「deploy される成果物」に触る唯一の検査である。テスト
;; (test/maps/tile/route_test.cljc) はソースの判断を固定するが、bundle が
;; 本当に Worker の形で答えるかは言えない —— export の形、shadow の
;; :advanced-optimization、`shadow.resource/inline` で焼いた CSS は、
;; どれもビルドを通って初めて存在する。
;;
;; Usage:  nbb scripts/smoke-worker.cljs [<dist/worker.js>]
;; Exit:   0 全て期待どおり · 1 期待と違う · 2 判定できなかった（bundle が無い等）

(require '["node:fs" :as fs] '["node:path" :as path] '["node:url" :as url]
         '[kotoba.lang.text :as str])

(def bundle
  "ESM の import は相対パスを package 名と読むので、必ず絶対パスに直してから
  file:// URL にする（`dist/worker.js` をそのまま渡すと『Cannot find package
  dist』になる。実測）。"
  (let [a (first (remove #(str/starts-with? % "--") *command-line-args*))]
    (.resolve path (or a "dist/worker.js"))))

(def failures (atom []))
(defn check! [label expected actual]
  (let [ok (= expected actual)]
    (println (str (if ok "PASS" "FAIL") "\t" label
                  "\texpected=" (pr-str expected) "\tactual=" (pr-str actual)))
    (when-not ok (swap! failures conj label))))

(when-not (.existsSync fs bundle)
  (println (str "UNDETERMINED\tno bundle at " bundle))
  (println "Refusing to report a pass: build it first (see docs/operator-quickstart.md §5).")
  (js/process.exit 2))

(def sentinel
  "env の VALUE がページに出ていないことを確かめるための印。実在しそうな値だと
  二つの問題がある: 他の文言と偶然一致しうるし、引用符ごと探すと renderer が
  \" を &quot; に escape するので**決して一致しない** —— つまり検査が構造的に
  落ちなくなる。だから印を使う。"
  "SENTINEL-4d7b1e")

(def router-url
  "中継先は **値そのもの** がページに出る。ここを .invalid（RFC 2606 で必ず
  解決しない TLD）にしておくと、出ていることを実 DNS に依存せず確かめられる。
  中継の到達不能も同じ理由でこの URL に依存して測る。"
  "https://mcp.example.invalid/xrpc/probe")

(def env #js {"APP_NANOID" "t1l3srv0"
              "APP_UI_TYPE" sentinel
              "TILE_ATTRIBUTION" "OpenStreetMap contributors (ODbL)"
              "AGENTGATEWAY_MCP_ROUTER_URL" router-url})

(defn- call [h method path]
  (let [req (js/Request. (str "https://tiles-maps.etzhayyim.com" path) #js {:method method})]
    (-> (js/Promise.resolve ((.-fetch h) req env #js {}))
        (.then (fn [res] (-> (.text res)
                             (.then (fn [body] {:status (.-status res)
                                                :ct (.get (.-headers res) "content-type")
                                                :body body}))))))))

(-> (js/import (.-href (.pathToFileURL url bundle)))
    (.then
     (fn [m]
       (let [h (.-default m)]
         (check! "default export has fetch" true (fn? (.-fetch h)))
         (-> (js/Promise.all
              #js [(call h "GET" "/") (call h "GET" "/health")
                   (call h "POST" "/xrpc/") (call h "OPTIONS" "/xrpc/x")
                   (call h "GET" "/nope") (call h "POST" "/health")
                   (call h "POST" "/xrpc/com.etzhayyim.maps.probe")
                   (call h "POST" "/xrpc/a/b")
                   (call h "GET" "/v1/0/0/0.pbf")])
             (.then
              (fn [[page health bad pre nf mna one multi tile]]
                (check! "GET / status" 200 (:status page))
                (check! "GET / is html" true (str/includes? (or (:ct page) "") "text/html"))

                ;; ページは route 表から描かれる。表にある path が全部
                ;; **表のセルとして** 出ていること。
                ;; 素の部分文字列で探す形は落ちない検査だった —— 実測
                ;; 2026-08-18、route 表を空にしても `/health` と `/` は緑の
                ;; ままだった（withheld の理由文などに部分文字列として現れる）。
                (doseq [p ["/" "/health" "/xrpc/:nsid" "/xrpc/*"]]
                  (check! (str "page advertises " p) true
                          (str/includes? (:body page)
                                         (str "<span class=\"tile-mono\">" p "</span>"))))
                ;; 移していない面も、理由と一緒に出ていること（黙って消していない）
                (check! "page names a withheld route" true
                        (str/includes? (:body page)
                                       "<span class=\"tile-mono\">/v1/{z}/{x}/{y}.pbf</span>"))

                ;; env のキーは出す、値は出さない。**2 つの独立した印で見る** ——
                ;; 片方だけだと「全部隠す」実装も「全部出す」実装も通ってしまう。
                (check! "page shows a var key" true (str/includes? (:body page) "APP_NANOID"))
                (check! "page hides other var values" false (str/includes? (:body page) sentinel))
                (check! "page shows the relay target it uses" true
                        (str/includes? (:body page) router-url))

                ;; DDS の CSS が bundle に焼かれている。**2 つに割る。**
                ;; 「dads-table が在る」は落ちない検査だった —— それは view が
                ;; 出力する markup であって、CSS が 1 バイトも入っていない
                ;; ページにも現れる。実測 2026-08-18（このページで）:
                ;; `dads-table` は css 込み 79 / css 無し **11**（0 にならない）。
                ;; `--color-primitive-blue` は 45 / **0**。
                ;; 前者は「view がライブラリを呼んだ」、後者は「stylesheet が
                ;; 実際に入った」—— 別の主張なので別の検査にする。
                (check! "page uses the design system components" true
                        (str/includes? (:body page) "class=\"dads-table\""))
                (check! "page carries the stylesheet itself" true
                        (str/includes? (:body page) "--color-primitive-blue"))

                (check! "GET /health status" 200 (:status health))
                (check! "health names its routes" true (str/includes? (:body health) "/xrpc/:nsid"))

                ;; nsid 無しの XRPC だけが 400。前方一致で素通ししない。
                (check! "POST /xrpc/ status" 400 (:status bad))
                ;; **多段パスは移行前と同じく中継する**（絞るのは方針変更）。
                ;; 単段と同じ結末になることを、単段と並べて見る —— .invalid の
                ;; 中継先なので到達できず、どちらも 502 になるはずである。
                (check! "single-segment xrpc is relayed (502 unreachable)" 502 (:status one))
                (check! "multi-segment xrpc is relayed too, not rejected" 502 (:status multi))
                (check! "multi-segment is not a 400" false (= 400 (:status multi)))
                (check! "the 502 names the url it tried" true
                        (str/includes? (:body multi) router-url))

                (check! "OPTIONS preflight" 204 (:status pre))
                (check! "unknown path" 404 (:status nf))
                (check! "wrong method" 405 (:status mna))
                ;; 移していない面は 404。存在するふりをしない。
                (check! "withheld tile route is 404" 404 (:status tile))

                (let [f @failures]
                  (if (seq f)
                    (do (println (str "FAILED\t" (count f) " check(s): " (str/join ", " f)))
                        (js/process.exit 1))
                    (do (println "OK\tthe built bundle answers as the route table says")
                        (js/process.exit 0))))))))))
    (.catch (fn [e]
              (println (str "UNDETERMINED\tcould not exercise the bundle: " (.-message e)))
              (js/process.exit 2))))
