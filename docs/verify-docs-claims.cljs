#!/usr/bin/env nbb
;; verify-docs-claims.cljs — README.md と docs/operator-quickstart.md が
;; 「数えた」と言っている数を、実際に数えて突き合わせる。
;;
;;   nbb docs/verify-docs-claims.cljs
;;
;; exit 0 = PASS / 1 = FAIL / 3 = 判定できなかった（0 でも 1 でもない）
;;
;; ⚠ **DNS はここで検査しない。** 6 つのホストが NXDOMAIN であることはこの repo の
;;   中心的な事実だが、ネットワークの事実をオフラインで測ると「引けなかった」が
;;   「無い」と同じ値になる ——圏外が合格に化ける。その 1 件は quickstart §6 に
;;   置いて人間に引かせる。app-hakken / app-manga 版と同じ判断。
;;
;; ⚠ **構文エラーの検査は近似である。** nbb に TypeScript パーサは無いので、
;;   「`kotoba-datomic` が識別子位置に在る」を行の形で判定する（JS の識別子に
;;   `-` は入らないので、`} ` や `.` が続けば確実に構文エラー）。この近似は
;;   2026-08-18 に **2 つの実パーサ**（esbuild 0.28.2 / tsc 5.x）と突き合わせ、
;;   同じ 9 ファイルを返すことを確認してある。ここが将来ずれたら、近似ではなく
;;   パーサを使うこと。

(require '["node:child_process" :as cp]
         '["node:fs" :as fs]
         '[clojure.string :as str])

(defn- die! [code & msg]
  (binding [*print-fn* *print-err-fn*] (apply println msg))
  (js/process.exit code))

(defn- git [& args]
  (try
    (str/trim (str (cp/execFileSync "git" (clj->js (vec args)) #js {:encoding "utf8"})))
    (catch :default e
      (die! 3 "UNDETERMINED: git" (str/join " " args) "が失敗した —"
            (or (some-> e .-message) "(理由不明)")))))

(defn- slurp* [p]
  (when-not (fs/existsSync p)
    (die! 3 "UNDETERMINED:" p "が無い。この repo のルートで実行すること"))
  (fs/readFileSync p "utf8"))

(def ^:private tracked
  (let [ls (remove str/blank? (str/split-lines (git "ls-files")))]
    (when (zero? (count ls))
      (die! 3 "UNDETERMINED: git ls-files が空。commit の無い repo か"))
    ls))

(defn- bytes-of [paths]
  (reduce + 0 (map (fn [p]
                     (if (fs/existsSync p)
                       (.-size (fs/statSync p))
                       (die! 3 "UNDETERMINED: tracked なのに実体が無い:" p)))
                   paths)))

(defn- under [prefix] (filterv #(str/starts-with? % prefix) tracked))
(defn- count-matches [s re] (count (re-seq re s)))

;; ── 対象 ──────────────────────────────────────────────────────────────────

(def ^:private ts-files
  (filterv #(and (re-find #"\.tsx?$" %) (not (str/ends-with? % ".d.ts"))) tracked))

(def ^:private kotoba-src   (under "kotoba/src/"))
(def ^:private kotoba-test  (under "kotoba/test/"))
(def ^:private src-tests    (filterv #(str/ends-with? % ".test.ts") kotoba-src))
(def ^:private py-files     (filterv #(str/ends-with? % ".py") tracked))
(def ^:private pkg-jsons    (filterv #(str/ends-with? % "package.json") tracked))

(doseq [[what coll] {"kotoba/src" kotoba-src "kotoba/test" kotoba-test
                     "TypeScript" ts-files "Python" py-files}]
  (when (zero? (count coll))
    (die! 3 "UNDETERMINED:" what "に tracked file が 1 件も無い（絞り込みが壊れている）")))

;; ── 数える ────────────────────────────────────────────────────────────────

;; `kotoba-datomic` が **識別子位置**に在るファイル。行頭が `*` / `//` の
;; コメント行は除き、トークンの直後が `}` か `.` のものだけを数える。
(def ^:private broken-identifier-files
  (filterv (fn [p]
             (some (fn [line]
                     (and (not (re-find #"^\s*(\*|//|#)" line))
                          (re-find #"kotoba-datomic\s*[}.]" line)))
                   (str/split-lines (slurp* p))))
           ts-files))

(def ^:private vitest-config (slurp* "kotoba/vitest.config.ts"))
(def ^:private placeholder   (slurp* "kotoba/test/maps.test.ts"))
(def ^:private feature-index (slurp* "kotoba/src/feature/index.ts"))
(def ^:private geography     (slurp* "kotoba/src/feature/geography.test.ts"))
(def ^:private barrel        (slurp* "kotoba/src/index.ts"))
(def ^:private ui-wrangler   (slurp* "appview/maps-ui-uqpel6i6/wrangler.jsonc"))
(def ^:private migration     (slurp* "migration.edn"))

;; geography.test.ts が `./index.js` から取ろうとしている名前のうち、
;; feature/ の非テストファイルのどこにも定義が無いもの。
(def ^:private feature-nontest
  (remove #(str/ends-with? % ".test.ts") (under "kotoba/src/feature/")))

(def ^:private feature-src-text (str/join "\n" (map slurp* feature-nontest)))

(def ^:private missing-imports
  (->> ["registerAdminArea" "registerCoastline" "registerLake"
        "registerMaritimeZone" "registerRiver" "registerSpot" "listFeatures"]
       (filterv (fn [nm]
                  (and (str/includes? geography nm)
                       (not (str/includes? feature-src-text nm)))))))

(def ^:private exported-registers
  (count (re-seq #"(?m)^export async function register[A-Za-z]+" feature-index)))

(def ^:private barrel-topics
  (mapv second (re-seq #"(?m)^export \* as (\w+) from" barrel)))

(def ^:private workspace-star-pkgs
  (filterv #(str/includes? (slurp* %) "workspace:*") pkg-jsons))

(def ^:private workspace-roots
  (filterv #(str/includes? (slurp* %) "\"workspaces\"") pkg-jsons))

(def ^:private ui-abs-aliases
  (count (re-seq #"\"/Users/[^\"]+\"" ui-wrangler)))

;; committed credential。値は出さない ——場所と件数だけ数える。
(def ^:private token-files
  (filterv (fn [p]
             (and (re-find #"\.(jsonc?|jsonld)$" p)
                  (str/includes? (slurp* p) "MLY|")))
           tracked))

;; migration.edn の :canonical-files が、実際の追加物と一致しているか
(def ^:private declared-canonical
  (mapv second (re-seq #"\"([^\"]+)\"" (or (second (re-find #":canonical-files\s*\[([^\]]*)\]" migration)) ""))))

;; ── 判定 ──────────────────────────────────────────────────────────────────

(def ^:private checks
  [{:what "tracked ファイル数"                        :got (count tracked)         :want 219}
   {:what "tracked な .ts/.tsx（.d.ts 除く）"          :got (count ts-files)        :want 94}
   {:what "識別子位置に kotoba-datomic を持つファイル数（= 構文エラー）"
    :got (count broken-identifier-files) :want 9}
   {:what "kotoba/src のファイル数"                    :got (count kotoba-src)      :want 47}
   {:what "kotoba/src のバイト数"                      :got (bytes-of kotoba-src)   :want 302099}
   {:what "kotoba/src の *.test.ts 数（走らない 18）"   :got (count src-tests)       :want 18}
   {:what "kotoba/test のバイト数（placeholder のみ）"  :got (bytes-of kotoba-test)  :want 155}
   {:what "placeholder の it( 件数"                    :got (count-matches placeholder #"(?m)^\s+it\(") :want 1}
   {:what "vitest の include が test/ に閉じている"
    :got (str/includes? vitest-config "include: [\"test/**/*.test.ts\"]") :want true}
   {:what "feature/index.ts が export する register* 数" :got exported-registers    :want 3}
   {:what "geography.test.ts が要求して存在しない名前の数" :got (count missing-imports) :want 7}
   {:what "barrel が再輸出する topic 数"                :got (count barrel-topics)   :want 6}
   {:what "barrel が twin を再輸出していない"
    :got (boolean (some #{"twin"} barrel-topics)) :want false}
   {:what "workspace:* を宣言する package.json 数"      :got (count workspace-star-pkgs) :want 1}
   {:what "この repo の workspace root 数（宣言先が無い証拠）"
    :got (count workspace-roots) :want 0}
   {:what "maps-ui wrangler の絶対パス alias 数"        :got ui-abs-aliases          :want 8}
   {:what "Mapillary token を含む tracked file 数"      :got (count token-files)     :want 2}
   {:what "Python ファイル数"                          :got (count py-files)        :want 21}
   {:what "migration.edn :canonical-files の件数"       :got (count declared-canonical) :want 8}])

(println (str "SCANNED\t" (count tracked) " tracked / " (count ts-files) " ts / "
              (count kotoba-src) " kotoba-src / " (count py-files) " py / "
              (count checks) " 検査"))

(doseq [{:keys [what got want]} checks]
  (let [ok (= got want)]
    (println (str (if ok "  ok   " "  FAIL ") what))
    (println (str "         got  " (pr-str got)))
    (when-not ok (println (str "         want " (pr-str want))))))

(if (every? #(= (:got %) (:want %)) checks)
  (do (println (str "PASS — README.md / operator-quickstart.md の数値 " (count checks) " 件は実測と一致"))
      (js/process.exit 0))
  (do (println "FAIL — 文書の数値が実測と食い違う")
      (js/process.exit 1)))
