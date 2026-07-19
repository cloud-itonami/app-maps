/**
 * Verification: Merkle proof of a maps source record against the Base L2
 * anchor. Any client (no creds) can take an AT URI, fetch the record
 * from PDS, traverse upward to the MST root, look up which L2 anchor tx
 * contains that root, and re-check the path cryptographically.
 *
 * Replaces the RW audit-log SELECT (which trusted the DB operator) with
 * a proof anyone can re-check.
 *
 * Usage:
 *   pnpm tsx src/verify.ts at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.source/geocode
 */

import { Etzhayyim } from "@etzhayyim/sdk";

const e = new Etzhayyim({
  did: "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
  anchorContract:
    (process.env.ETZ_ANCHOR_CONTRACT as `0x${string}` | undefined) ??
    undefined,
});

async function main() {
  const uri = process.argv[2];
  if (!uri) {
    console.error("usage: pnpm tsx src/verify.ts <at-uri>");
    process.exit(1);
  }
  const result = await e.verify(uri);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.included ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exit(2);
});
