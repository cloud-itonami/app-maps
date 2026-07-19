/**
 * Query: list collection jobs + get job status (job + events + summary).
 * Replaces the 4 RW handlers: createCollectionJob (write) + advanceJob (write)
 * + listJobs (read) + getJobStatus (read).
 *
 * Usage:
 *   pnpm tsx src/collection/query.ts                                # all jobs
 *   pnpm tsx src/collection/query.ts --jobId=geocode-bbox-tokyo
 *   pnpm tsx src/collection/query.ts --prefix=registry-
 *   pnpm tsx src/collection/query.ts --kind=refresh
 *   pnpm tsx src/collection/query.ts --state=running
 *   pnpm tsx src/collection/query.ts --status=geocode-bbox-tokyo        # job + events + summary
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import {
  summariseEvents,
  type CollectionJobKind,
  type CollectionJobRecord,
  type JobEventRecord,
  type JobState,
  type JobStatusSummary,
} from "./types.js";

const COLLECTION_JOB = "com.etzhayyim.maps.collectionJob";
const COLLECTION_EVENT = "com.etzhayyim.maps.jobEvent";

const e = new Etzhayyim({
  did: process.env.ETZ_READER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
});

interface Args {
  jobId?: string;
  prefix?: string;
  kind?: CollectionJobKind;
  state?: JobState;
  status?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    const m = a.match(/^--(\w+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "limit") out.limit = Number(v);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function eventsFor(jobUri: string): Promise<JobEventRecord[]> {
  const { records } = await e.read<JobEventRecord>({
    collection: COLLECTION_EVENT,
    prefix: "",
    limit: 500,
  });
  return records.map((r) => r.value).filter((v) => v.jobUri === jobUri);
}

async function statusFor(jobId: string): Promise<{
  job: CollectionJobRecord | null;
  events: JobEventRecord[];
  summary: JobStatusSummary;
} | null> {
  const { records } = await e.read<CollectionJobRecord>({
    collection: COLLECTION_JOB,
    rkey: jobId,
  });
  const job = records[0];
  if (!job) return null;
  const jobUri = job.uri;
  const events = await eventsFor(jobUri);
  return { job: job.value, events, summary: summariseEvents(jobUri, events) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.status) {
    const result = await statusFor(args.status);
    if (!result) {
      console.error(`[query:status] no job with id=${args.status}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.jobId) {
    const { records } = await e.read<CollectionJobRecord>({
      collection: COLLECTION_JOB,
      rkey: args.jobId,
    });
    console.log(JSON.stringify(records[0] ?? null, null, 2));
    return;
  }

  const { records } = await e.read<CollectionJobRecord>({
    collection: COLLECTION_JOB,
    prefix: args.prefix ?? "",
    limit: args.limit ?? 100,
  });

  // Optional state filter requires fetching events per job — keep this
  // CLI behaviour explicit: only attach summary when --state is set.
  const withSummary = await Promise.all(
    records.map(async (r) => {
      if (!args.kind && !args.state) return { record: r, summary: null as JobStatusSummary | null };
      if (args.kind && r.value.kind !== args.kind) return null;
      if (!args.state) return { record: r, summary: null };
      const events = await eventsFor(r.uri);
      const summary = summariseEvents(r.uri, events);
      if (summary.state !== args.state) return null;
      return { record: r, summary };
    }),
  );
  const filtered = withSummary.filter((x): x is { record: typeof records[number]; summary: JobStatusSummary | null } => x !== null);

  console.log(`[query:collection] ${filtered.length}/${records.length} jobs`);
  for (const { record, summary } of filtered) {
    const v = record.value;
    const tail = summary ? `  [${summary.state}]` : "";
    console.log(`  ${v.jobId.padEnd(48)}  ${v.kind.padEnd(10)}  ${v.sourceDid}${tail}`);
  }
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[query:collection] fatal:", err);
    process.exit(2);
  });
}
