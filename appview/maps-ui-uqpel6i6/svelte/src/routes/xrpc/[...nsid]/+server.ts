import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';

const APP_UPSTREAM = 'https://uqpel6i6.etzhayyim.com';
const PDS_UPSTREAM = 'https://atproto.etzhayyim.com';

const ALLOWED_NSID_PREFIXES = ['app.bsky.', 'com.etzhayyim.apps.maps.'];
const ALLOWED_NSID_EXACT = new Set([
  'com.atproto.identity.resolveHandle',
  'com.atproto.repo.getRecord',
  'com.atproto.repo.listRecords',
  'com.atproto.server.describeServer',
]);

function isAllowedNsid(nsid: string): boolean {
  if (ALLOWED_NSID_EXACT.has(nsid)) return true;
  return ALLOWED_NSID_PREFIXES.some((prefix) => nsid.startsWith(prefix));
}

function pickUpstream(nsid: string): string {
  return nsid.startsWith('com.etzhayyim.apps.maps.') ? APP_UPSTREAM : PDS_UPSTREAM;
}

const handle: RequestHandler = async ({ request, params }) => {
  const nsid = params.nsid;
  if (!nsid) {
    return json({ error: 'NsidRequired', message: 'Use /xrpc/{nsid}' }, { status: 400 });
  }
  if (!isAllowedNsid(nsid)) {
    return json({ error: 'NsidNotAllowed', nsid }, { status: 403 });
  }

  const inUrl = new URL(request.url);
  const upstream = pickUpstream(nsid);
  const upstreamUrl = new URL(`/xrpc/${nsid}${inUrl.search}`, upstream);

  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();

  const outbound = new Request(upstreamUrl.toString(), {
    method,
    headers,
    body,
    redirect: 'manual',
  });

  const resp = await fetch(outbound);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
