type RepoRecordRow = {
  uri: string;
  cid: string;
  collection: string;
  rkey: string;
  repo: string;
  repo_rev: string;
  value_json: string;
  indexed_at: string;
  takedown_ref: string | null;
  ts_ms: number;
  created_at: string;
};

type FollowEdgeRow = {
  edge_id: string;
  src_vid: string;
  dst_vid: string;
  _seq: number;
  created_date: string;
  sensitivity_ord: number;
  owner_did: string;
  rkey: string;
  repo: string;
  created_at: string;
};

function slugifyRkeyPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

function hashString(raw: string): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveTs(createdAt?: string | null, nowMs = Date.now()): { tsMs: number; iso: string } {
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
  const tsMs = Number.isFinite(parsed) ? parsed : nowMs;
  return { tsMs, iso: new Date(tsMs).toISOString() };
}

export function buildRepoRecordRow(
  repo: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  nowMs = Date.now(),
): RepoRecordRow {
  const { tsMs, iso } = resolveTs(typeof record.createdAt === "string" ? record.createdAt : null, nowMs);
  const rev = `rw-${tsMs}-${hashString(`${repo}/${collection}/${rkey}/${iso}`)}`;
  return {
    uri: `at://${repo}/${collection}/${rkey}`,
    cid: rev,
    collection,
    rkey,
    repo,
    repo_rev: rev,
    value_json: JSON.stringify(record),
    indexed_at: iso,
    takedown_ref: null,
    ts_ms: tsMs,
    created_at: iso,
  };
}

export function buildFollowEdgeRow(
  srcDid: string,
  dstDid: string,
  rkey: string,
  createdAt?: string | null,
  nowMs = Date.now(),
): FollowEdgeRow {
  const { tsMs, iso } = resolveTs(createdAt, nowMs);
  return {
    edge_id: `at://${srcDid}/app.bsky.graph.follow/${rkey}`,
    src_vid: srcDid,
    dst_vid: dstDid,
    _seq: tsMs,
    created_date: iso.slice(0, 10),
    sensitivity_ord: 300,
    owner_did: srcDid,
    rkey,
    repo: srcDid,
    created_at: iso,
  };
}

export function buildStableRkey(prefix: string, seed: string): string {
  const slug = slugifyRkeyPart(seed) || "item";
  return `${prefix}-${slug}-${hashString(seed)}`;
}
