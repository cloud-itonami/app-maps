(ns maps.tile.route-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [maps.tile.route :as route]
            [maps.tile.view :as view]))

(deftest dispatch-page-and-health
  (is (= :page (:action (route/dispatch "GET" "/"))))
  (is (= :health (:action (route/dispatch "GET" "/health"))))
  (is (= :method-not-allowed (:action (route/dispatch "POST" "/health"))))
  (is (= :method-not-allowed (:action (route/dispatch "POST" "/"))))
  (is (= :not-found (:action (route/dispatch "GET" "/nope"))))
  (testing "移していない面は 404。存在するふりをしない"
    (is (= :not-found (:action (route/dispatch "GET" "/v1/0/0/0.pbf"))))
    (is (= :not-found (:action (route/dispatch "GET" "/v1/manifest.json"))))))

(deftest dispatch-xrpc
  (testing "単一セグメントの nsid"
    (is (= {:action :xrpc :nsid "com.etzhayyim.maps.getTile"}
           (route/dispatch "POST" "/xrpc/com.etzhayyim.maps.getTile"))))
  (testing "空だけが 400。多段は移行前と同じく転送する（絞るのは方針変更）"
    (is (= :bad-request (:action (route/dispatch "POST" "/xrpc/"))))
    (is (= {:action :xrpc :nsid "a/b"} (route/dispatch "POST" "/xrpc/a/b"))))
  (testing "preflight と method"
    (is (= :cors-preflight (:action (route/dispatch "OPTIONS" "/xrpc/x"))))
    (is (= :method-not-allowed (:action (route/dispatch "GET" "/xrpc/x"))))))

(deftest mcp-url-resolution
  (is (= "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message"
         (route/mcp-router-url {})))
  (is (= "https://a.example/x"
         (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "https://a.example/x/"})))
  (testing "空白だけの設定は未設定として扱う"
    (is (= "https://b.example"
           (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "   "
                                  :MCP_ROUTER_URL "https://b.example"})))))

(deftest unwrap
  (is (= {:ok? true :value {:a 1}} (route/unwrap-mcp {:result {:structuredContent {:a 1}}})))
  (is (= {:ok? true :value {:a 1}} (route/unwrap-mcp {:result {:a 1}})))
  (is (false? (:ok? (route/unwrap-mcp {:error {:message "boom"}})))))

(deftest withheld-is-declared-not-served
  (testing "移していない面は data として在り、routes には無い"
    (is (seq route/withheld))
    (let [served (set (map :route/path route/routes))]
      (doseq [w route/withheld]
        (is (not (contains? served (:route/path w)))
            (str (:route/path w) " が routes にも withheld にも在る"))))
    (doseq [w route/withheld]
      (is (seq (:withheld/reason w))
          (str (:route/path w) " に理由が無い —— 黙って消したのと同じ")))))

(deftest page-shows-the-real-routes
  (testing "ページは route 表から描く。0 を焼かない（移行前のページの欠陥）"
    (let [html (view/render {:css "/*x*/"
                             :routes route/routes
                             :withheld route/withheld
                             :vars [:APP_NANOID :TILE_ATTRIBUTION]
                             :mcp-url "https://mcp.example/x"})]
      ;; **path そのものを探すだけでは落ちない。** 実測 2026-08-18: route 表を
      ;; 空に置き換えても `/health` と `/` は緑のままだった —— どちらも
      ;; withheld の理由文（「/health に一本化した」）や別の文言に部分文字列と
      ;; して現れるからである。表の中のセルを名指しで探す。
      (doseq [r route/routes]
        (is (str/includes? html (str "<span class=\"tile-mono\">" (:route/path r) "</span>"))
            (str (:route/path r) " が route 表のセルとして出ていない")))
      (doseq [w route/withheld]
        (is (str/includes? html (str "<span class=\"tile-mono\">" (:route/path w) "</span>"))
            (str (:route/path w) " が『移していない面』のセルとして出ていない")))
      (is (str/includes? html "APP_NANOID"))
      (is (str/includes? html "https://mcp.example/x"))
      (testing "移行前のページの文言が残っていない"
        (is (not (str/includes? html "No public route is declared")))
        (is (not (str/includes? html "routeCount")))))))
