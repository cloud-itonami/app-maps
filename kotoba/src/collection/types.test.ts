import { describe, expect, it } from "vitest";

import {
  COLLECTION_JOB_KINDS,
  JOB_STATES,
  TERMINAL_JOB_STATES,
  generateJobId,
  isTerminalState,
  isValidBbox,
  isValidJobId,
  isValidProgressBps,
  summariseEvents,
  type JobEventRecord,
} from "./types.js";

describe("isValidJobId", () => {
  it.each([
    ["geocode-bbox-tokyo", true],
    ["seismic-refresh-260523-abcd", true],
    ["gtfs-jp-import-260523-x1y2", true],
    ["abcd", true],
    ["abc", false],
    ["", false],
    ["UPPER", false],
    ["with_underscore", false],
    ["-leading", false],
    ["trailing-", false],
    ["double--hyphen", false],
  ])("isValidJobId(%j) === %s", (id, expected) => {
    expect(isValidJobId(id)).toBe(expected);
  });

  it("rejects > 128 chars", () => {
    const tooLong = "a".repeat(129);
    expect(isValidJobId(tooLong)).toBe(false);
  });
});

describe("generateJobId", () => {
  it("produces a valid jobId", () => {
    const id = generateJobId("geocode", "refresh", new Date("2026-05-23T12:34:00Z"));
    expect(id).toMatch(/^geocode-refresh-2605231234-[a-z0-9]{4}$/);
    expect(isValidJobId(id)).toBe(true);
  });

  it("works for registry-* source slugs", () => {
    const id = generateJobId("registry-gleif", "backfill", new Date("2026-05-23T00:00:00Z"));
    expect(id).toMatch(/^registry-gleif-backfill-2605230000-[a-z0-9]{4}$/);
    expect(isValidJobId(id)).toBe(true);
  });
});

describe("isValidBbox", () => {
  it.each([
    [undefined, undefined, undefined, undefined, true],
    [-180, -90, 180, 90, true],
    [139.5, 35.5, 139.9, 35.8, true],
    [139.5, 35.5, 139.9, undefined, false], // partial
    [-181, -90, 180, 90, false],
    [-180, -91, 180, 90, false],
    [180, -90, 179, 90, false], // west > east
    [-180, 91, 180, 90, false], // south > north
    [-180, 30, 180, 20, false], // south > north
  ])("isValidBbox(%s, %s, %s, %s) === %s", (w, s, e, n, expected) => {
    expect(isValidBbox(w, s, e, n)).toBe(expected);
  });
});

describe("isValidProgressBps", () => {
  it.each([
    [undefined, true],
    [0, true],
    [5000, true],
    [10000, true],
    [-1, false],
    [10001, false],
    [50.5, false],
    [Number.NaN, false],
  ])("isValidProgressBps(%s) === %s", (n, expected) => {
    expect(isValidProgressBps(n as number | undefined)).toBe(expected);
  });
});

describe("isTerminalState", () => {
  it.each([
    ["queued" as const, false],
    ["running" as const, false],
    ["completed" as const, true],
    ["failed" as const, true],
    ["skipped" as const, true],
    ["superseded" as const, true],
  ])("isTerminalState(%s) === %s", (s, expected) => {
    expect(isTerminalState(s)).toBe(expected);
  });
});

describe("constants", () => {
  it("COLLECTION_JOB_KINDS has 9 unique entries", () => {
    expect(COLLECTION_JOB_KINDS).toHaveLength(9);
    expect(new Set(COLLECTION_JOB_KINDS).size).toBe(9);
  });
  it("JOB_STATES has 6 unique entries", () => {
    expect(JOB_STATES).toHaveLength(6);
    expect(new Set(JOB_STATES).size).toBe(6);
  });
  it("TERMINAL_JOB_STATES has 4 entries, all members of JOB_STATES", () => {
    expect(TERMINAL_JOB_STATES).toHaveLength(4);
    for (const s of TERMINAL_JOB_STATES) {
      expect(JOB_STATES).toContain(s);
    }
  });
});

describe("summariseEvents", () => {
  const jobUri = "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.collectionJob/test-job-1";

  it("empty events → null state, eventCount=0", () => {
    const s = summariseEvents(jobUri, []);
    expect(s.state).toBeNull();
    expect(s.eventCount).toBe(0);
    expect(s.terminal).toBe(false);
    expect(s.lastEventAt).toBeNull();
  });

  it("single event → latest state mirrored", () => {
    const events: JobEventRecord[] = [
      {
        v: 1,
        jobUri,
        state: "queued",
        emittedAt: "2026-05-23T12:00:00Z",
      },
    ];
    const s = summariseEvents(jobUri, events);
    expect(s.state).toBe("queued");
    expect(s.terminal).toBe(false);
    expect(s.eventCount).toBe(1);
    expect(s.lastEventAt).toBe("2026-05-23T12:00:00Z");
  });

  it("event cascade: latest state wins, missing fields fall back to earlier events", () => {
    const events: JobEventRecord[] = [
      {
        v: 1,
        jobUri,
        state: "queued",
        emittedAt: "2026-05-23T12:00:00Z",
        phase: "queued",
        itemsTotal: 1000,
      },
      {
        v: 1,
        jobUri,
        state: "running",
        emittedAt: "2026-05-23T12:01:00Z",
        phase: "fetching",
        progressPctBps: 1000,
        itemsProcessed: 100,
      },
      {
        v: 1,
        jobUri,
        state: "running",
        emittedAt: "2026-05-23T12:05:00Z",
        progressPctBps: 5000,
        itemsProcessed: 500,
      },
    ];
    const s = summariseEvents(jobUri, events);
    expect(s.state).toBe("running");
    expect(s.terminal).toBe(false);
    expect(s.eventCount).toBe(3);
    expect(s.lastEventAt).toBe("2026-05-23T12:05:00Z");
    expect(s.progressPctBps).toBe(5000);
    expect(s.itemsProcessed).toBe(500);
    expect(s.itemsTotal).toBe(1000); // cascaded from event 0
    expect(s.phase).toBe("fetching"); // cascaded from event 1 (latest with non-undefined)
  });

  it("terminal state surfaces error fields when failed", () => {
    const events: JobEventRecord[] = [
      {
        v: 1,
        jobUri,
        state: "running",
        emittedAt: "2026-05-23T12:00:00Z",
      },
      {
        v: 1,
        jobUri,
        state: "failed",
        emittedAt: "2026-05-23T12:30:00Z",
        errorClass: "upstream-timeout",
        errorDetail: "Nominatim took > 30s",
      },
    ];
    const s = summariseEvents(jobUri, events);
    expect(s.state).toBe("failed");
    expect(s.terminal).toBe(true);
    expect(s.errorClass).toBe("upstream-timeout");
    expect(s.errorDetail).toBe("Nominatim took > 30s");
  });

  it("respects out-of-order input by sorting internally", () => {
    const events: JobEventRecord[] = [
      { v: 1, jobUri, state: "completed", emittedAt: "2026-05-23T12:30:00Z" },
      { v: 1, jobUri, state: "queued", emittedAt: "2026-05-23T12:00:00Z" },
      { v: 1, jobUri, state: "running", emittedAt: "2026-05-23T12:01:00Z" },
    ];
    const s = summariseEvents(jobUri, events);
    expect(s.state).toBe("completed");
    expect(s.lastEventAt).toBe("2026-05-23T12:30:00Z");
  });
});
