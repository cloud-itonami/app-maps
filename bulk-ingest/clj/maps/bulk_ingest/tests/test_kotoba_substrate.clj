(ns maps.bulk-ingest.tests.test-kotoba-substrate
  "clojure.test port of `bulk-ingest/workers/test_kotoba_substrate.py`
  (ADR-2606064500 R2 / ADR-2606280030).

  Covers the pure feature/transit converters (kotoba-feature) and the substrate
  write seam (substrate). The python E2E spun a localhost HTTP recorder to assert
  the posted body + Bearer auth; here the HTTP boundary is the injected `:post-fn`
  swap seam — the same body + auth header are captured, no socket needed (the
  repo's injection-boundary idiom). Cross-checks against the canonical
  orgs/etzhayyim/com-etzhayyim-maps python (_LABEL_MAP / name_tokens) are out of scope for the bb
  port and remain asserted by the python suite."
  (:require [clojure.test :refer [deftest is]]
            [clojure.string :as str]
            [cheshire.core :as json]
            [maps.bulk-ingest.kotoba-feature :as kf]
            [maps.bulk-ingest.substrate :as sub]))

(def rows
  [{"vertex_id" "at://x/airport/hnd" "label" "Airport" "name" "Haneda"
    "lat" 35.5494 "lng" 139.7798 "source_did" "did:web:maps.etzhayyim.com:registry:openflights"}
   {"vertex_id" "at://x/airroute/hnd-itm" "label" "AirRoute" "name" "HND-ITM"
    "lat" 35.0 "lng" 135.0 "props" (json/generate-string {"airline" "NH" "stops" 0})}
   {"vertex_id" "at://x/adminarea/jp13" "label" "AdminArea" "name" "Tokyo"
    "lat" 35.68 "lng" 139.69}
   {"vertex_id" "at://x/building/marunouchi" "label" "Building" "name" "Marunouchi Bldg"
    "lat" 35.6809 "lng" 139.7644
    "props" (json/generate-string {"heightM" 179 "levels" 37
                                   "geometry" {"type" "Point"
                                               "coordinates" [139.7644 35.6809]}})}])

(defn- preds [e] (into {} (map (juxt #(get % "pred") #(get % "value")) (get e "claims"))))

;; ── TestMapping ──

(deftest row-to-entity-shape
  (let [e (kf/row-to-entity (rows 0))
        p (preds e)]
    (is (= "at://x/airport/hnd" (get e "id")))
    (is (= "maps-feature" (get e "type")))
    (is (= ":airport" (p "feature/label")))          ;; folded
    (is (= ":representative" (p "feature/sourcing"))) ;; G3
    (is (= "Haneda" (p "feature/name")))
    (is (= "35.5494" (p "feature/lat")))
    (is (not (contains? p "feature/id")))))           ;; id is the entity id

(deftest multiword-label-folds
  (is (= ":air-route" (kf/fold-label "AirRoute")))
  (is (= ":admin-area" (kf/fold-label "AdminArea")))
  (is (= ":legal-entity" (kf/fold-label "LegalEntity")))
  (is (= ":registry" (kf/fold-label "LandRegistry")))
  (is (= ":weird-thing" (kf/fold-label "Weird Thing")))) ;; unknown -> kebab

(deftest props-promotion-and-geometry
  (let [e (kf/row-to-entity (rows 3))
        p (preds e)]
    (is (= "179.0" (p "feature/height-m")))
    (is (= "37" (p "feature/levels")))
    (is (contains? p "feature/geometry"))
    (is (map? (json/parse-string (p "feature/geometry")))) ;; valid JSON
    (when (contains? p "feature/props")
      (let [bag (json/parse-string (p "feature/props"))]
        (is (not (contains? bag "heightM")))
        (is (not (contains? bag "geometry")))))))

(deftest rows-to-batch-test
  (is (= 4 (count (get (kf/rows-to-batch rows) "entities")))))

(deftest name-tokens-stamped
  (let [e (kf/row-to-entity {"vertex_id" "f.s.tokyo" "label" "Station" "name" "Tokyo Station"})
        toks (set (for [c (get e "claims") :when (= "feature/name-token" (get c "pred"))]
                    (get c "value")))]
    (is (contains? toks "to"))
    (is (contains? toks "tokyo"))
    (is (contains? toks "station"))))

(deftest name-tokens-cjk
  ;; CJK bigrams (东京驿) — exercises the kanji path the python asserts vs search.py
  (let [toks (kf/name-tokens "東京駅")]
    (is (contains? toks "東京"))
    (is (contains? toks "京駅"))))

(deftest all-keywords-are-kebab
  (doseq [kw (vals kf/label-map)]
    (is (str/starts-with? kw ":") kw)
    (is (= kw (str/lower-case kw)) kw)
    (is (not (str/includes? kw "_")) kw)))

;; ── TestGate ──

(deftest gate-refuses-without-operator
  (let [ex (try (sub/open-substrate-writer {:mode "kotoba"}) ;; gate unset
                nil
                (catch clojure.lang.ExceptionInfo e e))]
    (is (some? ex))
    (is (str/includes? (ex-message ex) "MAPS_OPERATOR_GATE"))))

(deftest gate-refuses-without-auth
  (let [ex (try (sub/open-substrate-writer {:mode "kotoba" :operator-gate "1"}) ;; no endpoint/auth
                nil
                (catch clojure.lang.ExceptionInfo e e))]
    (is (some? ex))
    (is (str/includes? (str/lower-case (ex-message ex)) "no-server-key"))))

(deftest rw-mode-forbidden
  ;; substrate boundary: rw is refused in clj (python keeps the fallback)
  (let [ex (try (sub/open-substrate-writer {:mode "rw"}) nil
                (catch clojure.lang.ExceptionInfo e e))]
    (is (some? ex))
    (is (str/includes? (ex-message ex) "forbidden"))))

(deftest default-http-is-network-incapable
  (is (thrown-with-msg? clojure.lang.ExceptionInfo
                        #"explicit substrate HTTP capability required"
                        (sub/http-post! {:url "https://example.invalid"
                                         :headers {} :body {}}))))

;; ── TestE2E (HTTP boundary = injected post-fn swap seam) ──

(defn- recorder []
  (let [received (atom [])]
    {:received received
     :post-fn (fn [req] (swap! received conj req) {:status 200})}))

(deftest writer-posts-kg-batch-member-signed
  (let [{:keys [received post-fn]} (recorder)
        w (sub/open-substrate-writer {:mode "kotoba" :operator-gate "1"
                                      :endpoint "http://127.0.0.1:1" :auth "member-did-bearer"
                                      :post-fn post-fn})
        n (sub/upsert-vertex-spatial w rows)]
    (is (= 4 n))
    (is (= 1 (count @received)))
    (let [req (first @received)
          ents (get-in req [:body "entities"])
          ids (set (map #(get % "id") ents))
          labels (set (for [e ents c (get e "claims")
                            :when (= "feature/label" (get c "pred"))] (get c "value")))]
      (is (contains? ids "at://x/airport/hnd"))
      (is (= #{":airport" ":air-route" ":admin-area" ":building"} labels))
      (is (= "Bearer member-did-bearer" (get-in req [:headers "authorization"])))))) ;; no-server-key

(deftest mst-writer-uses-injected-request-capability
  (let [received (atom [])
        post-fn (fn [req]
                  (swap! received conj req)
                  (if (str/ends-with? (:url req) "createSession")
                    {:status 200 :body "{\"did\":\"did:plc:test\",\"accessJwt\":\"jwt\"}"}
                    {:status 200 :body "{}"}))
        w (sub/open-substrate-writer {:mode "mst"
                                      :pds-url "https://pds.test/"
                                      :handle "operator.test"
                                      :app-password "secret"
                                      :post-fn post-fn})]
    (is (= 1 (sub/upsert-vertex-spatial w [(rows 0)])))
    (is (= 2 (count @received)))
    (is (= "Bearer jwt" (get-in @received [1 :headers "authorization"])))))

(deftest unmapped-aux-table-raises-loudly
  (let [{:keys [post-fn]} (recorder)
        w (sub/open-substrate-writer {:mode "kotoba" :operator-gate "1"
                                      :endpoint "http://127.0.0.1:1" :auth "x" :post-fn post-fn})]
    (is (thrown? clojure.lang.ExceptionInfo
                 (sub/upsert-table w "vertex_maps_gsplat_asset" [{"asset_id" "a"}])))))

;; ── TestTransitAux ──

(def trips
  [{"feed_id" "tokyo-metro" "trip_id" "T1" "route_id" "M" "service_id" "wd"
    "direction_id" 0 "headsign" "Ogikubo" "agency" "Tokyo Metro" "prefecture" "Tokyo"}])

(def stop-times
  [{"feed_id" "tokyo-metro" "trip_id" "T1" "stop_sequence" 1
    "stop_id" "gtfsjp-tokyo-metro-S01" "arrival_time" "08:00:00" "departure_time" "08:00:30"}
   {"feed_id" "tokyo-metro" "trip_id" "T1" "stop_sequence" 2
    "stop_id" "gtfsjp-tokyo-metro-S02" "departure_time" "08:02:00" "timepoint" 1}])

(deftest trip-row-to-entity
  (let [e (kf/trip-row-to-entity (trips 0))
        p (preds e)]
    (is (= "trip.tokyo-metro.T1" (get e "id")))
    (is (= "transit-trip" (get e "type")))
    (is (= "M" (p "transit.trip/route")))
    (is (= "0" (p "transit.trip/direction")))
    (is (= ":representative" (p "transit.trip/sourcing")))))

(deftest stop-time-row-to-entity-and-index-key
  (let [e (kf/stop-time-row-to-entity (stop-times 0))
        p (preds e)]
    (is (= "stoptime.tokyo-metro.T1.1" (get e "id")))
    (is (= "gtfsjp-tokyo-metro-S01" (p "transit.stop-time/stop")))
    (is (= "08:00:30" (p "transit.stop-time/departure-time")))
    (is (= "trip.tokyo-metro.T1" (p "transit.stop-time/trip")))))

(deftest missing-key-skipped
  (is (nil? (kf/trip-row-to-entity {"feed_id" "f"})))                       ;; no trip_id
  (is (nil? (kf/stop-time-row-to-entity {"feed_id" "f" "trip_id" "t"}))))    ;; no seq

(deftest aux-rows-to-batch-dispatch
  (is (= 1 (count (get (kf/aux-rows-to-batch "vertex_maps_trip" trips) "entities"))))
  (is (= 2 (count (get (kf/aux-rows-to-batch "vertex_maps_stop_time" stop-times) "entities"))))
  (is (nil? (kf/aux-rows-to-batch "vertex_maps_gsplat_asset" [{"x" 1}]))))   ;; unmapped

(deftest e2e-aux-writer-posts-transit-records
  (let [{:keys [received post-fn]} (recorder)
        w (sub/open-substrate-writer {:mode "kotoba" :operator-gate "1"
                                      :endpoint "http://127.0.0.1:1" :auth "member-did"
                                      :post-fn post-fn})
        n (sub/upsert-table w "vertex_maps_stop_time" stop-times)]
    (is (= 2 n))
    (let [ents (get-in (first @received) [:body "entities"])
          stops (set (for [e ents c (get e "claims")
                           :when (= "transit.stop-time/stop" (get c "pred"))] (get c "value")))]
      (is (= #{"gtfsjp-tokyo-metro-S01" "gtfsjp-tokyo-metro-S02"} stops))
      (is (= "Bearer member-did" (get-in (first @received) [:headers "authorization"]))))))
