import { describe, expect, it } from "vitest";

import {
  CELL_RESOLUTIONS,
  buildIngestBatch,
  entityToRow,
  kotobaEndpoint,
  stampCells,
} from "./kotoba-spatial";

describe("kotoba-spatial — H3 cell stamping (the AVET spatial index)", () => {
  it("stamps an owning cell at every queryable resolution, nested correctly", () => {
    const cells = stampCells(35.6812, 139.7671); // Tokyo Station
    for (const r of CELL_RESOLUTIONS) {
      expect(typeof cells[`feature.cell/r${r}`]).toBe("string");
      expect(cells[`feature.cell/r${r}`].length).toBeGreaterThan(0);
    }
    // distinct cells per resolution (coarser ≠ finer)
    expect(cells["feature.cell/r6"]).not.toBe(cells["feature.cell/r12"]);
  });

  it("is deterministic — the same point always stamps the same cells", () => {
    expect(stampCells(35.6812, 139.7671)).toEqual(stampCells(35.6812, 139.7671));
  });

  it("returns no cells for a non-finite centroid (no fabricated index)", () => {
    expect(stampCells(Number.NaN, 139.0)).toEqual({});
  });
});

describe("kotoba-spatial — fail-open endpoint resolution (§3)", () => {
  it("returns null when KOTOBA_ENDPOINT is unset (legacy path serves)", () => {
    expect(kotobaEndpoint({})).toBeNull();
    expect(kotobaEndpoint({ KOTOBA_ENDPOINT: "" })).toBeNull();
  });
  it("normalizes a trailing slash", () => {
    expect(kotobaEndpoint({ KOTOBA_ENDPOINT: "http://localhost:8077/" })).toBe("http://localhost:8077");
  });
});

describe("kotoba-spatial — entity → row materialization (getChunk shape)", () => {
  it("flattens feature claims into the AnyRow fields cmdGetChunk reads", () => {
    const row = entityToRow({
      id: "feature.building.marunouchi-bldg",
      claims: [
        { pred: "feature/label", value: ":building" },
        { pred: "feature/name", value: "Marunouchi Building" },
        { pred: "feature/source-did", value: "did:web:maps.etzhayyim.com:registry:osm" },
        { pred: "feature/lat", value: "35.6809" },
        { pred: "feature/lon", value: "139.7644" },
        { pred: "feature/height-m", value: "179" },
        { pred: "feature/levels", value: "37" },
        { pred: "feature.cell/r12", value: "8c2f5..." }, // index key, not a row field
      ],
    });
    expect(row).not.toBeNull();
    expect(row!.vertex_id).toBe("feature.building.marunouchi-bldg");
    expect(row!.label).toBe("Building"); // restored to the PascalCase the client keys layers by
    expect(row!.name).toBe("Marunouchi Building");
    expect(row!.lat).toBe(35.6809);
    expect(row!.lng).toBe(139.7644);
    const props = row!.props as Record<string, unknown>;
    expect(props.heightM).toBe(179);
    expect(props.levels).toBe(37);
  });

  it("merges a JSON-string geometry claim into props.geometry", () => {
    const row = entityToRow({
      id: "f1",
      claims: [
        { pred: "feature/label", value: ":road" },
        { pred: "feature/geometry", value: JSON.stringify({ type: "LineString", coordinates: [[139, 35], [140, 36]] }) },
      ],
    });
    const props = row!.props as Record<string, unknown>;
    expect((props.geometry as { type: string }).type).toBe("LineString");
  });

  it("keeps geometry when a props-bag claim ALSO arrives (B3 — props must not clobber geometry)", () => {
    // producers emit geometry BEFORE the props bag; the props case must merge, not overwrite
    const row = entityToRow({
      id: "f2",
      claims: [
        { pred: "feature/label", value: ":road" },
        { pred: "feature/geometry", value: JSON.stringify({ type: "Polygon", coordinates: [[[139, 35], [140, 35], [140, 36], [139, 35]]] }) },
        { pred: "feature/props", value: JSON.stringify({ surface: "asphalt", lanes: 4 }) },
      ],
    });
    const props = row!.props as Record<string, unknown>;
    expect((props.geometry as { type: string }).type).toBe("Polygon"); // survives the props claim
    expect(props.surface).toBe("asphalt"); // and the bag is merged in
    expect(props.lanes).toBe(4);
  });

  it("returns null for an entity with no id", () => {
    expect(entityToRow({ claims: [] })).toBeNull();
  });
});

describe("kotoba-spatial — ingest batch (write path)", () => {
  it("builds a kg.ingest_batch with H3 cells + mandatory sourcing, id never duplicated to a claim", () => {
    const batch = buildIngestBatch([
      { vertex_id: "feature.station.tokyo", label: "Station", name: "Tokyo Station", lat: 35.6812, lng: 139.7671 },
    ]);
    expect(batch.entities).toHaveLength(1);
    const e = batch.entities[0] as { id: string; type: string; claims: { pred: string; value: string }[] };
    expect(e.id).toBe("feature.station.tokyo");
    expect(e.type).toBe("maps-feature");
    const preds = e.claims.map((c) => c.pred);
    expect(preds).toContain("feature/label");
    expect(preds).toContain("feature/sourcing"); // G3 — always present
    expect(preds).toContain("feature.cell/r12"); // §2 — spatial index stamped at write
    expect(preds).not.toContain("feature/id"); // id is the entity id, not a claim
    // the legacy PascalCase label is FOLDED to the stored :feature/label keyword (matches
    // ingest.py _LABEL_MAP so AVET(:feature/label, …) matches) — B1/S1
    expect(e.claims.find((c) => c.pred === "feature/label")!.value).toBe(":station");
  });

  it("folds the legacy multi-word labels to their ontology keyword (AdminArea → :admin-area)", () => {
    const batch = buildIngestBatch([
      { vertex_id: "feature.admin-area.jp-13", label: "AdminArea", name: "Tokyo", lat: 35.68, lng: 139.69 },
    ]);
    const e = batch.entities[0] as { claims: { pred: string; value: string }[] };
    expect(e.claims.find((c) => c.pred === "feature/label")!.value).toBe(":admin-area");
  });
});
