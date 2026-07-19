(ns maps.bulk-ingest.kotoba-feature
  "vertex_spatial row -> kotoba :feature/* mapping for the bulk-ingest dumpers.

  Idiomatic clj/cljc port of `bulk-ingest/workers/_kotoba_feature.py`
  (ADR-2606064500 R2 / ADR-2606280030). Pure functions only: a legacy
  `vertex_spatial`/aux row map -> a `kg.ingest_batch` entity. Kept in lockstep
  with `orgs/etzhayyim/com-etzhayyim-maps/methods/ingest.py` (`_LABEL_MAP`) and the maps spatial
  ontology `:feature/label` keywords; the substrate writer (`substrate.cljc`)
  POSTs the produced batch.

  Row maps use STRING keys (as the python dicts / decoded JSON do), so this ns
  is a faithful twin of the python converter. No I/O — unit-testable without a
  live PDS. The H3 spatial index (`feature.cell/rN`) is a hard dep on an h3
  library (not available under bb); like the python fallback (`h3` absent ->
  `{}`), `stamp-cells` degrades to `{}` here. See run notes / PORT-NOTES.md."
  (:require [clojure.string :as str]
            [cheshire.core :as json]))

;; H3 resolutions the maps client queries (the zoom->LOD ladder; ontology §2).
(def cell-resolutions [2 4 6 8 10 12])

;; legacy vertex_spatial.label (PascalCase) -> kotoba :feature/label keyword.
;; MUST equal orgs/etzhayyim/com-etzhayyim-maps/methods/ingest.py _LABEL_MAP.
(def label-map
  {"Place" ":place" "Road" ":road" "Railway" ":railway" "Building" ":building"
   "River" ":river" "Lake" ":lake" "Coastline" ":coastline" "AdminArea" ":admin-area"
   "Mountain" ":mountain" "Port" ":port" "Airport" ":airport" "Station" ":station"
   "BusStop" ":bus-stop" "BusRoute" ":bus-route" "SeaRoute" ":sea-route"
   "AirRoute" ":air-route" "LegalEntity" ":legal-entity" "LandRegistry" ":registry"
   "SatelliteScene" ":satellite-scene" "Spot" ":place"})

(defn fold-label
  "Legacy PascalCase label -> :feature/label keyword (lowercase-kebab)."
  [label]
  (if (or (nil? label) (= label ""))
    ":unknown"
    (let [s (str label)]
      (cond
        (str/starts-with? s ":") s
        :else (get label-map s
                    (str ":" (-> s str/trim str/lower-case (str/replace " " "-"))))))))

(defn- numeric? [x] (and (some? x) (number? x)))

(defn stamp-cells
  "Owning H3 cell at each queryable resolution, or {} when h3 is absent / coords
  missing. The bb runtime ships no h3 library, so this always returns {} (the
  python `h3 absent -> {}` branch); features still ingest but carry no cell
  index until re-stamped by an h3-capable path (the maps adapter / a dumper
  image with h3)."
  [lat lon]
  (if (and (numeric? lat) (numeric? lon))
    {} ;; no h3 under bb -> deferred, byte-identical to the python except branch
    {}))

;; ── name-search index tokens (ADR-2606064500 R2) ──
;; MUST equal orgs/etzhayyim/com-etzhayyim-maps/methods/search.py `name_tokens`. ASCII name-prefixes
;; (len 2..12) + CJK bigrams.
(def ^:private max-prefix 12)

(defn- char-code [ch]
  #?(:clj (int ch) :cljs (.charCodeAt ^js ch 0)))

(defn- cjk? [ch]
  (let [o (char-code ch)]
    (or (<= 0x3040 o 0x30FF) (<= 0x3400 o 0x9FFF)
        (<= 0xF900 o 0xFAFF) (<= 0xFF66 o 0xFF9D))))

(defn- ascii-alnum? [ch]
  #?(:clj (Character/isLetterOrDigit ^char ch)
     :cljs (some? (re-matches #"[a-z0-9]" (str ch)))))

(defn- name-runs
  "Partition a (lowercased) name into [(kind run-text) ...] where kind is
  :cjk | :ascii. Mirrors python `_name_runs`."
  [name]
  (let [s (str/lower-case (or name ""))]
    (loop [chars (seq s), out [], buf [], kind nil]
      (if (empty? chars)
        (if (and (seq buf) (some? kind))
          (conj out [kind (apply str buf)])
          out)
        (let [ch (first chars)
              k (cond (cjk? ch) :cjk
                      (ascii-alnum? ch) :ascii
                      :else nil)]
          (if (not= k kind)
            (let [out' (if (seq buf) (conj out [kind (apply str buf)]) out)]
              (recur (rest chars) out' (if (some? k) [ch] []) k))
            (recur (rest chars) out (if (some? k) (conj buf ch) buf) kind)))))))

(defn name-tokens
  "INDEX tokens for a feature name (stored as :feature/name-token). Returns a set."
  [name]
  (reduce
   (fn [toks [kind text]]
     (cond
       (and (= kind :ascii) (>= (count text) 2))
       (into toks (for [n (range 2 (inc (min (count text) max-prefix)))]
                    (subs text 0 n)))
       (= kind :cjk)
       (let [bigrams (for [i (range (dec (count text)))] (subs text i (+ i 2)))
             toks' (into toks bigrams)]
         (if (= (count text) 1) (conj toks' text) toks'))
       :else toks))
   #{}
   (name-runs name)))

(def ^:private promoted #{"geometry" "heightM" "height_m" "levels" "floors"})

(defn- as-props
  "Coerce a row's `props` (a map, a JSON string, or nil) to a string-keyed map."
  [props]
  (let [p (if (string? props)
            (try (json/parse-string props) (catch #?(:clj Exception :cljs :default) _ {}))
            props)]
    (or p {})))

(defn- claim [pred value] {"pred" pred "value" (str value)})

(defn row-to-entity
  "One vertex_spatial row map -> a kg.ingest_batch entity
  {id type label_en claims relations}, or nil when it has no id."
  [row]
  (let [fid (or (get row "vertex_id") (get row "id"))]
    (when fid
      (let [lat (get row "lat")
            lon (get row "lng" (get row "lon"))
            props (as-props (get row "props"))
            base [(claim "feature/label" (fold-label (get row "label")))
                  (claim "feature/sourcing" ":representative")] ;; G3 — bounded feed
            add (fn [claims pred value]
                  (if (or (nil? value) (= value "")) claims
                      (conj claims (claim pred value))))
            claims (-> base
                       (add "feature/name" (get row "name"))
                       (add "feature/display-name" (get row "display_name"))
                       (add "feature/category" (get row "category"))
                       (add "feature/source-did" (get row "source_did")))
            claims (cond-> claims (numeric? lat) (add "feature/lat" lat))
            claims (cond-> claims (numeric? lon) (add "feature/lon" lon))
            h (get props "heightM" (get props "height_m"))
            claims (cond-> claims (numeric? h) (add "feature/height-m" (double h)))
            lv (get props "levels" (get props "floors"))
            claims (cond-> claims (numeric? lv) (add "feature/levels" (long lv)))
            geom (get props "geometry")
            claims (cond-> claims (some? geom)
                     (add "feature/geometry" (json/generate-string geom)))
            rest-props (apply dissoc props promoted)
            claims (cond-> claims (seq rest-props)
                     (add "feature/props" (json/generate-string rest-props)))
            claims (reduce (fn [c [k v]] (add c k v)) claims (stamp-cells lat lon))
            ;; name-search index
            toks (reduce (fn [t nm] (if nm (into t (name-tokens (str nm))) t))
                         #{} [(get row "name") (get row "display_name")])
            claims (into claims (map #(claim "feature/name-token" %) (sort toks)))]
        {"id" (str fid)
         "type" "maps-feature"
         "label_en" (or (get row "name") (get row "display_name") (str fid))
         "claims" claims
         "relations" []}))))

(defn rows-to-batch
  "vertex_spatial rows -> a kg.ingest_batch body."
  [rows]
  {"entities" (vec (keep row-to-entity rows))})

;; ── auxiliary tables -> kotoba records (maps-transit-ontology) ──

(defn- claims-of
  "Build claims from [pred value] pairs, dropping nil/empty values."
  [pairs]
  (vec (for [[p v] pairs :when (not (or (nil? v) (= v "")))] (claim p v))))

(defn trip-row-to-entity [row]
  (let [feed (get row "feed_id") trip (get row "trip_id")]
    (when (and feed trip)
      (let [tid (str "trip." feed "." trip)
            claims (claims-of
                    [["transit.trip/feed" feed] ["transit.trip/trip-id" trip]
                     ["transit.trip/route" (get row "route_id")]
                     ["transit.trip/service" (get row "service_id")]
                     ["transit.trip/shape" (get row "shape_id")]
                     ["transit.trip/direction" (get row "direction_id")]
                     ["transit.trip/headsign" (get row "headsign")]
                     ["transit.trip/short-name" (get row "short_name")]
                     ["transit.trip/block" (get row "block_id")]
                     ["transit.trip/wheelchair-accessible" (get row "wheelchair_accessible")]
                     ["transit.trip/bikes-allowed" (get row "bikes_allowed")]
                     ["transit.trip/agency" (get row "agency")]
                     ["transit.trip/prefecture" (get row "prefecture")]
                     ["transit.trip/sourcing" ":representative"]])]
        {"id" tid "type" "transit-trip"
         "label_en" (or (get row "headsign") (get row "short_name") tid)
         "claims" claims "relations" []}))))

(defn stop-time-row-to-entity [row]
  (let [feed (get row "feed_id") trip (get row "trip_id") seq* (get row "stop_sequence")]
    (when (and feed trip (some? seq*))
      (let [sid (str "stoptime." feed "." trip "." seq*)
            claims (claims-of
                    [["transit.stop-time/trip" (str "trip." feed "." trip)]
                     ["transit.stop-time/stop" (get row "stop_id")]
                     ["transit.stop-time/sequence" seq*]
                     ["transit.stop-time/arrival-time" (get row "arrival_time")]
                     ["transit.stop-time/departure-time" (get row "departure_time")]
                     ["transit.stop-time/pickup-type" (get row "pickup_type")]
                     ["transit.stop-time/drop-off-type" (get row "drop_off_type")]
                     ["transit.stop-time/headsign" (get row "stop_headsign")]
                     ["transit.stop-time/shape-dist" (get row "shape_dist_traveled")]
                     ["transit.stop-time/timepoint" (get row "timepoint")]
                     ["transit.stop-time/sourcing" ":representative"]])]
        {"id" sid "type" "transit-stop-time" "label_en" sid
         "claims" claims "relations" []}))))

;; table name -> row-mapper. Tables absent here have no kotoba schema yet.
(def aux-table-mappers
  {"vertex_maps_trip" trip-row-to-entity
   "vertex_maps_stop_time" stop-time-row-to-entity})

(defn aux-rows-to-batch
  "Known aux table's rows -> kg.ingest_batch, or nil if the table has no kotoba
  mapping yet (the caller raises so an unmapped table is never a silent drop)."
  [table rows]
  (when-let [mapper (get aux-table-mappers table)]
    {"entities" (vec (keep mapper rows))}))
