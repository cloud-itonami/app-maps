/**
 * Programmatic API for collection plumbing.
 *
 *   import { createCollectionJob, advanceJob, listJobs, getJobStatus }
 *     from "@etzhayyim/maps-kotoba";
 *   // via the `collection` namespace exported from the package root.
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import {
  generateJobId,
  isValidBbox,
  isValidJobId,
  isValidProgressBps,
  summariseEvents,
  type CollectionJobKind,
  type CollectionJobRecord,
  type JobEventRecord,
  type JobState,
  type JobStatusSummary,
} from "./types.js";

export type {
  CollectionJobKind,
  CollectionJobRecord,
  JobEventRecord,
  JobState,
  JobStatusSummary,
} from "./types.js";
export {
  COLLECTION_JOB_KINDS,
  JOB_STATES,
  TERMINAL_JOB_STATES,
  generateJobId,
  isTerminalState,
  isValidBbox,
  isValidJobId,
  isValidProgressBps,
  summariseEvents,
} from "./types.js";

const COLLECTION_JOB = "com.etzhayyim.maps.collectionJob";
const COLLECTION_EVENT = "com.etzhayyim.maps.jobEvent";

function defaultClient(): Etzhayyim {
  return new Etzhayyim({
    did: "did:web:maps.etzhayyim.com",
    pdsUrl: "https://pds.etzhayyim.com",
    ipfsGateway: "https://ipfs.etzhayyim.com",
    l2RpcUrl: "https://mainnet.base.org",
  });
}

export interface CreateCollectionJobInput {
  /** Caller-chosen kebab-case jobId. If omitted, auto-generated from sourceSlug + kind + UTC timestamp + random suffix. */
  jobId?: string;
  /** Slug fragment used when `jobId` is auto-generated (typically the source registry's slug, e.g. 'geocode'). */
  sourceSlug?: string;
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
  createdAt?: string;
}

export interface CreateCollectionJobResult {
  jobId: string;
}

export async function createCollectionJob(
  input: CreateCollectionJobInput,
  opts: { client?: Etzhayyim } = {},
): Promise<CreateCollectionJobResult> {
  const jobId =
    input.jobId ??
    generateJobId(input.sourceSlug ?? "job", input.kind);
  if (!isValidJobId(jobId)) {
    throw new Error(`invalid jobId: ${jobId}`);
  }
  if (!isValidBbox(input.bboxWest, input.bboxSouth, input.bboxEast, input.bboxNorth)) {
    throw new Error(
      `invalid bbox: (${input.bboxWest}, ${input.bboxSouth}, ${input.bboxEast}, ${input.bboxNorth})`,
    );
  }
  const record: CollectionJobRecord = {
    v: 1,
    jobId,
    sourceDid: input.sourceDid,
    kind: input.kind,
    targetCollection: input.targetCollection,
    bboxWest: input.bboxWest,
    bboxSouth: input.bboxSouth,
    bboxEast: input.bboxEast,
    bboxNorth: input.bboxNorth,
    areaDid: input.areaDid,
    params: input.params,
    createdBy: input.createdBy,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const e = opts.client ?? defaultClient();
  await e.write({
    collection: COLLECTION_JOB,
    record: record as unknown as Record<string, unknown>,
    rkey: jobId,
  });
  return { jobId };
}

export interface AdvanceJobInput {
  jobUri: string;
  state: JobState;
  phase?: string;
  progressPctBps?: number;
  itemsProcessed?: number;
  itemsTotal?: number;
  detail?: string;
  errorClass?: string;
  errorDetail?: string;
  emittedAt?: string;
  emittedBy?: string;
}

export async function advanceJob(
  input: AdvanceJobInput,
  opts: { client?: Etzhayyim } = {},
): Promise<void> {
  if (!isValidProgressBps(input.progressPctBps)) {
    throw new Error(`invalid progressPctBps: ${input.progressPctBps}`);
  }
  if (input.state === "failed") {
    if (!input.errorClass) throw new Error(`state=failed requires errorClass`);
    if (!input.errorDetail) throw new Error(`state=failed requires errorDetail`);
  }
  const record: JobEventRecord = {
    v: 1,
    jobUri: input.jobUri,
    state: input.state,
    phase: input.phase,
    progressPctBps: input.progressPctBps,
    itemsProcessed: input.itemsProcessed,
    itemsTotal: input.itemsTotal,
    detail: input.detail,
    errorClass: input.errorClass,
    errorDetail: input.errorDetail,
    emittedAt: input.emittedAt ?? new Date().toISOString(),
    emittedBy: input.emittedBy,
  };
  const e = opts.client ?? defaultClient();
  // rkey omitted → SDK assigns TID per lexicon `key: "tid"`.
  await e.write({
    collection: COLLECTION_EVENT,
    record: record as unknown as Record<string, unknown>,
  });
}

export interface ListJobsOpts {
  prefix?: string;
  kind?: CollectionJobKind;
  sourceDid?: string;
  limit?: number;
  client?: Etzhayyim;
}

export async function listJobs(opts: ListJobsOpts = {}): Promise<CollectionJobRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<CollectionJobRecord>({
    collection: COLLECTION_JOB,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
  });
  return records
    .map((r) => r.value)
    .filter((v) => {
      if (opts.kind && v.kind !== opts.kind) return false;
      if (opts.sourceDid && v.sourceDid !== opts.sourceDid) return false;
      return true;
    });
}

export interface JobStatusOpts {
  client?: Etzhayyim;
  eventLimit?: number;
}

export interface JobStatusResult {
  job: CollectionJobRecord;
  jobUri: string;
  events: JobEventRecord[];
  summary: JobStatusSummary;
}

export async function getJobStatus(
  jobId: string,
  opts: JobStatusOpts = {},
): Promise<JobStatusResult | null> {
  const e = opts.client ?? defaultClient();
  const { records: jobs } = await e.read<CollectionJobRecord>({
    collection: COLLECTION_JOB,
    rkey: jobId,
  });
  const job = jobs[0];
  if (!job) return null;
  const { records: rawEvents } = await e.read<JobEventRecord>({
    collection: COLLECTION_EVENT,
    prefix: "",
    limit: opts.eventLimit ?? 500,
  });
  const events = rawEvents.map((r) => r.value).filter((v) => v.jobUri === job.uri);
  const summary = summariseEvents(job.uri, events);
  return { job: job.value, jobUri: job.uri, events, summary };
}
