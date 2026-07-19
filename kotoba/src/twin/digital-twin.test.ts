/**
 * Digital Twin integration tests — bindDevice / updateTwinState /
 * updateOccupancy / setSensorAlert. Covers L0 (plain write) + L1
 * witnessed end-to-end using the same in-memory transport as the
 * feature module witnessed tests.
 */

import { describe, expect, it } from "vitest";

import { kotoba-datomic } from "@etzhayyim/sdk";

import { featureSchemaValidator } from "../feature/membrane.js";
import {
  bindDevice,
  setSensorAlert,
  updateOccupancy,
  updateTwinState,
  type TwinClient,
} from "./index.js";

const {
  createInMemoryWitnessTransport,
  flattenFleet,
  makeDeterministicTestSigner,
  makeStandardCellHandler,
} = kotoba-datomic;
type FleetCell = kotoba-datomic.FleetCell;
type MembraneRule = kotoba-datomic.MembraneRule;

// ─── fixtures ─────────────────────────────────────────────────────────

function mockClient(captured: Array<{ collection: string; rkey?: string; uri: string; cid: string; value: Record<string, unknown> }> = []): TwinClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      const rkey = opts.rkey ?? `tid-${counter}`;
      const uri = `at://did:web:maps.etzhayyim.com/${opts.collection}/${rkey}`;
      const cid = `bafy-twin-${counter.toString().padStart(8, "0")}`;
      captured.push({ collection: opts.collection, rkey: opts.rkey, uri, cid, value: opts.record });
      return { uri, cid };
    },
  };
}

function fleetOf(nodes: number, cellsPerNode: number): FleetCell[] {
  return flattenFleet(
    Array.from({ length: nodes }, (_, i) => ({
      hostname: `mocknode-${i}.local`,
      cells: Array.from({ length: cellsPerNode }, (_, j) => `MapsTwinAttestor${j}`),
    })),
  );
}

function mockRule(nsid: string): MembraneRule {
  return {
    v: 1,
    nsid,
    schemaRef: { path: "lex.json", contentHash: "0".repeat(64), version: "1.0.0" },
    policyRef: { path: "policy.rego", contentHash: "0".repeat(64), version: "1.0.0" },
    cellRef: { path: "cell/", contentHash: "0".repeat(64), version: "abcdef0" },
    quorumSize: 5,
    quorumThreshold: 3,
    escalationPolicy: "council",
    registeredAt: "2026-05-23T00:00:00Z",
  };
}

// ─── bindDevice ───────────────────────────────────────────────────

describe("bindDevice — L0", () => {
  it("emits a deviceBinding record (TID rkey, no explicit key)", async () => {
    const captured: Array<{ collection: string; rkey?: string; uri: string; cid: string; value: Record<string, unknown> }> = [];
    const r = await bindDevice(
      {
        deviceUri: "at://did:web:maps/sensor/temp-203",
        assetUri: "at://did:web:maps/building/main",
        relation: "Monitors",
        operatorDid: "did:web:opt.example",
        notes: "Installed during HVAC upgrade",
      },
      { client: mockClient(captured) },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.deviceBinding");
    expect(captured[0].rkey).toBeUndefined(); // TID assigned by PDS
    const v = captured[0].value;
    expect(v.v).toBe(1);
    expect(v.deviceUri).toBe("at://did:web:maps/sensor/temp-203");
    expect(v.relation).toBe("Monitors");
    expect(v.notes).toBe("Installed during HVAC upgrade");
    expect(typeof v.boundAt).toBe("string");
    expect(r.witnessState).toBeUndefined();
  });
});

// ─── updateTwinState ──────────────────────────────────────────────

describe("updateTwinState", () => {
  it("scalar observation: occupancy headcount via stateKind discriminator", async () => {
    const captured: Array<{ collection: string; uri: string; cid: string; value: Record<string, unknown> }> = [];
    await updateTwinState(
      {
        subjectUri: "at://did:web:maps/building/main",
        stateKind: "occupancy",
        valueNumeric: 142,
        unit: "count",
        confidence: 0.95,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.stateKind).toBe("occupancy");
    expect(v.valueNumeric).toBe(142);
    expect(v.unit).toBe("count");
    expect(v.confidence).toBe(0.95);
  });

  it("rejects out-of-range confidence", async () => {
    await expect(
      updateTwinState(
        { subjectUri: "x", stateKind: "health", valueNumeric: 1, confidence: 1.5 },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/confidence must be in/);
  });

  it("categorical observation: maintenance status", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await updateTwinState(
      {
        subjectUri: "at://x/y/z",
        stateKind: "maintenance",
        valueText: "scheduled-2026-06-01",
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].value.stateKind).toBe("maintenance");
    expect(captured[0].value.valueText).toBe("scheduled-2026-06-01");
  });
});

// ─── updateOccupancy (twinState convenience) ─────────────────────

describe("updateOccupancy", () => {
  it("delegates to twinState with stateKind=occupancy + unit=count", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await updateOccupancy(
      {
        subjectUri: "at://did:web:maps/building/main",
        headcount: 87,
        confidence: 0.99,
      },
      { client: mockClient(captured as any) },
    );
    const v = captured[0].value;
    expect(v.stateKind).toBe("occupancy");
    expect(v.valueNumeric).toBe(87);
    expect(v.unit).toBe("count");
    expect(v.confidence).toBe(0.99);
  });
});

// ─── setSensorAlert ───────────────────────────────────────────────

describe("setSensorAlert", () => {
  it("emits a sensorAlert record with literal rkey = alertId", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    await setSensorAlert(
      {
        alertId: "co2-too-high-r408",
        subjectUri: "at://did:web:maps/sensor/co2-r408",
        name: "Room 408 CO2 high",
        condition: "valueNumeric > 1000",
        severity: "warning",
        scope: "environment",
        throttleSeconds: 60,
        notifyDids: ["did:web:ops.example", "did:web:facilities.example"],
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].collection).toBe("com.etzhayyim.maps.sensorAlert");
    expect(captured[0].rkey).toBe("co2-too-high-r408");
    const v = captured[0].value;
    expect(v.alertId).toBe("co2-too-high-r408");
    expect(v.severity).toBe("warning");
    expect((v.notifyDids as string[])).toHaveLength(2);
  });

  it("rejects invalid alertId", async () => {
    await expect(
      setSensorAlert(
        { alertId: "UPPER-CASE", subjectUri: "x", condition: "y", severity: "info" },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/invalid alertId/);
  });

  it("rejects throttleSeconds negative or non-integer", async () => {
    await expect(
      setSensorAlert(
        { alertId: "a", subjectUri: "x", condition: "y", severity: "info", throttleSeconds: -1 },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/throttleSeconds/);
    await expect(
      setSensorAlert(
        { alertId: "a", subjectUri: "x", condition: "y", severity: "info", throttleSeconds: 1.5 },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/throttleSeconds/);
  });

  it("rejects notifyDids > 20 (lexicon cap)", async () => {
    const dids = Array.from({ length: 21 }, (_, i) => `did:web:n${i}.example`);
    await expect(
      setSensorAlert(
        { alertId: "a", subjectUri: "x", condition: "y", severity: "info", notifyDids: dids },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/notifyDids exceeds/);
  });
});

// ─── L1 witnessed end-to-end ──────────────────────────────────────

describe("L1 witnessed (Tier B) — updateOccupancy end-to-end", () => {
  it("occupancy observation with 30-cell fleet → witnessed/accept", async () => {
    const fleet = fleetOf(10, 3);
    const captured: Array<{ value: Record<string, unknown> }> = [];
    const transport = createInMemoryWitnessTransport({
      cellHandlers: new Map(
        fleet.map((cell) => [
          cell.key,
          makeStandardCellHandler({
            cell,
            signer: makeDeterministicTestSigner(cell.cellId),
            // featureSchemaValidator checks the Feature lexicon; for the
            // twinState lexicon we use the default always-accept stubs,
            // matching what a real twinState membrane validator would do
            // before a lexicon-specific schema check lands.
            validators: {},
          }),
        ]),
      ),
    });
    const result = await updateOccupancy(
      {
        subjectUri: "at://did:web:maps/building/main",
        headcount: 142,
        confidence: 0.92,
      },
      {
        client: mockClient(captured as any),
        witness: { fleet, transport, rule: mockRule("com.etzhayyim.maps.twinState") },
      },
    );
    expect(captured[0].value.stateKind).toBe("occupancy");
    expect(result.witnessState!.kind).toBe("witnessed");
  });
});

// ─── L1 witnessed — bindDevice ────────────────────────────────────

describe("L1 witnessed — bindDevice end-to-end", () => {
  it("Monitors binding with 30-cell fleet → witnessed/accept", async () => {
    const fleet = fleetOf(10, 3);
    const transport = createInMemoryWitnessTransport({
      cellHandlers: new Map(
        fleet.map((cell) => [
          cell.key,
          makeStandardCellHandler({
            cell,
            signer: makeDeterministicTestSigner(cell.cellId),
            validators: {},
          }),
        ]),
      ),
    });
    const result = await bindDevice(
      {
        deviceUri: "at://did:web:maps/sensor/temp-203",
        assetUri: "at://did:web:maps/building/main",
        relation: "Monitors",
      },
      {
        client: mockClient(),
        witness: { fleet, transport, rule: mockRule("com.etzhayyim.maps.deviceBinding") },
      },
    );
    expect(result.witnessState!.kind).toBe("witnessed");
  });
});
