/**
 * Mirrors com.etzhayyim.maps.collectionJob + com.etzhayyim.maps.jobEvent.
 * Source lexicons: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/
 */

// ─── CollectionJob ───────────────────────────────────────────────────

export type CollectionJobKind =
  | "fetch"
  | "import"
  | "backfill"
  | "refresh"
  | "validate"
  | "vision"
  | "satellite"
  | "geocode"
  | "other";

export const COLLECTION_JOB_KINDS: readonly CollectionJobKind[] = [
  "fetch",
  "import",
  "backfill",
  "refresh",
  "validate",
  "vision",
  "satellite",
  "geocode",
  "other",
];

export interface CollectionJobRecord {
  v: 1;
  jobId: string;
  sourceDid: string;
  kind: CollectionJobKind;
  targetCollection?: string;
  bboxWest?: number;
  bboxSouth?: number;
  bboxEast?: number;
  bboxNorth?: number;
  areaDid?: string;
  params?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

/** jobId — kebab-case, 4-128 chars, no leading/trailing/double hyphens. */
export function isValidJobId(jobId: string): boolean {
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(jobId) &&
    jobId.length >= 4 &&
    jobId.length <= 128
  );
}

/**
 * Suggested jobId generator: `{sourceSlug}-{kind}-{yyyymmddhhmm}-{rand4}`.
 * Caller is free to mint their own; this is purely a convenience.
 */
export function generateJobId(
  sourceSlug: string,
  kind: CollectionJobKind,
  now: Date = new Date(),
): string {
  const ts =
    now.getUTCFullYear().toString().slice(2) +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  const id = `${sourceSlug}-${kind}-${ts}-${rand}`;
  if (!isValidJobId(id)) {
    throw new Error(`generated jobId failed validation: ${id}`);
  }
  return id;
}

/** WGS84 sanity check for a bbox quad. All four must be present or all absent. */
export function isValidBbox(
  west?: number,
  south?: number,
  east?: number,
  north?: number,
): boolean {
  const provided = [west, south, east, north].filter((x) => x !== undefined);
  if (provided.length === 0) return true;
  if (provided.length !== 4) return false;
  if (west! < -180 || west! > 180 || east! < -180 || east! > 180) return false;
  if (south! < -90 || south! > 90 || north! < -90 || north! > 90) return false;
  if (west! > east!) return false; // antimeridian crossing is signalled separately
  if (south! > north!) return false;
  return true;
}

// ─── JobEvent ────────────────────────────────────────────────────────

export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "superseded";

export const JOB_STATES: readonly JobState[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "superseded",
];

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "completed",
  "failed",
  "skipped",
  "superseded",
];

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export interface JobEventRecord {
  v: 1;
  jobUri: string;
  state: JobState;
  phase?: string;
  progressPctBps?: number;
  itemsProcessed?: number;
  itemsTotal?: number;
  detail?: string;
  errorClass?: string;
  errorDetail?: string;
  emittedAt: string;
  emittedBy?: string;
}

/** progressPctBps validation — integer in [0, 10000] or undefined. */
export function isValidProgressBps(n: number | undefined): boolean {
  if (n === undefined) return true;
  return Number.isInteger(n) && n >= 0 && n <= 10000;
}

/**
 * Reduce a sorted event stream to a single "latest state" view.
 *   - state = state of the most recent event
 *   - lastEventAt = emittedAt of the most recent event
 *   - latest progress / phase / detail = from the most recent non-empty value
 *   - terminal = whether `state` is in TERMINAL_JOB_STATES
 *
 * Caller is responsible for sorting `events` by emittedAt ascending.
 */
export interface JobStatusSummary {
  jobUri: string;
  state: JobState | null;
  terminal: boolean;
  lastEventAt: string | null;
  phase?: string;
  progressPctBps?: number;
  itemsProcessed?: number;
  itemsTotal?: number;
  detail?: string;
  errorClass?: string;
  errorDetail?: string;
  eventCount: number;
}

export function summariseEvents(
  jobUri: string,
  events: readonly JobEventRecord[],
): JobStatusSummary {
  if (events.length === 0) {
    return {
      jobUri,
      state: null,
      terminal: false,
      lastEventAt: null,
      eventCount: 0,
    };
  }
  const sorted = [...events].sort((a, b) => a.emittedAt.localeCompare(b.emittedAt));
  const latest = sorted[sorted.length - 1];
  const summary: JobStatusSummary = {
    jobUri,
    state: latest.state,
    terminal: isTerminalState(latest.state),
    lastEventAt: latest.emittedAt,
    eventCount: sorted.length,
  };
  // Cascade from latest backwards for optional fields that may not be set on every event.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const ev = sorted[i];
    if (summary.phase === undefined && ev.phase !== undefined) summary.phase = ev.phase;
    if (summary.progressPctBps === undefined && ev.progressPctBps !== undefined) summary.progressPctBps = ev.progressPctBps;
    if (summary.itemsProcessed === undefined && ev.itemsProcessed !== undefined) summary.itemsProcessed = ev.itemsProcessed;
    if (summary.itemsTotal === undefined && ev.itemsTotal !== undefined) summary.itemsTotal = ev.itemsTotal;
    if (summary.detail === undefined && ev.detail !== undefined) summary.detail = ev.detail;
  }
  if (summary.state === "failed") {
    summary.errorClass = latest.errorClass;
    summary.errorDetail = latest.errorDetail;
  }
  return summary;
}
