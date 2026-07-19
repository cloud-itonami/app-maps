(ns maps.bulk-ingest.substrate
  "Substrate write seam for maps bulk-ingest workers.

  Idiomatic clj/cljc port of `bulk-ingest/workers/_etzhayyim_substrate.py`
  (ADR-2605172000 / ADR-2606064500 R2 / ADR-2606280030). A single seam
  `open-substrate-writer` each worker uses instead of a direct DB connection;
  the returned writer dispatches on `ETZHAYYIM_SUBSTRATE_MODE`:

  * `kotoba` — canonical Datom log: each vertex_spatial row is mapped
    (`kotoba-feature/rows->batch`) to a `:feature/*` entity and POSTed to
    `com.etzhayyim.apps.kotobase.kg.ingest_batch`. GATED (G4/G7): requires
    `MAPS_OPERATOR_GATE=1` + `KOTOBA_ENDPOINT` + `KOTOBA_AUTH` (member/operator
    DID bearer; no server key). Construction RAISES otherwise.
  * `mst` — AT Protocol PDS XRPC (createSession -> createRecord); PDS commits
    to MST + IPFS + Base L2.
  * `rw` — FORBIDDEN here. The substrate boundary (CLAUDE.md / CHARTER-RIDER §1)
    prohibits the centralized RisingWave/psycopg surface. The legacy
    `_RwSubstrateWriter` is intentionally NOT reimplemented in clj — the
    `.py` retains it as the transitional fallback; this clj seam refuses `rw`
    so a worker ported to clj cannot regress onto RisingWave.

  HTTP boundary is injectable (the swap seam, per the actor-tree idiom): pass
  `:post-fn` in opts to provide the purpose-specific request capability. The
  portable default is network-incapable; deployment config is supplied as data."
  (:require [clojure.string :as str]
            [cheshire.core :as json]
            [maps.bulk-ingest.kotoba-feature :as kf]))

(def ^:private chunk-size 500)

(defn- rstrip-slash [s] (str/replace (or s "") #"/+$" ""))

;; ── writer protocol ──

(defprotocol SubstrateWriter
  (upsert-vertex-spatial [w rows]
    "Upsert N rows into the spatial graph; returns the count that landed.")
  (upsert-table [w table rows]
    "Upsert N rows into an arbitrary aux table.")
  (close-writer [w]
    "Release the underlying session/connection."))

;; ── HTTP boundary (swap seam) ──

(def ^:dynamic *http-request!*
  (fn [& _]
    (throw (ex-info "explicit substrate HTTP capability required"
                    {:capability :substrate-http}))))

(defn http-post!
  "Default poster: send a request map {:url :headers :body} over the wire.
  `:body` is clojure data, JSON-encoded here. Raises on HTTP >= 300."
  [{:keys [url headers body]}]
  (let [resp (*http-request!* url {:headers headers
                                   :body (json/generate-string body)
                                   :throw false})]
    (when (>= (:status resp) 300)
      (throw (ex-info (str "kotoba ingest failed: HTTP " (:status resp))
                      {:status (:status resp) :url url})))
    resp))

;; ── kotoba backend (canonical Datom log via kg.ingest_batch) ──

(defn- post-entities!
  "Chunk entities and post each chunk as {\"entities\" [...]}; returns total posted."
  [post-fn endpoint auth nsid ents]
  (reduce
   (fn [total chunk]
     (post-fn {:url (str endpoint "/xrpc/" nsid)
               :headers {"content-type" "application/json"
                         "authorization" (str "Bearer " auth)}
               :body {"entities" (vec chunk)}})
     (+ total (count chunk)))
   0
   (partition-all chunk-size ents)))

(defrecord KotobaSubstrateWriter [endpoint auth nsid post-fn]
  SubstrateWriter
  (upsert-vertex-spatial [_ rows]
    (if (empty? rows)
      0
      (let [ents (get (kf/rows-to-batch rows) "entities")]
        (if (empty? ents)
          0
          (post-entities! post-fn endpoint auth nsid ents)))))
  (upsert-table [_ table rows]
    (if (empty? rows)
      0
      (let [batch (kf/aux-rows-to-batch table rows)]
        (when (nil? batch)
          ;; unmapped aux table -> raise LOUDLY rather than silently drop
          (throw (ex-info
                  (str "kotoba mode has no mapping for auxiliary table "
                       (pr-str table) " yet (ADR-2606064500 R2 follow-up). "
                       "Keep this dumper on rw/mst until its kotoba schema lands.")
                  {:type :not-implemented :table table})))
        (let [ents (get batch "entities")]
          (if (empty? ents) 0
              (post-entities! post-fn endpoint auth nsid ents))))))
  (close-writer [_] nil))

(defn- make-kotoba-writer
  [{:keys [operator-gate endpoint auth nsid post-fn]}]
  (let [gate operator-gate
        endpoint (rstrip-slash endpoint)
        auth (or auth "")
        nsid (or nsid "com.etzhayyim.apps.kotobase.kg.ingest_batch")]
    (when (not= gate "1")
      (throw (ex-info
              (str "ETZHAYYIM_SUBSTRATE_MODE=kotoba is outward-gated (ADR-2606064500 G7): "
                   "set MAPS_OPERATOR_GATE=1 with operator attestation to enable live ingest.")
              {:type :runtime-error :gate :missing-operator})))
    (when (or (str/blank? endpoint) (str/blank? auth))
      (throw (ex-info
              (str "ETZHAYYIM_SUBSTRATE_MODE=kotoba requires KOTOBA_ENDPOINT + KOTOBA_AUTH "
                   "(member/operator DID bearer; the pod holds no server key — no-server-key).")
              {:type :runtime-error :gate :missing-auth})))
    (->KotobaSubstrateWriter endpoint auth nsid (or post-fn http-post!))))

;; ── MST backend (AT Protocol PDS -> MST + IPFS + Base L2 anchor) ──

(defn- pds-create-session [post-fn pds-url handle app-password]
  (let [resp (post-fn {:url (str pds-url "/xrpc/com.atproto.server.createSession")
                       :headers {"content-type" "application/json"}
                       :body {"identifier" handle "password" app-password}})]
    (when (>= (:status resp) 300)
      (throw (ex-info "PDS createSession failed" {:status (:status resp)})))
    (json/parse-string (:body resp))))

(defrecord MstSubstrateWriter [pds-url session post-fn]
  SubstrateWriter
  (upsert-vertex-spatial [_ rows]
    (reduce
     (fn [n row]
       (let [label (-> (or (get row "label") "") str str/lower-case str/trim)]
         (if (str/blank? label)
           n
           (do
             (post-fn {:url (str pds-url "/xrpc/com.atproto.repo.createRecord")
                       :headers {"content-type" "application/json"
                                 "authorization" (str "Bearer " (get @session "accessJwt"))}
                       :body {"repo" (get @session "did")
                              "collection" (str "com.etzhayyim.apps.maps." label)
                              "record" row}})
             (inc n)))))
     0 rows))
  (upsert-table [_ table rows]
    (let [coll (str "com.etzhayyim.apps.maps.aux." table)]
      (doseq [row rows]
        (post-fn {:url (str pds-url "/xrpc/com.atproto.repo.createRecord")
                  :headers {"content-type" "application/json"
                            "authorization" (str "Bearer " (get @session "accessJwt"))}
                  :body {"repo" (get @session "did") "collection" coll "record" row}}))
      (count rows)))
  (close-writer [_] (reset! session nil)))

(defn- make-mst-writer [{:keys [pds-url handle app-password post-fn]}]
  (let [pds-url (rstrip-slash (or pds-url "https://atproto.etzhayyim.com"))
        post-fn (or post-fn http-post!)]
    (when (or (str/blank? (str handle)) (str/blank? (str app-password)))
      (throw (ex-info (str "ETZHAYYIM_SUBSTRATE_MODE=mst requires ETZHAYYIM_PDS_HANDLE + "
                           "ETZHAYYIM_PDS_APP_PASSWORD to be configured.")
                      {:type :runtime-error})))
    (->MstSubstrateWriter pds-url
                          (atom (pds-create-session post-fn pds-url handle app-password))
                          post-fn)))

;; ── seam ──

(defn open-substrate-writer
  "Open a substrate writer per `ETZHAYYIM_SUBSTRATE_MODE` (or opts `:mode`).
  Unlike a context manager, the caller closes via `close-writer` (or use
  `with-substrate-writer`). `rw` is refused — the substrate boundary forbids
  RisingWave (CLAUDE.md / CHARTER-RIDER §1); the python `.py` keeps the
  transitional rw fallback."
  ([] (open-substrate-writer {}))
  ([{:keys [mode] :as opts}]
   (let [mode (or (some-> mode str/lower-case) "rw")]
     (case mode
       "kotoba" (make-kotoba-writer opts)
       "mst" (make-mst-writer opts)
       "rw" (throw (ex-info
                    (str "ETZHAYYIM_SUBSTRATE_MODE=rw (RisingWave/psycopg) is forbidden "
                         "by the substrate boundary (CHARTER-RIDER §1 / CLAUDE.md). Use "
                         "'kotoba' (canonical Datom log) or 'mst' (AT Protocol ingress). "
                         "The legacy rw fallback remains only in the python worker.")
                    {:type :value-error :mode mode}))
       (throw (ex-info
               (str "ETZHAYYIM_SUBSTRATE_MODE=" (pr-str mode) " is not recognised. "
                    "Allowed: 'kotoba', 'mst', 'rw'.")
               {:type :value-error :mode mode}))))))

(defn with-substrate-writer*
  "Functional context-manager: open a writer, run (f writer), always close."
  [opts f]
  (let [w (open-substrate-writer opts)]
    (try (f w) (finally (close-writer w)))))

(defmacro with-substrate-writer
  "(with-substrate-writer [w opts] body...) — opens, binds w, closes in finally."
  [[binding opts] & body]
  `(with-substrate-writer* ~opts (fn [~binding] ~@body)))
