/**
 * Tier B production demo — registerFeature with writeWithWitnesses.
 *
 * This test demonstrates the full kotoba-datomic L1-witnessed write path
 * applied to a real Tier B surface (Mountain registration in maps):
 *
 *   1. Operator calls registerMountain(...)
 *   2. The maps kotoba wrapper composes the FeatureRecord
 *   3. writeWithWitnesses orchestrates:
 *        a. PDS commit → uri + cid
 *        b. selectWitnesses(cid, fleet, 5) → 5 cells
 *        c. WitnessTransport.requestAttestation fan-out
 *        d. Cell-side produceAttestation runs featureSchemaValidator
 *        e. collectQuorum tallies ≥3 matching verdicts
 *   4. The result includes the witnessed quorum state
 *
 * This is the smoke proof that ADR-2605231400 + ADR-2605231500 + the
 * kotoba maps wiring all compose to a working witnessed write at the
 * Mountain surface. Operator running this against a live PDS + Murakumo
 * fleet would replace the mock client + in-memory transport with the
 * Etzhayyim SDK client + createPdsPollingWitnessTransport — no API
 * change at the call site.
 */

import { describe, expect, it } from "vitest";

import { kotoba-datomic } from "@etzhayyim/sdk";

const {
  createInMemoryWitnessTransport,
  flattenFleet,
  makeDeterministicTestSigner,
  makeStandardCellHandler,
  selectWitnesses,
} = kotoba-datomic;
type FleetCell = kotoba-datomic.FleetCell;

import {
  DEFAULT_FEATURE_MEMBRANE_RULE,
  FEATURE_NSID,
  featureSchemaValidator,
  pointGeometry,
  registerFeature,
  registerMountain,
  type RegisterFeatureClient,
} from "./index.js";

// ─── fixtures ─────────────────────────────────────────────────────────

function fleetOf(nodeCount: number, cellsPerNode: number): FleetCell[] {
  return flattenFleet(
    Array.from({ length: nodeCount }, (_, i) => ({
      hostname: `mocknode-${i}.local`,
      cells: Array.from({ length: cellsPerNode }, (_, j) => `MapsFeatureAttestor${j}`),
    })),
  );
}

function mockClient(
  records: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [],
): RegisterFeatureClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      const rkey = opts.rkey ?? `tid-${counter}`;
      const uri = `at://did:web:maps.etzhayyim.com/${opts.collection}/${rkey}`;
      const cid = `bafy-feature-${counter.toString().padStart(8, "0")}`;
      records.push({ uri, cid, value: opts.record });
      return { uri, cid };
    },
  };
}

function allAcceptHandlers(fleet: readonly FleetCell[]) {
  return new Map(
    fleet.map((cell) => [
      cell.key,
      makeStandardCellHandler({
        cell,
        signer: makeDeterministicTestSigner(cell.cellId),
        validators: { schema: featureSchemaValidator },
      }),
    ]),
  );
}

// ─── L0 (no witness) ──────────────────────────────────────────────────

describe("registerFeature — L0 (no witness)", () => {
  it("plain write returns uri + cid, no witnessState", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const result = await registerFeature(
      {
        label: "Mountain",
        geometryGeoJson: pointGeometry(138.7274, 35.3606),
        h3Cell: "8a30d8bd2477fff",
        h3Resolution: 8,
        name: "富士山 / Mount Fuji",
        rkey: "mount-fuji",
      },
      { client },
    );

    expect(result.uri).toContain("/com.etzhayyim.maps.feature/mount-fuji");
    expect(result.cid).toMatch(/^bafy-feature-/);
    expect(result.witnessState).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0].value.label).toBe("Mountain");
    expect(captured[0].value.h3Cell).toBe("8a30d8bd2477fff");
    expect(captured[0].value.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── L1 (witnessed) — the headline demo ──────────────────────────────

describe("registerMountain — L1 witnessed (Tier B demo)", () => {
  it("end-to-end: mock fleet attests, quorum returns witnessed/accept", async () => {
    const fleet = fleetOf(10, 3); // 30-cell mock fleet
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const transport = createInMemoryWitnessTransport({
      cellHandlers: allAcceptHandlers(fleet),
    });

    const result = await registerMountain(
      {
        name: "富士山 / Mount Fuji",
        lng: 138.7274,
        lat: 35.3606,
        elevationMeters: 3776,
        h3Cell: "8a30d8bd2477fff",
        sourceDid: "did:web:maps.etzhayyim.com:registry:wikidata",
        rkey: "mount-fuji",
      },
      {
        client,
        witness: { fleet, transport },
      },
    );

    // 1. Write happened
    expect(captured).toHaveLength(1);
    expect(captured[0].value.label).toBe("Mountain");
    expect(captured[0].value.name).toBe("富士山 / Mount Fuji");
    const props = JSON.parse(captured[0].value.properties as string);
    expect(props.elevationMeters).toBe(3776);

    // 2. Witness quorum reached
    expect(result.witnessState).toBeDefined();
    expect(result.witnessState!.kind).toBe("witnessed");
    if (result.witnessState!.kind === "witnessed") {
      expect(result.witnessState!.verdict).toBe("accept");
      expect(result.witnessState!.matching.length).toBeGreaterThanOrEqual(
        DEFAULT_FEATURE_MEMBRANE_RULE.quorumThreshold,
      );
    }
  });

  it("malformed record (missing h3Cell) is rejected by featureSchemaValidator", async () => {
    const fleet = fleetOf(10, 3);
    const client = mockClient();
    const transport = createInMemoryWitnessTransport({
      cellHandlers: allAcceptHandlers(fleet),
    });

    // Bypass the convenience helper to construct an invalid record.
    const result = await registerFeature(
      {
        label: "Mountain",
        geometryGeoJson: pointGeometry(138.7274, 35.3606),
        h3Cell: "", // invalid — empty
        h3Resolution: 8,
      },
      { client, witness: { fleet, transport } },
    );

    expect(result.witnessState!.kind).toBe("rejected");
  });

  it("malformed geometry is rejected", async () => {
    const fleet = fleetOf(10, 3);
    const client = mockClient();
    const transport = createInMemoryWitnessTransport({
      cellHandlers: allAcceptHandlers(fleet),
    });

    const result = await registerFeature(
      {
        label: "Mountain",
        geometryGeoJson: '{"type":"NotAGeometry"}',
        h3Cell: "8a30d8bd2477fff",
        h3Resolution: 8,
      },
      { client, witness: { fleet, transport } },
    );

    expect(result.witnessState!.kind).toBe("rejected");
  });

  it("h3Resolution out of range is rejected", async () => {
    const fleet = fleetOf(10, 3);
    const client = mockClient();
    const transport = createInMemoryWitnessTransport({
      cellHandlers: allAcceptHandlers(fleet),
    });

    const result = await registerFeature(
      {
        label: "Mountain",
        geometryGeoJson: pointGeometry(0, 0),
        h3Cell: "abc",
        h3Resolution: 99, // out of [0, 15]
      },
      { client, witness: { fleet, transport } },
    );

    expect(result.witnessState!.kind).toBe("rejected");
  });

  it("partial bbox (3 of 4 fields) is rejected", async () => {
    const fleet = fleetOf(10, 3);
    const client = mockClient();
    const transport = createInMemoryWitnessTransport({
      cellHandlers: allAcceptHandlers(fleet),
    });

    const result = await registerFeature(
      {
        label: "Mountain",
        geometryGeoJson: pointGeometry(0, 0),
        h3Cell: "abc",
        h3Resolution: 8,
        bboxWestE7: 1,
        bboxSouthE7: 2,
        bboxEastE7: 3,
        // bboxNorthE7 missing
      },
      { client, witness: { fleet, transport } },
    );

    expect(result.witnessState!.kind).toBe("rejected");
  });
});

describe("Determinism — same record → same witness set", () => {
  it("two registerFeature calls with the same record CID select the same witnesses", async () => {
    const fleet = fleetOf(10, 3);
    // mockClient generates CIDs deterministically as bafy-feature-{count}.
    // Use selectWitnesses directly to assert the witness set is stable.
    const wsA = await selectWitnesses("bafy-feature-00000001", fleet, 5);
    const wsB = await selectWitnesses("bafy-feature-00000001", fleet, 5);
    expect(wsA.map((c) => c.key)).toEqual(wsB.map((c) => c.key));
  });
});

describe("Membrane rule fixture", () => {
  it("DEFAULT_FEATURE_MEMBRANE_RULE matches the com.etzhayyim.maps.feature NSID", () => {
    expect(DEFAULT_FEATURE_MEMBRANE_RULE.nsid).toBe(FEATURE_NSID);
  });
  it("quorum config is 3-of-5 + council escalation (matches SPEC §5 default)", () => {
    expect(DEFAULT_FEATURE_MEMBRANE_RULE.quorumSize).toBe(5);
    expect(DEFAULT_FEATURE_MEMBRANE_RULE.quorumThreshold).toBe(3);
    expect(DEFAULT_FEATURE_MEMBRANE_RULE.escalationPolicy).toBe("council");
  });
});
