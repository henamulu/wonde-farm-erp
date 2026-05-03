// =============================================================================
// packages/sync/src/index.ts
// =============================================================================
// Wire-format types shared between the NestJS API (apps/api) and the
// React Native mobile client (apps/mobile). These types define the on-the-wire
// JSON contract for /sync/manifest, /sync/pull, and /sync/push.
//
// IMPORTANT: any breaking change here is a wire-protocol change. Bump
// schema_version in SyncService and coordinate a mobile release.
// =============================================================================

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

/** Every table that participates in sync (pull, push, or both). */
export type SyncTable =
  // Reference / pull-only
  | 'crop'
  | 'season'
  | 'sku'
  | 'qc_protocol'
  | 'account'
  | 'warehouse'
  | 'partner'
  | 'employee'
  // Spatial reference
  | 'farm'
  | 'parcel'
  | 'plot'
  | 'infrastructure'
  // Operational (mobile may write some of these)
  | 'crop_plan'
  | 'crop_activity'
  | 'harvest'
  | 'qc_test'
  | 'attendance'
  | 'stock_move';

// -----------------------------------------------------------------------------
// Rows (server -> client during pull)
// -----------------------------------------------------------------------------

export interface SyncRow {
  table: SyncTable;
  id: string;
  server_seq: number;
  updated_at: string;
  deleted: boolean;
  payload: Record<string, unknown> | null;
}

// -----------------------------------------------------------------------------
// Mutations (client -> server during push)
// -----------------------------------------------------------------------------

export type SyncOp = 'create' | 'update';

export interface SyncMutation {
  client_id: string;
  table: SyncTable;
  op: SyncOp;
  id?: string | null;
  payload: Record<string, unknown>;
  client_ts: string;
}

export type MutationResult =
  | { client_id: string; status: 'applied'; id: string; server_seq: number }
  | { client_id: string; status: 'duplicate'; id: string }
  | { client_id: string; status: 'conflict'; reason: string; server_payload: unknown }
  | { client_id: string; status: 'rejected'; reason: string; field?: string };

// -----------------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------------

export type TableVersionMap = Record<string, number>;

export interface ManifestResponse {
  server_now: string;
  schema_version: string;
  table_versions: TableVersionMap;
  must_resync: boolean;
}

// -----------------------------------------------------------------------------
// Pull
// -----------------------------------------------------------------------------

export interface PullRequest {
  device_id?: string;
  cursor?: number;
  tables?: SyncTable[];
  limit?: number;
}

export interface PullResponse {
  rows: SyncRow[];
  next_cursor: number;
  has_more: boolean;
  server_now: string;
}

// -----------------------------------------------------------------------------
// Push
// -----------------------------------------------------------------------------

export interface PushRequest {
  device_id?: string;
  mutations: SyncMutation[];
}

export interface PushResponse {
  results: MutationResult[];
  high_water: number;
}

// -----------------------------------------------------------------------------
// Photos (presigned upload protocol)
// -----------------------------------------------------------------------------

export interface PhotoPresignRequest {
  filenames: string[];
}

export interface PhotoPresignEntry {
  filename: string;
  key: string;
  url: string;
  expires_in: number;
  headers?: Record<string, string>;
}

export interface PhotoPresignResponse {
  uploads: PhotoPresignEntry[];
}

export interface PhotoConfirmRequest {
  client_id: string;
  table: SyncTable;
  photos: Array<{
    key: string;
    taken_at: string;
    geom?: { type: 'Point'; coordinates: [number, number] } | null;
  }>;
}