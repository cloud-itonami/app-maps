/**
 * Actor types — standalone (no appshellv2 dependency).
 */

export type ActorPerformerType = 'service' | 'system' | 'person' | 'organization';
export type ActorContentMode = 'timeline' | 'interactive' | 'game';
export type ActorLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ActorGameConfig {
  runtime: 'godot' | 'html';
  entry: string;
  assetsBaseUrl: string;
}

export interface ActorProfileView {
  did: string;
  handle: string;
  displayName: string;
  avatar?: string;
  description?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  viewerFollowing?: boolean;
  viewerFollowedBy?: boolean;
  viewerMuted?: boolean;
  viewerBlocked?: string;
  nanoid?: string;
  performerType?: ActorPerformerType;
  contentMode?: ActorContentMode;
  accent?: string;
  icon?: string;
  service?: Record<string, unknown>;
  system?: Record<string, unknown>;
  person?: Record<string, unknown>;
  organization?: Record<string, unknown>;
  embedUrl?: string;
  gameConfig?: ActorGameConfig;
}

export interface ActorContext {
  nanoid: string;
  name: string;
  userId: string;
  actorId: string;
  orgId: string;
  wSend: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  wQuery: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  backend: {
    call: <T>(service: string, method: string, body?: Record<string, unknown>) => Promise<T>;
  };
  sql: {
    exec: (stmt: string, params?: Record<string, unknown>) => Promise<void>;
    query: (stmt: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  };
  navigate: (path: string) => void;
  remoteCall: (pkg: string, iface: string, func: string, params: Uint8Array) => Promise<Uint8Array>;
}

/** Crawler location point normalized to the app's camelCase model */
export interface MapCrawlerLocationPoint {
  'resultId': string;
  'jobId': string;
  title: string;
  url: string;
  host: string;
  ip: string;
  'httpStatus': number;
  'crawledAt': string;
  latitude: number;
  longitude: number;
  country: string;
  region: string;
  city: string;
  isp: string;
  asn: string;
  'serverLocation': string;
  hasLocation: boolean;
  error: string;
}

export function hasLocation(point: MapCrawlerLocationPoint): boolean {
  return point.hasLocation && point.latitude !== 0 && point.longitude !== 0;
}
