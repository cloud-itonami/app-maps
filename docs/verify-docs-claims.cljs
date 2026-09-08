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
;;   「無い」と同じ値になる ——圏外が合格に化ける。その 1 件は quickstart §7 に
;;   置いて人間に引かせる。app-hakken / app-manga 版と同じ判断。
;;
;; ⚠ **構文エラーの検査は近似である。** nbb に TypeScript パーサは無いので、
;;   「`kotoba-datomic` が識別子位置に在る」を行の形で判定する（JS の識別子に
;;   `-` は入らないので、`} ` や `.` が続けば確実に構文エラー）。この近似は
;;   2026-08-18 に **2 つの実パーサ**（esbuild 0.28.2 / tsc 5.x）と突き合わせ、
;;   同じ 9 ファイルを返すことを確認してある。ここが将来ずれたら、近似ではなく
;;   パーサを使うこと。
;;
;; ⚠ **サイズは lstat で測る。** `kotoba/CHARTER-RIDER.md` は monorepo の root を
;;   指す symlink で、抽出でその root ごと居なくなった —— **dangling である**。
;;   `statSync` はリンクを辿って ENOENT を投げるので、以前の版はこの 1 ファイルに
;;   触れた瞬間に「UNDETERMINED」で全体を落とすところだった（触れていなかったのは
;;   偶然、kotoba/src と kotoba/test しか測っていなかったから）。lstat で symlink
;;   そのものを測り、**dangling の件数を claim として持つ**。壊れた事実は、事故で
;;   検査を止めるのではなく、名前を付けて数える。

(require '["node:child_process" :as cp]
         '["node:fs" :as fs]
         '[kotoba.lang.text :as str]
         '[clojure.edn :as edn])

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

(def ^:private TILE "appview/maps-tile-server-t1l3srv0/")
(def ^:private UI   "appview/maps-ui-uqpel6i6/")

(def ^:private tracked
  (let [ls (remove str/blank? (str/split-lines (git "ls-files")))]
    (when (zero? (count ls))
      (die! 3 "UNDETERMINED: git ls-files が空。commit の無い repo か"))
    ls))

(defn- lstat [p]
  (try (fs/lstatSync p)
       (catch :default _ (die! 3 "UNDETERMINED: tracked なのに実体が無い:" p))))

(defn- bytes-of [paths] (reduce + 0 (map #(.-size (lstat %)) paths)))
(defn- under [prefix] (filterv #(str/starts-with? % prefix) tracked))
(defn- count-matches [s re] (count (re-seq re s)))

;; ── 対象 ──────────────────────────────────────────────────────────────────

(def ^:private ts-files
  (filterv #(and (re-find #"\.tsx?$" %) (not (str/ends-with? % ".d.ts"))) tracked))

(def ^:private kotoba-all   (under "kotoba/"))
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

(def ^:private dangling-symlinks
  (->> (str/split-lines (git "ls-files" "-s"))
       (remove str/blank?)
       (keep (fn [l] (let [[meta p] (str/split l #"\t" 2)]
                       (when (str/starts-with? meta "120000") p))))
       (remove #(fs/existsSync %))
       vec))

(def ^:private vitest-config (slurp* "kotoba/vitest.config.ts"))
(def ^:private placeholder   (slurp* "kotoba/test/maps.test.ts"))
(def ^:private feature-index (slurp* "kotoba/src/feature/index.ts"))
(def ^:private geography     (slurp* "kotoba/src/feature/geography.test.ts"))
(def ^:private barrel        (slurp* "kotoba/src/index.ts"))
(def ^:private ui-wrangler   (slurp* (str UI "wrangler.jsonc")))
(def ^:private migration
  (try (edn/read-string (slurp* "migration.edn"))
       (catch :default e (die! 3 "UNDETERMINED: migration.edn が EDN として読めない —" (.-message e)))))

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

;; ── 移行（docs/adr/0001）の不変条件 ───────────────────────────────────────

(defn- strip-jsonc [s] (str/replace s #"(?m)^\s*//.*$" ""))

(def ^:private tile-wrangler
  (try (js->clj (.parse js/JSON (strip-jsonc (slurp* (str TILE "wrangler.jsonc")))) :keywordize-keys false)
       (catch :default e (die! 3 "UNDETERMINED: tile-server の wrangler.jsonc が JSON として読めない —" (.-message e)))))

(def ^:private shadow
  (try (edn/read-string (slurp* "shadow-cljs.edn"))
       (catch :default e (die! 3 "UNDETERMINED: shadow-cljs.edn が EDN として読めない —" (.-message e)))))

(def ^:private worker-build (get-in shadow [:builds :worker]))

;; **grep しない。** 自分のコメントが文字列を含むので、grep は必ず当たる ——
;; 落ちようの無い検査になる。EDN として読んで、キーが :compiler-options の
;; 下に在ることと、:build-options に**居ない**ことの両方を見る（shadow が読むのは
;; [:compiler-options :warnings-as-errors] だけで、置き場所を間違えると黙って
;; 無視される。それはこの option が防ぐはずの失敗そのものである）。
(def ^:private warnings-as-errors-placed-right?
  (and (true? (get-in worker-build [:compiler-options :warnings-as-errors]))
       (nil? (get-in worker-build [:build-options :warnings-as-errors]))))

(def ^:private shadow-export
  (str (get-in worker-build [:modules :worker :exports 'default])))

(def ^:private removed-still-present
  (filterv #(fs/existsSync %) (:removed-by-migration migration)))

(def ^:private tile-svelte-artifacts
  (filterv #(and (str/starts-with? % TILE)
                 (or (str/ends-with? % ".svelte")
                     (str/includes? % "svelte.config")
                     (str/includes? % "/svelte/")))
           tracked))

(def ^:private tile-ts (filterv #(str/starts-with? % TILE) ts-files))

(def ^:private canonical-src
  (filterv #(and (or (str/starts-with? % "src/") (str/starts-with? % "test/"))
                 (re-find #"\.(cljs|cljc|clj|kotoba)$" %))
           tracked))

(def ^:private view-src   (slurp* "src/maps/tile/view.cljc"))
(def ^:private worker-src (slurp* "src/maps/tile/worker.cljs"))

;; ── 判定 ──────────────────────────────────────────────────────────────────

(def ^:private checks
  [;; ---- repo 全体
   {:what "tracked ファイル数"                        :got (count tracked)         :want 216}
   {:what "tracked な .ts/.tsx（.d.ts 除く）"          :got (count ts-files)        :want 90}
   {:what "dangling symlink 数（kotoba/CHARTER-RIDER.md）"
    :got (count dangling-symlinks) :want 1}
   {:what "識別子位置に kotoba-datomic を持つファイル数（= 構文エラー）"
    :got (count broken-identifier-files) :want 9}
   {:what "Python ファイル数"                          :got (count py-files)        :want 21}
   ;; ---- kotoba/（TypeScript の参照実装。移行対象ではない）
   {:what "kotoba/ のファイル数"                       :got (count kotoba-all)      :want 59}
   {:what "kotoba/ のバイト数（lstat。symlink 自身を含む）"
    :got (bytes-of kotoba-all) :want 338038}
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
   ;; ---- maps-ui appview（移していない。**黙って増やさないための pin**）
   {:what "maps-ui appview の tracked file 数（移行対象外・pin）"
    :got (count (under UI)) :want 73}
   {:what "maps-ui wrangler の絶対パス alias 数"        :got ui-abs-aliases          :want 8}
   {:what "Mapillary token を含む tracked file 数"      :got (count token-files)     :want 2}
   ;; ---- migration.edn の申告
   {:what "migration.edn :canonical-files の件数"
    :got (count (:canonical-files migration)) :want 16}
   {:what "migration.edn :modified-by-migration の件数"
    :got (count (:modified-by-migration migration)) :want 3}
   {:what "migration.edn :removed-by-migration の件数"
    :got (count (:removed-by-migration migration)) :want 11}
   ;; ---- 移行（docs/adr/0001）の不変条件
   {:what "撤去した TypeScript/Svelte が戻っていない（パス名指し）"
    :got removed-still-present :want []}
   {:what "tile-server appview に残る .ts/.tsx"          :got tile-ts                :want []}
   {:what "tile-server appview に残る svelte 由来物（別名も含む）"
    :got tile-svelte-artifacts :want []}
   {:what "tile-server appview の tracked file 数"       :got (count (under TILE))   :want 3}
   {:what "src/ + test/ の正本言語ファイル数（cljs/cljc）" :got (count canonical-src)  :want 4}
   {:what "tile-server wrangler の main"                :got (get tile-wrangler "main") :want "../../dist/worker.js"}
   {:what "tile-server wrangler に assets binding が無い" :got (nil? (get tile-wrangler "assets")) :want true}
   {:what "tile-server wrangler の SvelteKit 用 compat flag 数"
    :got (count (filter #{"nodejs_compat" "nodejs_als"} (or (get tile-wrangler "compatibility_flags") []))) :want 0}
   {:what "tile-server wrangler の vars 数"             :got (count (get tile-wrangler "vars"))   :want 11}
   {:what "tile-server wrangler の routes 数"           :got (count (get tile-wrangler "routes")) :want 2}
   {:what "tile-server wrangler が SvelteKit を名乗っていない"
    :got (boolean (some #(str/includes? (str %) "sveltekit") (vals (get tile-wrangler "vars")))) :want false}
   {:what "shadow の出力先と export と wrangler main が噛み合う"
    :got (and (= "dist" (get-in worker-build [:output-dir]))
              (= "maps.tile.worker/handler" shadow-export)
              (str/includes? (get tile-wrangler "main") "dist/worker.js"))
    :want true}
   {:what ":warnings-as-errors が :compiler-options 配下に在る（EDN として確認。grep しない）"
    :got warnings-as-errors-placed-right? :want true}
   {:what "ページが route 表から描かれる（焼いた値ではない）"
    :got (and (str/includes? view-src "[{:keys [routes withheld vars mcp-url built-at]}]")
              (str/includes? view-src "(route-rows routes)")
              (str/includes? worker-src ":routes route/routes"))
    :want true}])

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
