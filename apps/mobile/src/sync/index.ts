// =============================================================================
// apps/mobile/src/sync/index.ts
// =============================================================================
// Offline-first sync engine for the Farm ERP mobile client.
//
// In production split into:
//   sync/types.ts            (or import from @farm-erp/sync)
//   sync/database.ts         (WatermelonDB adapter + schema)
//   sync/models/*.ts         (Plot, CropActivity, MutationQueue, ...)
//   sync/api-client.ts       (fetch wrapper with auth + retry)
//   sync/queue.ts            (mutation queue helpers)
//   sync/photo-uploader.ts   (presign + PUT to MinIO)
//   sync/engine.ts           (state machine)
//   sync/hooks.ts             (React hooks for UI)
//
// Required deps:
//   npm i @nozbe/watermelondb @nozbe/with-observables
//   npm i @react-native-community/netinfo
//   npm i react-native-mmkv
//   npm i expo-background-fetch expo-task-manager   # if using Expo
// =============================================================================

import { Database, Model, Q, appSchema, tableSchema } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { field, text, json, readonly, date, writer } from '@nozbe/watermelondb/decorators';
import NetInfo from '@react-native-community/netinfo';
import { MMKV } from 'react-native-mmkv';
import { useEffect, useState, useSyncExternalStore } from 'react';

// =============================================================================
// 1. Wire-format types — must match server (packages/sync)
// =============================================================================

export type SyncTable =
  | 'farm' | 'parcel' | 'plot' | 'infrastructure' | 'sensor'
  | 'crop' | 'season' | 'crop_plan'
  | 'crop_activity' | 'harvest' | 'qc_test' | 'attendance' | 'stock_move'
  | 'sku' | 'warehouse' | 'qc_protocol' | 'account' | 'partner' | 'employee';

export interface SyncRow {
  table: SyncTable;
  id: string;
  server_seq: number;
  updated_at: string;
  deleted: boolean;
  payload: Record<string, unknown> | null;
}
export interface SyncMutation {
  client_id: string;
  table: SyncTable;
  op: 'create' | 'update';
  id?: string | null;
  payload: Record<string, unknown>;
  client_ts: string;
}
export type MutationResult =
  | { client_id: string; status: 'applied'; id: string; server_seq: number }
  | { client_id: string; status: 'duplicate'; id: string }
  | { client_id: string; status: 'conflict'; reason: string; server_payload: unknown }
  | { client_id: string; status: 'rejected'; reason: string; field?: string };

// Tables the mobile is allowed to write (mirrors server policy)
export const WRITEABLE: Partial<Record<SyncTable, ('create' | 'update')[]>> = {
  crop_activity: ['create', 'update'],
  harvest:       ['create'],
  qc_test:       ['create'],
  attendance:    ['create', 'update'],
  stock_move:    ['create'],
};

// =============================================================================
// 2. WatermelonDB schema + a couple of representative models
// =============================================================================
// Add a model per syncable table you actually render. The mutation queue and
// sync metadata tables are infrastructure — always present.

export const schema = appSchema({
  version: 1,
  tables: [
    // --- domain models (subset — extend as needed) ---
    tableSchema({
      name: 'plots',
      columns: [
        { name: 'remote_id',     type: 'string', isIndexed: true },
        { name: 'parcel_id',     type: 'string', isIndexed: true },
        { name: 'code',          type: 'string' },
        { name: 'area_ha',       type: 'number', isOptional: true },
        { name: 'geom_json',     type: 'string' }, // GeoJSON serialized
        { name: 'server_seq',    type: 'number' },
        { name: 'updated_at',    type: 'number' },
        { name: 'deleted',       type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'crop_activities',
      columns: [
        { name: 'remote_id',      type: 'string', isIndexed: true, isOptional: true },
        { name: 'client_id',      type: 'string', isIndexed: true },
        { name: 'crop_plan_id',   type: 'string', isIndexed: true },
        { name: 'type',           type: 'string' },
        { name: 'scheduled_at',   type: 'number', isOptional: true },
        { name: 'started_at',     type: 'number', isOptional: true },
        { name: 'completed_at',   type: 'number', isOptional: true },
        { name: 'performed_by_id',type: 'string', isOptional: true },
        { name: 'inputs_json',    type: 'string' },
        { name: 'geom_json',      type: 'string', isOptional: true },
        { name: 'photos_json',    type: 'string' },
        { name: 'notes',          type: 'string', isOptional: true },
        { name: 'status',         type: 'string' },
        { name: 'server_seq',     type: 'number' },
        { name: 'sync_state',     type: 'string' }, // 'synced' | 'pending' | 'rejected'
      ],
    }),
    // --- sync infrastructure ---
    tableSchema({
      name: 'mutation_queue',
      columns: [
        { name: 'client_id',  type: 'string', isIndexed: true },
        { name: 'table_name', type: 'string', isIndexed: true },
        { name: 'op',         type: 'string' },
        { name: 'remote_id',  type: 'string', isOptional: true },
        { name: 'payload',    type: 'string' },              // JSON
        { name: 'attempts',   type: 'number' },
        { name: 'last_error', type: 'string', isOptional: true },
        { name: 'status',     type: 'string', isIndexed: true }, // pending | sending | done | rejected
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'photo_queue',
      columns: [
        { name: 'client_id',   type: 'string', isIndexed: true },
        { name: 'parent_table',type: 'string' },
        { name: 'local_uri',   type: 'string' },
        { name: 'remote_key',  type: 'string', isOptional: true },
        { name: 'taken_at',    type: 'number' },
        { name: 'lat',         type: 'number', isOptional: true },
        { name: 'lon',         type: 'number', isOptional: true },
        { name: 'status',      type: 'string', isIndexed: true }, // pending | uploading | done | failed
        { name: 'attempts',    type: 'number' },
      ],
    }),
    tableSchema({
      name: 'sync_conflicts',
      columns: [
        { name: 'client_id',     type: 'string' },
        { name: 'table_name',    type: 'string' },
        { name: 'reason',        type: 'string' },
        { name: 'client_payload',type: 'string' },
        { name: 'server_payload',type: 'string' },
        { name: 'created_at',    type: 'number' },
      ],
    }),
  ],
});

// Models — one per table. WMDB reads/writes go through these.

export class Plot extends Model {
  static table = 'plots';
  @text('remote_id')   remoteId!: string;
  @text('parcel_id')   parcelId!: string;
  @text('code')        code!: string;
  @field('area_ha')    areaHa!: number;
  @text('geom_json')   geomJson!: string;
  @field('server_seq') serverSeq!: number;
  @date('updated_at')  updatedAt!: Date;
  @field('deleted')    deleted!: boolean;
}

export class CropActivity extends Model {
  static table = 'crop_activities';
  @text('remote_id')      remoteId?: string;
  @text('client_id')      clientId!: string;
  @text('crop_plan_id')   cropPlanId!: string;
  @text('type')           type!: string;
  @text('inputs_json')    inputsJson!: string;
  @text('photos_json')    photosJson!: string;
  @text('status')         status!: string;
  @text('sync_state')     syncState!: 'synced' | 'pending' | 'rejected';
  @field('server_seq')    serverSeq!: number;
  @readonly @date('created_at') createdAt!: Date;
}

export class MutationRow extends Model {
  static table = 'mutation_queue';
  @text('client_id')  clientId!: string;
  @text('table_name') tableName!: string;
  @text('op')         op!: 'create' | 'update';
  @text('remote_id')  remoteId?: string;
  @text('payload')    payload!: string;
  @field('attempts')  attempts!: number;
  @text('last_error') lastError?: string;
  @text('status')     status!: 'pending' | 'sending' | 'done' | 'rejected';
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}

export class PhotoQueueRow extends Model {
  static table = 'photo_queue';
  @text('client_id')   clientId!: string;
  @text('parent_table')parentTable!: string;
  @text('local_uri')   localUri!: string;
  @text('remote_key')  remoteKey?: string;
  @date('taken_at')    takenAt!: Date;
  @field('lat')        lat?: number;
  @field('lon')        lon?: number;
  @text('status')      status!: 'pending' | 'uploading' | 'done' | 'failed';
  @field('attempts')   attempts!: number;
}

const adapter = new SQLiteAdapter({ schema, dbName: 'farmerp.db' /* , jsi: true */ });
export const database = new Database({
  adapter,
  modelClasses: [Plot, CropActivity, MutationRow, PhotoQueueRow],
});

// =============================================================================
// 3. Persistent KV — auth tokens, sync cursor, device id
// =============================================================================

const kv = new MMKV({ id: 'farmerp-sync' });

export const Storage = {
  getAccessToken: () => kv.getString('access_token') ?? null,
  setAccessToken: (t: string) => kv.set('access_token', t),
  getRefreshToken: () => kv.getString('refresh_token') ?? null,
  setRefreshToken: (t: string) => kv.set('refresh_token', t),

  getDeviceId: (): string => {
    let id = kv.getString('device_id');
    if (!id) { id = crypto.randomUUID(); kv.set('device_id', id); }
    return id;
  },

  getCursor: (): number => kv.getNumber('cursor') ?? 0,
  setCursor: (n: number) => kv.set('cursor', n),

  getLastSyncAt: (): number | null => kv.getNumber('last_sync_at') ?? null,
  setLastSyncAt: (n: number) => kv.set('last_sync_at', n),
};

// =============================================================================
// 4. API client — auth, refresh, abortable, retry-aware
// =============================================================================

class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  /** Permanent errors (4xx) shouldn't be retried. */
  get permanent() { return this.status >= 400 && this.status < 500 && this.status !== 401; }
}

interface ApiOptions { baseUrl: string; }

export class Api {
  constructor(private opts: ApiOptions) {}

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = this.opts.baseUrl + path;
    const tryOnce = async (token: string | null): Promise<Response> =>
      fetch(url, {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

    let res = await tryOnce(Storage.getAccessToken());
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (!refreshed) throw new ApiError(401, { error: 'unauthenticated' });
      res = await tryOnce(Storage.getAccessToken());
    }
    if (!res.ok) {
      const text = await res.text();
      let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
      throw new ApiError(res.status, parsed);
    }
    return (await res.json()) as T;
  }

  /** Direct PUT to MinIO via presigned URL — no auth header. */
  async putBinary(url: string, blob: Blob, signal?: AbortSignal): Promise<void> {
    const res = await fetch(url, {
      method: 'PUT', signal,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
  }

  private async refresh(): Promise<boolean> {
    const rt = Storage.getRefreshToken();
    if (!rt) return false;
    try {
      const out = await fetch(this.opts.baseUrl + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!out.ok) return false;
      const j = await out.json();
      Storage.setAccessToken(j.access_token);
      if (j.refresh_token) Storage.setRefreshToken(j.refresh_token);
      return true;
    } catch { return false; }
  }
}

// =============================================================================
// 5. Mutation queue — enqueue, claim batch, ack, fail
// =============================================================================

export const Queue = {
  /**
   * Enqueue a mutation. Generates a client_id, persists to WMDB.
   * Caller is responsible for also writing the optimistic row to its
   * domain table with sync_state = 'pending'.
   */
  async enqueue(args: {
    table: SyncTable;
    op: 'create' | 'update';
    payload: Record<string, unknown>;
    remoteId?: string;
  }): Promise<string> {
    const allowed = WRITEABLE[args.table];
    if (!allowed?.includes(args.op)) {
      throw new Error(`mobile cannot ${args.op} on ${args.table}`);
    }
    const clientId = crypto.randomUUID();
    await database.write(async () => {
      const col = database.get<MutationRow>('mutation_queue');
      await col.create((m) => {
        m.clientId = clientId;
        m.tableName = args.table;
        m.op = args.op;
        m.remoteId = args.remoteId;
        m.payload = JSON.stringify(args.payload);
        m.attempts = 0;
        m.status = 'pending';
      });
    });
    return clientId;
  },

  async claimBatch(limit = 100): Promise<MutationRow[]> {
    const col = database.get<MutationRow>('mutation_queue');
    const pending = await col
      .query(Q.where('status', 'pending'), Q.sortBy('created_at', Q.asc), Q.take(limit))
      .fetch();
    if (!pending.length) return [];
    await database.write(async () => {
      for (const m of pending) {
        await m.update((r) => { r.status = 'sending'; });
      }
    });
    return pending;
  },

  async ackBatch(results: MutationResult[]): Promise<void> {
    const col = database.get<MutationRow>('mutation_queue');
    await database.write(async () => {
      for (const r of results) {
        const [row] = await col.query(Q.where('client_id', r.client_id)).fetch();
        if (!row) continue;
        if (r.status === 'applied' || r.status === 'duplicate') {
          await row.update((x) => {
            x.status = 'done';
            x.remoteId = r.id;
          });
        } else if (r.status === 'rejected') {
          await row.update((x) => {
            x.status = 'rejected';
            x.lastError = r.reason;
          });
          // Also flag any optimistic domain row.
        } else if (r.status === 'conflict') {
          // Move to conflict table for user resolution.
          await row.update((x) => {
            x.status = 'rejected';
            x.lastError = `conflict: ${r.reason}`;
          });
          const conflicts = database.get('sync_conflicts');
          await conflicts.create((c: any) => {
            c.clientId = r.client_id;
            c.tableName = row.tableName;
            c.reason = r.reason;
            c.clientPayload = row.payload;
            c.serverPayload = JSON.stringify(r.server_payload);
            c.createdAt = Date.now();
          });
        }
      }
    });
  },

  async releaseStuck(): Promise<void> {
    // App killed mid-send → 'sending' rows should go back to 'pending'.
    const col = database.get<MutationRow>('mutation_queue');
    const stuck = await col.query(Q.where('status', 'sending')).fetch();
    if (!stuck.length) return;
    await database.write(async () => {
      for (const m of stuck) {
        await m.update((x) => {
          x.status = 'pending';
          x.attempts = (x.attempts ?? 0) + 1;
        });
      }
    });
  },

  async pendingCount(): Promise<number> {
    const col = database.get<MutationRow>('mutation_queue');
    return col.query(Q.where('status', Q.oneOf(['pending', 'sending']))).fetchCount();
  },
};

// =============================================================================
// 6. Pull / Push / Photo handlers
// =============================================================================

export class SyncHandlers {
  constructor(private api: Api) {}

  /** Drains all available pages of pull and applies them to local DB. */
  async pull(signal?: AbortSignal): Promise<void> {
    while (true) {
      const cursor = Storage.getCursor();
      const res = await this.api.post<{
        rows: SyncRow[]; next_cursor: number; has_more: boolean;
      }>('/sync/pull', {
        device_id: Storage.getDeviceId(),
        cursor,
        limit: 500,
      }, signal);

      if (res.rows.length === 0) break;
      await applyRows(res.rows);
      Storage.setCursor(res.next_cursor);

      if (!res.has_more) break;
    }
  }

  /** Sends one batch of pending mutations. Returns true if more remain. */
  async pushBatch(signal?: AbortSignal): Promise<{ sent: number; high_water: number }> {
    const claimed = await Queue.claimBatch(200);
    if (!claimed.length) return { sent: 0, high_water: 0 };

    const mutations: SyncMutation[] = claimed.map((m) => ({
      client_id: m.clientId,
      table: m.tableName as SyncTable,
      op: m.op,
      id: m.remoteId ?? null,
      payload: JSON.parse(m.payload),
      client_ts: m.createdAt.toISOString(),
    }));

    try {
      const res = await this.api.post<{
        results: MutationResult[]; high_water: number;
      }>('/sync/push', {
        device_id: Storage.getDeviceId(),
        mutations,
      }, signal);
      await Queue.ackBatch(res.results);
      return { sent: res.results.length, high_water: res.high_water };
    } catch (err) {
      // Network / 5xx → put rows back to pending, exponential backoff is the
      // engine's responsibility (not the queue's).
      const col = database.get<MutationRow>('mutation_queue');
      await database.write(async () => {
        for (const m of claimed) {
          await m.update((x) => {
            x.status = 'pending';
            x.attempts = (x.attempts ?? 0) + 1;
            x.lastError = (err as Error).message;
          });
        }
      });
      throw err;
    }
  }

  /** Upload pending photos via presigned URLs. */
  async pushPhotos(signal?: AbortSignal): Promise<number> {
    const col = database.get<PhotoQueueRow>('photo_queue');
    const pending = await col.query(Q.where('status', 'pending'), Q.take(20)).fetch();
    if (!pending.length) return 0;

    const presigned = await this.api.post<{
      uploads: Array<{ filename: string; url: string; key: string }>;
    }>('/sync/photos/presign', {
      filenames: pending.map((p) => `${p.clientId}.jpg`),
    }, signal);

    let done = 0;
    for (let i = 0; i < pending.length; i++) {
      const photo = pending[i];
      const upload = presigned.uploads[i];
      try {
        await database.write(() => photo.update((x) => { x.status = 'uploading'; }));
        // Read local file as Blob — RN-specific
        const blob = await readLocalAsBlob(photo.localUri);
        await this.api.putBinary(upload.url, blob, signal);

        // Confirm to server
        await this.api.post('/sync/photos/confirm', {
          client_id: photo.clientId,
          table: photo.parentTable,
          photos: [{
            key: upload.key,
            taken_at: photo.takenAt.toISOString(),
            geom: photo.lon && photo.lat ? {
              type: 'Point', coordinates: [photo.lon, photo.lat],
            } : null,
          }],
        }, signal);

        await database.write(() => photo.update((x) => {
          x.status = 'done';
          x.remoteKey = upload.key;
        }));
        done++;
      } catch (err) {
        await database.write(() => photo.update((x) => {
          x.status = 'pending'; // retry next time
          x.attempts = (x.attempts ?? 0) + 1;
        }));
        // Continue with the next photo
      }
    }
    return done;
  }
}

/**
 * Apply an incoming batch of pull rows to the local DB.
 * Reference / spatial-reference tables are pull-only — we just upsert.
 * For tables that mobile also writes (crop_activity etc.) we still upsert
 * the canonical server version, but if the local row has sync_state='pending'
 * we leave its local fields alone; the server version arrives later via
 * push ack.
 */
async function applyRows(rows: SyncRow[]): Promise<void> {
  await database.write(async () => {
    for (const r of rows) {
      const handler = ROW_APPLIERS[r.table];
      if (handler) await handler(r);
      // If no handler is registered for a table, we silently skip — the
      // mobile only mirrors a subset of server data.
    }
  });
}

type ApplyFn = (row: SyncRow) => Promise<void>;
const ROW_APPLIERS: Partial<Record<SyncTable, ApplyFn>> = {
  plot: async (r) => {
    const col = database.get<Plot>('plots');
    const existing = await col.query(Q.where('remote_id', r.id)).fetch();
    if (r.deleted) {
      for (const p of existing) await p.markAsDeleted();
      return;
    }
    const p = r.payload as any;
    if (existing[0]) {
      await existing[0].update((x) => {
        x.parcelId = p.parcel_id;
        x.code = p.code;
        x.areaHa = Number(p.area_ha ?? 0);
        x.geomJson = JSON.stringify(p.geom);
        x.serverSeq = r.server_seq;
        x.deleted = false;
      });
    } else {
      await col.create((x) => {
        x.remoteId = r.id;
        x.parcelId = p.parcel_id;
        x.code = p.code;
        x.areaHa = Number(p.area_ha ?? 0);
        x.geomJson = JSON.stringify(p.geom);
        x.serverSeq = r.server_seq;
        x.deleted = false;
      });
    }
  },
  crop_activity: async (r) => {
    const col = database.get<CropActivity>('crop_activities');
    const existing = await col.query(
      Q.or(Q.where('remote_id', r.id), Q.where('client_id', (r.payload as any)?.client_id ?? '')),
    ).fetch();
    const p = r.payload as any;
    if (existing[0]) {
      // Don't overwrite a still-pending local mutation
      if (existing[0].syncState === 'pending') return;
      await existing[0].update((x) => {
        x.remoteId = r.id;
        x.cropPlanId = p.crop_plan_id;
        x.type = p.type;
        x.status = p.status;
        x.inputsJson = JSON.stringify(p.inputs_used ?? []);
        x.photosJson = JSON.stringify(p.photos ?? []);
        x.serverSeq = r.server_seq;
        x.syncState = 'synced';
      });
    } else {
      await col.create((x) => {
        x.remoteId = r.id;
        x.clientId = p.client_id ?? r.id;
        x.cropPlanId = p.crop_plan_id;
        x.type = p.type;
        x.status = p.status;
        x.inputsJson = JSON.stringify(p.inputs_used ?? []);
        x.photosJson = JSON.stringify(p.photos ?? []);
        x.serverSeq = r.server_seq;
        x.syncState = 'synced';
      });
    }
  },
  // Add more as you mirror more tables on mobile…
};

// Platform-specific: read a local file:// URI as Blob.
async function readLocalAsBlob(uri: string): Promise<Blob> {
  const res = await fetch(uri);
  return await res.blob();
}

// =============================================================================
// 7. Engine — state machine + scheduling
// =============================================================================

export type EngineState =
  | 'idle' | 'manifest' | 'pulling' | 'pushing' | 'photos'
  | 'sleeping' | 'offline' | 'error';

export interface EngineSnapshot {
  state: EngineState;
  pending: number;
  cursor: number;
  lastSyncAt: number | null;
  lastError: string | null;
  online: boolean;
}

type Listener = (s: EngineSnapshot) => void;

export class SyncEngine {
  private state: EngineState = 'idle';
  private online = true;
  private lastError: string | null = null;
  private cancelCtrl: AbortController | null = null;
  private listeners = new Set<Listener>();
  private nextRunAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: Api, private handlers: SyncHandlers) {}

  // -------- Lifecycle --------

  async bootstrap(): Promise<void> {
    await Queue.releaseStuck();

    NetInfo.addEventListener((s) => {
      const wasOnline = this.online;
      this.online = !!s.isConnected && (s.isInternetReachable ?? true);
      this.publish();
      if (!wasOnline && this.online) this.requestSync('reconnect');
    });

    // Periodic poll while app is foregrounded.
    setInterval(() => this.requestSync('tick'), 5 * 60_000);

    // Initial sync if needed
    this.requestSync('bootstrap');
  }

  /** Trigger a sync run. Coalesces multiple calls in a window. */
  requestSync(reason: string): void {
    if (this.timer) return;
    const delay = Math.max(0, this.nextRunAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run(reason).catch(() => {/* errors are surfaced via state */});
    }, delay);
  }

  cancel(): void {
    this.cancelCtrl?.abort();
  }

  // -------- The actual run --------

  private async run(_reason: string): Promise<void> {
    if (!this.online) {
      this.transition('offline');
      return;
    }
    this.cancelCtrl = new AbortController();
    const sig = this.cancelCtrl.signal;
    this.lastError = null;

    try {
      this.transition('manifest');
      // (Optional) call /sync/manifest first; skipped here for brevity.

      this.transition('pulling');
      await this.handlers.pull(sig);

      this.transition('pushing');
      // Drain in batches with linear backoff if errors occur.
      let attempts = 0;
      while (true) {
        try {
          const { sent } = await this.handlers.pushBatch(sig);
          if (sent === 0) break;
          attempts = 0;
        } catch (err) {
          attempts++;
          if (attempts > 5) throw err;
          await sleep(1000 * 2 ** attempts);
        }
      }

      this.transition('photos');
      await this.handlers.pushPhotos(sig).catch(() => 0);

      Storage.setLastSyncAt(Date.now());
      this.nextRunAt = Date.now() + 30_000; // soft cooldown
      this.transition('idle');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.transition('idle');
        return;
      }
      this.lastError = err?.message ?? 'unknown';
      // Exponential backoff before next attempted run.
      const back = Math.min(60_000 * 2 ** Math.min(5, this.errorAttempts++), 600_000);
      this.nextRunAt = Date.now() + back;
      this.transition('error');
    } finally {
      this.cancelCtrl = null;
    }
  }
  private errorAttempts = 0;

  // -------- Snapshot / observability --------

  private async publish(): Promise<void> {
    const snap = await this.snapshot();
    for (const l of this.listeners) l(snap);
  }
  private transition(s: EngineState) {
    this.state = s;
    if (s === 'idle') this.errorAttempts = 0;
    this.publish();
  }
  async snapshot(): Promise<EngineSnapshot> {
    return {
      state: this.state,
      pending: await Queue.pendingCount(),
      cursor: Storage.getCursor(),
      lastSyncAt: Storage.getLastSyncAt(),
      lastError: this.lastError,
      online: this.online,
    };
  }
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.snapshot().then(fn);
    return () => this.listeners.delete(fn);
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// =============================================================================
// 8. Singleton + React hook
// =============================================================================

let engineSingleton: SyncEngine | null = null;

export function setupSync(baseUrl: string): SyncEngine {
  if (engineSingleton) return engineSingleton;
  const api = new Api({ baseUrl });
  const handlers = new SyncHandlers(api);
  engineSingleton = new SyncEngine(api, handlers);
  engineSingleton.bootstrap();
  return engineSingleton;
}

export function getEngine(): SyncEngine {
  if (!engineSingleton) throw new Error('call setupSync(baseUrl) at app boot');
  return engineSingleton;
}

/** React hook for the sync status pill in your app shell. */
export function useSyncStatus(): EngineSnapshot {
  const engine = getEngine();
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  useEffect(() => engine.subscribe(setSnap), [engine]);
  return snap ?? {
    state: 'idle', pending: 0, cursor: 0,
    lastSyncAt: null, lastError: null, online: true,
  };
}

/** Convenience: enqueue an activity from a screen. */
export async function recordActivity(args: {
  cropPlanId: string;
  type: 'sowing' | 'fertilizing' | 'spraying' | 'weeding' | 'irrigating' | 'scouting' | 'harvesting' | 'land_prep';
  startedAt: Date;
  completedAt: Date;
  performedById: string;
  inputsUsed?: Array<{ batch_id: string; qty: number; uom: string }>;
  notes?: string;
  geomPoint?: { lat: number; lon: number };
}): Promise<string> {
  const clientId = await Queue.enqueue({
    table: 'crop_activity',
    op: 'create',
    payload: {
      crop_plan_id: args.cropPlanId,
      type: args.type,
      started_at: args.startedAt.toISOString(),
      completed_at: args.completedAt.toISOString(),
      performed_by_id: args.performedById,
      inputs_used: args.inputsUsed ?? [],
      notes: args.notes ?? null,
      status: 'done',
      geom_point: args.geomPoint
        ? { type: 'Point', coordinates: [args.geomPoint.lon, args.geomPoint.lat] }
        : null,
    },
  });

  // Optimistic local insert so the UI updates immediately.
  await database.write(async () => {
    const col = database.get<CropActivity>('crop_activities');
    await col.create((x) => {
      x.clientId = clientId;
      x.cropPlanId = args.cropPlanId;
      x.type = args.type;
      x.status = 'done';
      x.inputsJson = JSON.stringify(args.inputsUsed ?? []);
      x.photosJson = JSON.stringify([]);
      x.serverSeq = 0;
      x.syncState = 'pending';
    });
  });

  // Nudge the engine to flush soon (won't fire if already in-flight).
  getEngine().requestSync('user_action');
  return clientId;
}

// =============================================================================
// 9. Bootstrap recipe (paste into App.tsx)
// =============================================================================
//
//   import { setupSync } from './src/sync';
//
//   export default function App() {
//     useEffect(() => {
//       setupSync('https://api.example.com');
//     }, []);
//     return <RootNavigator />;
//   }
//
//   // Then anywhere:
//   const status = useSyncStatus();
//   <Text>{status.online ? 'Online' : 'Offline'} · pending: {status.pending}</Text>
//
//   // To record work in the field:
//   await recordActivity({ cropPlanId, type: 'spraying', ... });
//
// =============================================================================
