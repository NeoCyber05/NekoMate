import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { Composio } from '@composio/core';

import { sha256Hex } from './auth.ts';
import { withTransaction } from './db.ts';
import { googleCalendarAdapter } from './adapters/google-calendar.ts';
import { googleTasksAdapter } from './adapters/google-tasks.ts';
import { microsoftTodoAdapter } from './adapters/microsoft-todo.ts';
import { outlookCalendarAdapter } from './adapters/outlook-calendar.ts';
import { ticktickAdapter } from './adapters/ticktick.ts';
import { todoistAdapter } from './adapters/todoist.ts';
import type {
  ComposioConnectedAccount,
  ComposioGateway,
  ScopeOption,
  SourceAdapter,
  SourceItem,
} from './adapters/types.ts';

export class SourceHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SourceView {
  id: string;
  name: string;
  toolkit: string;
  kind: 'calendar' | 'task';
  timeMode: 'timed' | 'date_only' | 'mixed';
  requiresScope: boolean;
  sharedAuthGroup: string | null;
  status: string;
  scopeId: string | null;
  scopeLabel: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  liveVerified: boolean;
}

export interface SourcesServiceOptions {
  db: DatabaseSync;
  deviceId: string;
  gateway: ComposioGateway | null;
  composioUserId: string;
  timezone?: string;
  adapters?: SourceAdapter[];
  verifiedSources?: Set<string>;
}

const DEFAULT_ADAPTERS: SourceAdapter[] = [
  googleCalendarAdapter,
  todoistAdapter,
  outlookCalendarAdapter,
  microsoftTodoAdapter,
  ticktickAdapter,
  googleTasksAdapter,
];

const CALENDAR_LOOKBACK_SEC = 15 * 60;
const CALENDAR_LOOKAHEAD_SEC = 7 * 86400;
const NOTIFICATION_TTL_SEC = 5 * 60;
const OAUTH_ATTEMPT_TTL_SEC = 10 * 60;

export function createSdkComposioGateway(apiKey: string): ComposioGateway {
  const composio = new Composio({ apiKey });

  return {
    async createConnectLink({ userId, toolkit, callbackUrl }) {
      const session = await composio.create(userId);
      const req = await session.authorize(toolkit, { callbackUrl });
      if (!req.redirectUrl) {
        throw new Error('Composio không trả về redirectUrl');
      }
      return {
        connectionRequestId: req.id,
        redirectUrl: req.redirectUrl,
      };
    },
    async getConnectedAccount(
      connectedAccountId: string,
      expectedUserId?: string,
    ): Promise<ComposioConnectedAccount | null> {
      try {
        const acct = await composio.connectedAccounts.get(connectedAccountId);
        let ownerMatched = true;
        if (expectedUserId) {
          const list = await composio.connectedAccounts.list({
            userIds: [expectedUserId],
            limit: 100,
          });
          ownerMatched = list.items.some((item) => item.id === connectedAccountId);
        }
        return {
          id: acct.id,
          userId: ownerMatched ? expectedUserId : undefined,
          toolkitSlug: acct.toolkit.slug,
          status: acct.status,
        };
      } catch {
        return null;
      }
    },
    async executeTool({ userId, toolSlug, arguments: args }) {
      const session = await composio.create(userId);
      const res = await session.execute(toolSlug, args);
      if (res.error) {
        throw new Error(res.error);
      }
      return res.data;
    },
  };
}

interface SourceRow {
  source_id: string;
  connected_account_id: string | null;
  scope_id: string | null;
  scope_label: string | null;
  status: string;
  last_sync_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export class SourcesService {
  private readonly db: DatabaseSync;
  private readonly deviceId: string;
  private readonly gateway: ComposioGateway | null;
  private readonly composioUserId: string;
  private readonly timezone: string;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly verifiedSources: Set<string>;
  private readonly sourceLocks = new Map<string, Promise<unknown>>();
  private readonly inFlightSync = new Map<string, Promise<void>>();

  constructor(options: SourcesServiceOptions) {
    this.db = options.db;
    this.deviceId = options.deviceId;
    this.gateway = options.gateway;
    this.composioUserId = options.composioUserId;
    this.timezone = options.timezone ?? 'Asia/Ho_Chi_Minh';
    const list = options.adapters ?? DEFAULT_ADAPTERS;
    for (const adapter of list) {
      this.adapters.set(adapter.id, adapter);
    }
    this.verifiedSources =
      options.verifiedSources ?? new Set(['google_calendar', 'todoist']);
  }

  private getAdapter(sourceId: string): SourceAdapter {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) {
      throw new SourceHttpError(404, `Không tìm thấy nguồn ${sourceId}`);
    }
    return adapter;
  }

  private getSourceRow(sourceId: string): SourceRow | undefined {
    return this.db
      .prepare('SELECT * FROM sources WHERE source_id = ?')
      .get(sourceId) as SourceRow | undefined;
  }

  private runWithSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sourceLocks.get(sourceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.sourceLocks.set(sourceId, tail);
    void tail.finally(() => {
      if (this.sourceLocks.get(sourceId) === tail) {
        this.sourceLocks.delete(sourceId);
      }
    });
    return next;
  }

  setConnectedAccountForTest(
    sourceId: string,
    connectedAccountId: string,
    scopeId: string | null = null,
    scopeLabel: string | null = null,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): void {
    this.getAdapter(sourceId);
    this.db
      .prepare(
        `INSERT INTO sources (source_id, connected_account_id, scope_id, scope_label, status, updated_at)
         VALUES (?, ?, ?, ?, 'connected', ?)
         ON CONFLICT(source_id) DO UPDATE SET
           connected_account_id = excluded.connected_account_id,
           scope_id = excluded.scope_id,
           scope_label = excluded.scope_label,
           status = 'connected',
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(sourceId, connectedAccountId, scopeId, scopeLabel, nowSec);
  }

  listSources(): SourceView[] {
    const rows = this.db.prepare('SELECT * FROM sources').all() as unknown as SourceRow[];
    const byId = new Map<string, SourceRow>();
    for (const r of rows) {
      byId.set(r.source_id, r);
    }

    const result: SourceView[] = [];
    for (const adapter of this.adapters.values()) {
      const row = byId.get(adapter.id);
      result.push({
        id: adapter.id,
        name: adapter.name,
        toolkit: adapter.toolkit,
        kind: adapter.kind,
        timeMode: adapter.timeMode,
        requiresScope: adapter.requiresScope,
        sharedAuthGroup: adapter.sharedAuthGroup ?? null,
        status: row?.status ?? 'disconnected',
        scopeId: row?.scope_id ?? null,
        scopeLabel: row?.scope_label ?? null,
        lastSyncAt: row?.last_sync_at ?? null,
        lastError: row?.last_error ?? null,
        liveVerified: this.verifiedSources.has(adapter.id),
      });
    }
    return result;
  }

  async startConnect(
    sourceId: string,
    sessionTokenHash: string,
    appBaseUrl: string,
    nowSec: number,
  ): Promise<{ redirectUrl: string }> {
    const adapter = this.getAdapter(sourceId);
    if (!this.gateway) {
      throw new SourceHttpError(503, 'Chưa cấu hình COMPOSIO_API_KEY');
    }

    const nonce = crypto.randomBytes(24).toString('base64url');
    const nonceHash = sha256Hex(nonce);
    const cb = new URL('/api/sources/oauth/callback', appBaseUrl);
    cb.searchParams.set('nonce', nonce);

    const link = await this.gateway.createConnectLink({
      userId: this.composioUserId,
      toolkit: adapter.toolkit,
      callbackUrl: cb.toString(),
    });

    this.db
      .prepare(
        `INSERT INTO oauth_attempts (
          nonce_hash, session_token_hash, source_id, toolkit, connection_request_id, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        nonceHash,
        sessionTokenHash,
        adapter.id,
        adapter.toolkit,
        link.connectionRequestId,
        nowSec,
        nowSec + OAUTH_ATTEMPT_TTL_SEC,
      );

    return { redirectUrl: link.redirectUrl };
  }

  async completeOAuthCallback(params: {
    nonce: string;
    connectedAccountId: string;
    sessionTokenHash: string;
    nowSec: number;
  }): Promise<{ sourceId: string; status: string }> {
    if (!this.gateway) {
      throw new SourceHttpError(503, 'Chưa cấu hình COMPOSIO_API_KEY');
    }
    if (!params.nonce || !params.connectedAccountId) {
      throw new SourceHttpError(400, 'Thiếu thông tin callback OAuth');
    }

    const nonceHash = sha256Hex(params.nonce);
    const attempt = this.db
      .prepare('SELECT * FROM oauth_attempts WHERE nonce_hash = ?')
      .get(nonceHash) as
      | {
          nonce_hash: string;
          session_token_hash: string;
          source_id: string;
          toolkit: string;
          connection_request_id: string;
          expires_at: number;
          consumed_at: number | null;
        }
      | undefined;

    if (!attempt) {
      throw new SourceHttpError(400, 'Yêu cầu liên kết không tồn tại');
    }
    if (attempt.consumed_at !== null) {
      throw new SourceHttpError(400, 'Liên kết OAuth đã được sử dụng');
    }
    if (attempt.expires_at <= params.nowSec) {
      throw new SourceHttpError(400, 'Liên kết OAuth đã hết hạn');
    }
    if (attempt.session_token_hash !== params.sessionTokenHash) {
      throw new SourceHttpError(403, 'Phiên đăng nhập không khớp với yêu cầu liên kết');
    }

    const account = await this.gateway.getConnectedAccount(
      params.connectedAccountId,
      this.composioUserId,
    );
    if (
      !account ||
      account.status !== 'ACTIVE' ||
      account.toolkitSlug !== attempt.toolkit ||
      account.userId !== this.composioUserId
    ) {
      throw new SourceHttpError(403, 'Tài khoản liên kết không hợp lệ hoặc không thuộc chủ thiết bị');
    }

    const adapter = this.getAdapter(attempt.source_id);

    // Nếu chia sẻ kết nối (ví dụ Outlook Calendar + Microsoft To Do), kiểm tra quyền đọc cho các nguồn đang bật trước khi thay kết nối
    const targetsToUpdate: SourceAdapter[] = [adapter];
    if (adapter.sharedAuthGroup) {
      for (const peer of this.adapters.values()) {
        if (peer.id === adapter.id || peer.sharedAuthGroup !== adapter.sharedAuthGroup) {
          continue;
        }
        const peerRow = this.getSourceRow(peer.id);
        if (peerRow?.connected_account_id) {
          targetsToUpdate.push(peer);
        }
      }
    }

    for (const target of targetsToUpdate) {
      if (target.verifyConnection) {
        try {
          await target.verifyConnection(
            account.id,
            this.gateway,
            this.composioUserId,
            params.nowSec,
          );
        } catch (err) {
          throw new SourceHttpError(
            403,
            `Kết nối mới thiếu quyền đọc cho ${target.name}: ${err instanceof Error ? err.message : 'không xác minh được'}`,
          );
        }
      }
    }

    await this.runWithSourceLock(adapter.id, async () => {
      withTransaction(this.db, () => {
        const upd = this.db
          .prepare(
            'UPDATE oauth_attempts SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL',
          )
          .run(params.nowSec, nonceHash);
        if (upd.changes === 0) {
          throw new SourceHttpError(400, 'Liên kết OAuth đã được sử dụng');
        }

        const upsertSource = this.db.prepare(
          `INSERT INTO sources (source_id, connected_account_id, status, last_error, updated_at)
           VALUES (?, ?, 'connected', NULL, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             connected_account_id = excluded.connected_account_id,
             status = 'connected',
             last_error = NULL,
             updated_at = excluded.updated_at`,
        );

        for (const target of targetsToUpdate) {
          upsertSource.run(target.id, account.id, params.nowSec);
        }
      });
    });

    return { sourceId: adapter.id, status: 'connected' };
  }

  async listOptions(sourceId: string): Promise<ScopeOption[]> {
    const adapter = this.getAdapter(sourceId);
    if (!adapter.listOptions) {
      return [];
    }
    if (!this.gateway) {
      throw new SourceHttpError(503, 'Chưa cấu hình COMPOSIO_API_KEY');
    }
    const row = this.getSourceRow(sourceId);
    if (!row?.connected_account_id) {
      throw new SourceHttpError(400, 'Nguồn chưa được liên kết tài khoản');
    }
    return adapter.listOptions(
      {
        sourceId,
        connectedAccountId: row.connected_account_id,
        scopeId: row.scope_id,
      },
      this.gateway,
      this.composioUserId,
    );
  }

  async updateScope(
    sourceId: string,
    scopeId: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    const adapter = this.getAdapter(sourceId);
    if (!adapter.requiresScope) {
      throw new SourceHttpError(400, `Nguồn ${sourceId} không hỗ trợ chọn phạm vi`);
    }
    if (!scopeId) {
      throw new SourceHttpError(400, 'Thiếu scopeId');
    }

    const options = await this.listOptions(sourceId);
    const chosen = options.find((opt) => opt.id === scopeId);
    if (!chosen) {
      throw new SourceHttpError(400, 'Danh sách hoặc project không thuộc tài khoản đã liên kết');
    }

    await this.runWithSourceLock(sourceId, async () => {
      this.db
        .prepare(
          `UPDATE sources SET scope_id = ?, scope_label = ?, updated_at = ? WHERE source_id = ?`,
        )
        .run(chosen.id, chosen.label, nowSec, sourceId);
      await this.executeSyncUnlocked(adapter, nowSec);
    });
  }

  private async executeSyncUnlocked(adapter: SourceAdapter, nowSec: number): Promise<void> {
    const sourceId = adapter.id;
    const row = this.getSourceRow(sourceId);
    if (!row?.connected_account_id) {
      throw new SourceHttpError(400, `Nguồn ${sourceId} chưa được liên kết`);
    }
    if (!this.gateway) {
      throw new SourceHttpError(503, 'Chưa cấu hình COMPOSIO_API_KEY');
    }
    if (adapter.requiresScope && !row.scope_id) {
      throw new SourceHttpError(400, `Nguồn ${sourceId} cần chọn danh sách trước khi đồng bộ`);
    }

    const window = {
      from: nowSec - CALENDAR_LOOKBACK_SEC,
      to: nowSec + CALENDAR_LOOKAHEAD_SEC,
    };

    let items: SourceItem[];
    try {
      items = await adapter.readSource(
        {
          sourceId,
          connectedAccountId: row.connected_account_id,
          scopeId: row.scope_id,
        },
        window,
        this.gateway,
        this.composioUserId,
        this.timezone,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi đồng bộ nguồn';
      this.db
        .prepare(
          `UPDATE sources SET status = 'error', last_error = ?, updated_at = ? WHERE source_id = ?`,
        )
        .run(msg, nowSec, sourceId);
      throw err;
    }

    withTransaction(this.db, () => {
      this.db.prepare('DELETE FROM source_items WHERE source_id = ?').run(sourceId);
      const insertItem = this.db.prepare(
        `INSERT INTO source_items (source_id, external_id, title, date_only, notify_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      const expectedQueue = new Map<
        string,
        { externalId: string; title: string; notifyAt: number; expiresAt: number }
      >();

      for (const item of items) {
        insertItem.run(
          sourceId,
          item.externalId,
          item.title,
          item.dateOnly,
          item.notifyAt,
          nowSec,
        );

        if (item.notifyAt !== null) {
          const expiresAt = item.notifyAt + NOTIFICATION_TTL_SEC;
          if (expiresAt > nowSec) {
            const notificationId = `${this.deviceId}:${sourceId}:${item.externalId}:${item.notifyAt}`;
            expectedQueue.set(notificationId, {
              externalId: item.externalId,
              title: item.title,
              notifyAt: item.notifyAt,
              expiresAt,
            });
          }
        }
      }

      const pendingRows = this.db
        .prepare(
          `SELECT notification_id, title
           FROM notification_queue
           WHERE source_id = ? AND status = 'pending'`,
        )
        .all(sourceId) as Array<{ notification_id: string; title: string }>;

      const cancelStmt = this.db.prepare(
        `UPDATE notification_queue SET status = 'cancelled' WHERE notification_id = ? AND status = 'pending'`,
      );
      const updateTitleStmt = this.db.prepare(
        `UPDATE notification_queue SET title = ? WHERE notification_id = ? AND status = 'pending'`,
      );

      for (const q of pendingRows) {
        const expected = expectedQueue.get(q.notification_id);
        if (!expected) {
          cancelStmt.run(q.notification_id);
        } else if (expected.title !== q.title) {
          updateTitleStmt.run(expected.title, q.notification_id);
        }
      }

      const insertQueueStmt = this.db.prepare(
        `INSERT OR IGNORE INTO notification_queue (
          notification_id, source, source_id, external_id, title, notify_at, expires_at, status, attempts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      );

      for (const [notificationId, entry] of expectedQueue.entries()) {
        insertQueueStmt.run(
          notificationId,
          adapter.name,
          sourceId,
          entry.externalId,
          entry.title,
          entry.notifyAt,
          entry.expiresAt,
          nowSec,
        );
      }

      this.db
        .prepare(
          `UPDATE sources
           SET status = 'connected', last_sync_at = ?, last_error = NULL, updated_at = ?
           WHERE source_id = ?`,
        )
        .run(nowSec, nowSec, sourceId);
    });
  }

  async syncSource(
    sourceId: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    const adapter = this.getAdapter(sourceId);
    const currentRow = this.getSourceRow(sourceId);
    const key = `${sourceId}::${currentRow?.scope_id ?? ''}`;
    const existingFlight = this.inFlightSync.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    const job = this.runWithSourceLock(sourceId, () =>
      this.executeSyncUnlocked(adapter, nowSec),
    ).finally(() => {
      if (this.inFlightSync.get(key) === job) {
        this.inFlightSync.delete(key);
      }
    });

    this.inFlightSync.set(key, job);
    return job;
  }

  async syncAllConnected(nowSec: number = Math.floor(Date.now() / 1000)): Promise<void> {
    const rows = this.db
      .prepare("SELECT source_id FROM sources WHERE connected_account_id IS NOT NULL AND status != 'disconnected'")
      .all() as Array<{ source_id: string }>;

    for (const row of rows) {
      const adapter = this.adapters.get(row.source_id);
      if (!adapter) {
        continue;
      }
      const sourceRow = this.getSourceRow(row.source_id);
      if (adapter.requiresScope && !sourceRow?.scope_id) {
        continue;
      }
      try {
        await this.syncSource(row.source_id, nowSec);
      } catch (err) {
        console.error(`Lỗi đồng bộ định kỳ ${row.source_id}:`, err);
      }
    }
  }
}
