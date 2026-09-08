#!/usr/bin/env nbb
;; verify-custody.cljs — この repo が「与えられたもの」から、**申告していない形で**
;; 動いていないことを検査する。
;;
;;   nbb docs/verify-custody.cljs
;;
;; exit 0 = PASS / 1 = FAIL / 3 = 判定できなかった（0 でも 1 でもない）
;;
;; migration.edn は source を 1 点に固定している（etzhayyim/root@<rev>, <path>）。
;; その subtree を GitHub から取り、**path と blob SHA の集合**を突き合わせる。
;; バイト数ではなく SHA を見るのは、同じ長さの別内容を通さないため。
;;
;; 差分は 3 種類あり、それぞれ migration.edn に**申告**があってはじめて許される:
;;
;;   :canonical-files        upstream に無い（この repo が足した）
;;   :modified-by-migration  path は同じで内容が違う（意図して変えた）
;;   :removed-by-migration   upstream に在って手元に無い（意図して撤去した）
;;
;; ⚠ **申告そのものも検査する。** 撤去したと言いながら在るファイル、変えたと
;;   言いながら 1 バイトも違わないファイル、足したと言いながら upstream にも在る
;;   ファイルは、いずれも FAIL にする。申告が自由に書ける飾りなら、この検査は
;;   「申告を書き足せば何でも通る」になり、落ちようがなくなる。
;;
;; ⚠ **答えられないときは 0 でも 1 でもなく 3 で終わる。** 圏外・gh 未認証・
;;   truncated な応答は「改竄なし」ではない。とくに GitHub の recursive tree API は
;;   大きな repo で **truncated:true** を返し、切り詰められた一覧はそれと分かる
;;   印なしに短くなる —— 実測 2026-08-18、monorepo 全体に対して引くと truncated で、
;;   subtree に対して引くと false だった。ここは subtree だけを引き、truncated なら
;;   結果を捨てる。
;;
;; ⚠ **ファイルを足したら :canonical-files に足すこと。** さもないと次の run が
;;   「乖離」と報告し、本物の乖離と区別が付かなくなる（申告漏れで赤い検査は、
;;   やがて無視される）。

(require '["node:child_process" :as cp]
         '["node:fs" :as fs]
         '[kotoba.lang.text :as str]
         '[clojure.edn :as edn])

(defn- die! [code & msg]
  (binding [*print-fn* *print-err-fn*] (apply println msg))
  (js/process.exit code))

(defn- run [cmd args]
  (try
    (str (cp/execFileSync cmd (clj->js args) #js {:encoding "utf8" :maxBuffer 33554432}))
    (catch :default e
      (die! 3 "UNDETERMINED:" cmd (str/join " " args) "が失敗した —"
            (or (some-> e .-message) "(理由不明)")))))

(when-not (fs/existsSync "migration.edn")
  (die! 3 "UNDETERMINED: migration.edn が無い。この repo のルートで実行すること"))

(def ^:private m
  (try (edn/read-string (fs/readFileSync "migration.edn" "utf8"))
       (catch :default e (die! 3 "UNDETERMINED: migration.edn が読めない —" (.-message e)))))

(def ^:private rev  (:source-revision m))
(def ^:private path (:source-path m))
(def ^:private canonical (set (:canonical-files m)))
(def ^:private modified  (set (:modified-by-migration m)))
(def ^:private removed   (set (:removed-by-migration m)))

(when (or (str/blank? (str rev)) (str/blank? (str path)))
  (die! 3 "UNDETERMINED: migration.edn に :source-revision / :source-path が無い"))
(when (empty? canonical)
  (die! 3 "UNDETERMINED: migration.edn の :canonical-files が空"))

(let [overlap (filter #(or (canonical %) (removed %)) modified)]
  (when (seq overlap)
    (die! 3 "UNDETERMINED: 同じ path が 2 つの申告に載っている:" (str/join ", " overlap))))

;; ── local 側 ──────────────────────────────────────────────────────────────

(def ^:private tracked
  (let [rows (->> (str/split-lines (run "git" ["ls-files" "-s"]))
                  (remove str/blank?)
                  (keep (fn [l]
                          ;; "<mode> <sha> <stage>\t<path>"
                          (let [[meta p] (str/split l #"\t" 2)
                                sha (second (str/split meta #"\s+"))]
                            (when (and p sha) [p sha])))))]
    (when (zero? (count rows))
      (die! 3 "UNDETERMINED: git ls-files -s が空"))
    (into {} rows)))

(def ^:private local (into {} (remove (fn [[p _]] (canonical p)) tracked)))

;; ── upstream 側 ───────────────────────────────────────────────────────────

(def ^:private parent (str/join "/" (butlast (str/split path #"/"))))
(def ^:private leaf   (last (str/split path #"/")))

(def ^:private subtree-sha
  (let [out (run "gh" ["api" (str "repos/etzhayyim/root/contents/" parent "?ref=" rev)
                       "--jq" (str ".[] | select(.name==\"" leaf "\") | .sha")])
        s   (str/trim out)]
    (when (str/blank? s)
      (die! 3 "UNDETERMINED:" path "が upstream@" rev " に見つからない"))
    s))

(def ^:private truncated?
  (= "true" (str/trim (run "gh" ["api" (str "repos/etzhayyim/root/git/trees/" subtree-sha "?recursive=1")
                                 "--jq" ".truncated"]))))

(when truncated?
  (die! 3 "UNDETERMINED: upstream の tree 応答が truncated。切り詰められた一覧で"
        "custody を判定しない"))

(def ^:private upstream
  (let [out (run "gh" ["api" (str "repos/etzhayyim/root/git/trees/" subtree-sha "?recursive=1")
                       "--jq" ".tree[] | select(.type==\"blob\") | [.path, .sha] | @tsv"])
        rows (->> (str/split-lines out)
                  (remove str/blank?)
                  (map #(let [[p sha] (str/split % #"\t")] [p sha])))]
    (when (zero? (count rows))
      (die! 3 "UNDETERMINED: upstream subtree に blob が 1 件も無い"))
    (into {} rows)))

;; ── 突き合わせ ────────────────────────────────────────────────────────────

(def ^:private only-local
  (sort (remove #(contains? upstream %) (keys local))))

(def ^:private only-upstream
  (sort (remove #(or (contains? tracked %) (removed %)) (keys upstream))))

(def ^:private changed
  (sort (for [[p sha] local
              :when (and (contains? upstream p)
                         (not= sha (get upstream p))
                         (not (modified p)))]
          p)))

;; ── 申告そのものの検査 ────────────────────────────────────────────────────

(def ^:private removed-but-present
  (sort (filter #(contains? tracked %) removed)))
(def ^:private removed-not-upstream
  (sort (remove #(contains? upstream %) removed)))
(def ^:private modified-but-identical
  (sort (filter #(and (contains? tracked %) (contains? upstream %)
                      (= (get tracked %) (get upstream %)))
                modified)))
(def ^:private modified-but-absent
  (sort (remove #(and (contains? tracked %) (contains? upstream %)) modified)))
(def ^:private canonical-not-tracked
  (sort (remove #(contains? tracked %) canonical)))
(def ^:private canonical-in-upstream
  (sort (filter #(contains? upstream %) canonical)))

(println (str "SCANNED\t" (count local) " local（:canonical-files " (count canonical) " 件を除く）"
              " vs " (count upstream) " upstream @ " (subs rev 0 7)
              "、申告: modified " (count modified) " / removed " (count removed)))

(def ^:private reports (atom []))
(defn- report [label xs]
  (swap! reports conj [label xs])
  (println (str (if (empty? xs) "  ok   " "  FAIL ") label " " (count xs)))
  (doseq [x (take 10 xs)] (println (str "         " x)))
  (when (> (count xs) 10) (println (str "         … 他 " (- (count xs) 10) " 件"))))

(report "upstream に無い tracked file（未申告の追加）" only-local)
(report "upstream に在るのに手元に無い file（未申告の撤去）" only-upstream)
(report "path は同じで内容が違う file（未申告の変更）" changed)
(report ":removed-by-migration と申告しながら tracked のまま" removed-but-present)
(report ":removed-by-migration と申告しながら upstream に無い" removed-not-upstream)
(report ":modified-by-migration と申告しながら upstream と同一" modified-but-identical)
(report ":modified-by-migration と申告しながら片方に無い" modified-but-absent)
(report ":canonical-files と申告しながら tracked でない" canonical-not-tracked)
(report ":canonical-files と申告しながら upstream にも在る" canonical-in-upstream)

(if (every? (fn [[_ xs]] (empty? xs)) @reports)
  (do (println (str "PASS — " (count local) " blob が etzhayyim/root@" (subs rev 0 7)
                    " の " path " と一致するか、migration.edn に申告済み"))
      (js/process.exit 0))
  (do (println "FAIL — custody が申告なしに動いている。migration.edn に申告すること")
      (js/process.exit 1)))
