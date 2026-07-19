#!/usr/bin/env bb
;; maps bulk-ingest — bb-native test runner (Clojure / babashka; NOT shell, per
;; repo rule "ship run_tests.clj, not run_tests.sh"). Run from this dir so the
;; scoped bb.edn (classpath root) is picked up:
;;
;;   cd 60-apps/etzhayyim-project-maps/bulk-ingest/clj && bb run_tests.clj
;;   # or: bb test
;;
;; Classpath root = this file's dir, so a co-located .cljc at
;;   maps/bulk_ingest/<x>.cljc  ⇒  ns  maps.bulk-ingest.<x>.
(require '[babashka.classpath :as cp]
         '[babashka.fs :as fs]
         '[clojure.test :as t])

(cp/add-classpath (str (fs/parent (fs/absolutize *file*))))

(def suites '[maps.bulk-ingest.tests.test-kotoba-substrate])

(apply require suites)

(let [{:keys [fail error]} (apply t/run-tests suites)]
  (if (zero? (+ fail error))
    (println "── maps bulk-ingest: ALL suites green ──")
    (do (println "── maps bulk-ingest: FAILURES above ──")
        (System/exit 1))))
