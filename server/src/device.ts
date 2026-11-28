import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from './db.ts';
import { formatLocalDateTime } from './adapters/time.ts';

export const MAX_ALARMS = 12;

interface AlarmEntry extends AlarmInput {
  id: string;
  title: string;
  date: string | null;
  sourceId: string | null;
  itemId: string | null;
  sourceDue: string | null;
  sourceNotifyAt: number | null;
  replacesReminder: boolean;
}

function overlaps(a: AlarmEntry, b: AlarmEntry): boolean {
  if (!a.enabled || !b.enabled || a.hour !== b.hour || a.minute !== b.minute) return false;
  if (a.date && b.date) return a.date === b.date;
  const date = a.date ?? b.date;
  if (date) return (a.date ? b.days : a.days).includes(new Date(date).getUTCDay() || 7);
  return a.days.some(day => b.days.includes(day));
}

export interface AlarmConfig {
  configId: string;
  revision: number;
  hour: number;
  minute: number;
  days: number[];
  enabled: boolean;
  entries?: AlarmEntry[];
}

export interface AlarmInput {
  hour: number;
  minute: number;
  days: number[];
  enabled: boolean;
}

export interface NotificationInput {
  notificationId: string;
  source: string;
  title: string;
  notifyAt: number;
  expiresAt: number;
  sourceId?: string | null;
  externalId?: string | null;
}

export interface DeviceStatusView {
  deviceId: string;
  online: boolean;
  lastSeenAt: number | null;
  syncState: 'unconfigured' | 'pending' | 'synced';
  pendingAlarm: AlarmConfig | null;
  confirmedAlarm: Partial<AlarmConfig> | null;
  alarms: AlarmEntry[];
}

export interface MqttTransport {
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
  ): Promise<void> | void;
}

export interface DeviceServiceOptions {
  db: DatabaseSync;
  deviceId: string;
  mqtt: MqttTransport;
}

const RETRY_INTERVAL_SEC = 15;

export function toDeviceTitle(raw: string): string {
  const stripped = raw
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const asciiOnly = stripped.replace(/[^\x20-\x7E]/g, ' ');
  const collapsed = asciiOnly.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return 'Loi nhac';
  }
  if (collapsed.length <= 48) {
    return collapsed;
  }
  return `${collapsed.slice(0, 45).trimEnd()}...`;
}

export function validateAlarmInput(input: AlarmInput): number[] {
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    throw new Error('Giờ báo thức phải từ 0 đến 23');
  }
  if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw new Error('Phút báo thức phải từ 0 đến 59');
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Trạng thái bật/tắt không hợp lệ');
  }
  if (!Array.isArray(input.days)) {
    throw new Error('Danh sách ngày lặp không hợp lệ');
  }

  const uniqueDays = Array.from(new Set(input.days)).sort((a, b) => a - b);
  for (const d of uniqueDays) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new Error('Ngày lặp phải nằm trong khoảng 1..7');
    }
  }
  if (input.enabled && uniqueDays.length === 0) {
    throw new Error('Khi bật báo thức phải chọn ít nhất một ngày lặp');
  }
  return uniqueDays;
}

interface AlarmRow {
  pending_config_id: string;
  pending_revision: number;
  pending_hour: number;
  pending_minute: number;
  pending_days_json: string;
  pending_enabled: number;
  confirmed_config_id: string | null;
  confirmed_revision: number | null;
  confirmed_hour: number | null;
  confirmed_minute: number | null;
  confirmed_days_json: string | null;
  confirmed_enabled: number | null;
  updated_at: number;
  pending_entries: string | null;
  confirmed_entries: string | null;
}

export class DeviceService {
  private readonly db: DatabaseSync;
  private readonly deviceId: string;
  private readonly mqtt: MqttTransport;
  private lastAlarmPublishAt: number | null = null;

  constructor(options: DeviceServiceOptions) {
    this.db = options.db;
    this.deviceId = options.deviceId;
    this.mqtt = options.mqtt;
  }

  topic(suffix: 'notify' | 'alarms/config' | 'events' | 'status'): string {
    return `nekomate/devices/${this.deviceId}/${suffix}`;
  }

  private getAlarmRow(): AlarmRow | undefined {
    return this.db
      .prepare('SELECT * FROM alarm_config WHERE id = 1')
      .get() as AlarmRow | undefined;
  }

  private rowToPending(row: AlarmRow): AlarmConfig {
    return {
      configId: row.pending_config_id,
      revision: row.pending_revision,
      hour: row.pending_hour,
      minute: row.pending_minute,
      days: JSON.parse(row.pending_days_json) as number[],
      enabled: row.pending_enabled === 1,
      ...(row.pending_entries === null ? {} : { entries: JSON.parse(row.pending_entries) as AlarmEntry[] }),
    };
  }

  private isAlarmSynced(row: AlarmRow): boolean {
    return (
      row.confirmed_config_id !== null &&
      row.confirmed_revision !== null &&
      row.confirmed_config_id === row.pending_config_id &&
      row.confirmed_revision === row.pending_revision
    );
  }

  async saveAlarm(
    input: AlarmInput,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<AlarmConfig> {
    const days = validateAlarmInput(input);
    const configId = crypto.randomUUID();
    const daysJson = JSON.stringify(days);

    const saved = withTransaction(this.db, () => {
      const existing = this.getAlarmRow();
      if (existing?.pending_entries != null) throw new Error('Dùng danh sách báo thức để cập nhật cấu hình.');
      const baseRevision = existing
        ? Math.max(existing.pending_revision, existing.confirmed_revision ?? 0)
        : 0;
      const revision = baseRevision + 1;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO alarm_config (
              id, pending_config_id, pending_revision, pending_hour, pending_minute, pending_days_json, pending_enabled, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(configId, revision, input.hour, input.minute, daysJson, input.enabled ? 1 : 0, nowSec);
      } else {
        this.db
          .prepare(
            `UPDATE alarm_config SET
              pending_config_id = ?,
              pending_revision = ?,
              pending_hour = ?,
              pending_minute = ?,
              pending_days_json = ?,
              pending_enabled = ?,
              updated_at = ?
            WHERE id = 1`,
          )
          .run(configId, revision, input.hour, input.minute, daysJson, input.enabled ? 1 : 0, nowSec);
      }

      return {
        configId,
        revision,
        hour: input.hour,
        minute: input.minute,
        days,
        enabled: input.enabled,
      };
    });

    await this.mqtt.publish(this.topic('alarms/config'), JSON.stringify(saved), {
      qos: 1,
      retain: true,
    });
    this.lastAlarmPublishAt = nowSec;
    return saved;
  }

  private listAlarms(row = this.getAlarmRow()): AlarmEntry[] {
    if (!row) return [];
    const { entries, hour, minute, days, enabled } = this.rowToPending(row);
    return entries ?? [{
      id: 'legacy', title: 'Báo thức', hour, minute, days, enabled, date: null,
      sourceId: null, itemId: null, sourceDue: null, sourceNotifyAt: null, replacesReminder: false,
    }];
  }

  private async publishAlarms(config: AlarmConfig, nowSec: number): Promise<void> {
    const { entries, configId, revision } = config;
    const payload = entries ? {
      configId, revision,
      alarms: entries.filter(entry => entry.enabled).map(entry => ({
        hour: entry.hour, minute: entry.minute, days: entry.days,
        date: entry.date ? Number(entry.date.replaceAll('-', '')) : 0,
        title: toDeviceTitle(entry.title),
      })),
    } : config;
    this.lastAlarmPublishAt = nowSec;
    await this.mqtt.publish(this.topic('alarms/config'), JSON.stringify(payload), { qos: 1, retain: true });
  }

  async changeAlarm(
    id: string | null,
    input: Record<string, unknown> | null,
    nowSec: number,
  ): Promise<void> {
    const saved = withTransaction(this.db, () => {
      const row = this.getAlarmRow();
      const entries = this.listAlarms(row);
      const index = id === null ? -1 : entries.findIndex(entry => entry.id === id);
      if (id !== null && index < 0) throw new Error('Không tìm thấy báo thức.');
      if (input === null) {
        entries.splice(index, 1);
      } else {
        if (id === null && entries.length >= MAX_ALARMS) throw new Error('Đồng hồ lưu tối đa 12 báo thức.');
        const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
        if (!title || title.length > 80) throw new Error('Tên báo thức phải có từ 1 đến 80 ký tự.');
        const date = input['date'] ?? null;
        if (date !== null && (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)
          || new Date(Date.parse(date) || 0).toISOString().slice(0, 10) !== date)) {
          throw new Error('Ngày báo thức không hợp lệ.');
        }
        const { hour, minute, enabled } = input as unknown as AlarmInput;
        const days = validateAlarmInput({ hour, minute, enabled: date ? false : enabled, days: date ? [] : input['days'] as number[] });
        if (typeof enabled !== 'boolean') throw new Error('Trạng thái bật/tắt không hợp lệ.');
        if (enabled && date && `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
          <= formatLocalDateTime(nowSec, 'Asia/Ho_Chi_Minh')) {
          throw new Error('Chọn ngày và giờ trong tương lai.');
        }
        const old = entries[index];
        const sourceId = old?.sourceId ?? (typeof input['sourceId'] === 'string' ? input['sourceId'] : null);
        const itemId = old?.itemId ?? (typeof input['itemId'] === 'string' ? input['itemId'] : null);
        const sourceItem = sourceId && itemId ? this.db.prepare(
          'SELECT date_only, notify_at FROM source_items WHERE source_id = ? AND external_id = ?',
        ).get(sourceId, itemId) as { date_only: string | null; notify_at: number | null } | undefined : undefined;
        if ((sourceId || itemId) && !sourceItem && !old) throw new Error('Công việc không còn trong nguồn đã đồng bộ.');
        const updateSource = !old || input['updateSource'] === true;
        const sourceNotifyAt = updateSource ? sourceItem?.notify_at ?? null : old.sourceNotifyAt;
        const sourceDue = updateSource
          ? sourceItem?.date_only ?? (sourceNotifyAt === null ? null : String(sourceNotifyAt))
          : old.sourceDue;
        const saved: AlarmEntry = {
          id: id ?? crypto.randomUUID(), title, date, hour, minute, enabled, days, sourceId, itemId,
          sourceDue, sourceNotifyAt,
          replacesReminder: Boolean(date && sourceNotifyAt !== null && input['replacesReminder'] === true),
        };
        const conflict = entries.find((entry, position) => position !== index && overlaps(saved, entry));
        if (conflict) throw new Error(`Giờ reo trùng với “${conflict.title}”. Hãy chọn một giờ khác.`);
        if (index < 0) entries.push(saved);
        else entries[index] = saved;
      }
      const configId = crypto.randomUUID();
      const revision = Math.max(row?.pending_revision ?? 0, row?.confirmed_revision ?? 0) + 1;
      this.db.prepare(
        `INSERT INTO alarm_config (id, pending_config_id, pending_revision, pending_hour, pending_minute,
          pending_days_json, pending_enabled, pending_entries, updated_at) VALUES (1, ?, ?, 0, 0, '[]', 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET pending_config_id = excluded.pending_config_id,
            pending_revision = excluded.pending_revision, pending_entries = excluded.pending_entries, updated_at = excluded.updated_at`,
      ).run(configId, revision, JSON.stringify(entries), nowSec);
      return this.rowToPending(this.getAlarmRow()!);
    });
    // The saved revision remains queued if the broker is temporarily unavailable.
    await this.publishAlarms(saved, nowSec).catch(() => {});
  }

  queueNotification(
    input: NotificationInput,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): void {
    this.db
      .prepare(
        `INSERT INTO notification_queue (
          notification_id, source, source_id, external_id, title, notify_at, expires_at, status, attempts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
        ON CONFLICT(notification_id) DO UPDATE SET
          title = CASE WHEN notification_queue.status = 'pending' THEN excluded.title ELSE notification_queue.title END`,
      )
      .run(
        input.notificationId,
        input.source,
        input.sourceId ?? null,
        input.externalId ?? null,
        input.title,
        input.notifyAt,
        input.expiresAt,
        nowSec,
      );
  }

  async tickDevice(nowSec: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE notification_queue
         SET status = 'missed'
         WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(nowSec);

    const alarmRow = this.getAlarmRow();
    if (
      alarmRow &&
      !this.isAlarmSynced(alarmRow) &&
      (this.lastAlarmPublishAt === null || nowSec - this.lastAlarmPublishAt >= RETRY_INTERVAL_SEC)
    ) {
      const pending = this.rowToPending(alarmRow);
      await this.publishAlarms(pending, nowSec);
    }

    const dueRows = this.db
      .prepare(
        `SELECT notification_id, source, title, notify_at, expires_at
         FROM notification_queue
         WHERE status = 'pending'
           AND notify_at <= ?
           AND expires_at > ?
           AND (last_sent_at IS NULL OR (? - last_sent_at) >= ?)
           AND NOT EXISTS (
             SELECT 1 FROM active_alarm_replacements AS alarm
             WHERE alarm.source_id = notification_queue.source_id
               AND alarm.external_id = notification_queue.external_id
               AND alarm.notify_at = notification_queue.notify_at
           )
         ORDER BY notify_at ASC`,
      )
      .all(nowSec, nowSec, nowSec, RETRY_INTERVAL_SEC) as Array<{
      notification_id: string;
      source: string;
      title: string;
      notify_at: number;
      expires_at: number;
    }>;

    const markSent = this.db.prepare(
      'UPDATE notification_queue SET last_sent_at = ?, attempts = attempts + 1 WHERE notification_id = ?',
    );

    for (const row of dueRows) {
      markSent.run(nowSec, row.notification_id);
      const payload = {
        notificationId: row.notification_id,
        source: toDeviceTitle(row.source),
        title: toDeviceTitle(row.title),
        notifyAt: row.notify_at,
        expiresAt: row.expires_at,
      };
      await this.mqtt.publish(this.topic('notify'), JSON.stringify(payload), {
        qos: 1,
        retain: false,
      });
    }
  }

  async handleMqttReconnect(nowSec: number): Promise<void> {
    const alarmRow = this.getAlarmRow();
    if (alarmRow && !this.isAlarmSynced(alarmRow)) {
      const pending = this.rowToPending(alarmRow);
      await this.publishAlarms(pending, nowSec);
    }
  }

  async handleMqttMessage(
    topic: string,
    payloadStr: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payloadStr);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (topic === this.topic('status')) {
      if (typeof data['online'] === 'boolean') {
        this.db
          .prepare(
            `INSERT INTO device_state (device_id, online, last_seen_at)
             VALUES (?, ?, ?)
             ON CONFLICT(device_id) DO UPDATE SET
               online = excluded.online,
               last_seen_at = excluded.last_seen_at`,
          )
          .run(this.deviceId, data['online'] ? 1 : 0, nowSec);
      }
      return;
    }

    if (topic !== this.topic('events')) {
      return;
    }

    const type = data['type'];
    if (type === 'shown') {
      const notificationId = data['notificationId'];
      const at = data['at'];
      if (typeof notificationId !== 'string' || !Number.isInteger(at)) {
        return;
      }
      this.db
        .prepare(
          `UPDATE notification_queue
           SET shown_at = COALESCE(shown_at, ?),
               status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE 'shown' END
           WHERE notification_id = ?`,
        )
        .run(at as number, notificationId);
      return;
    }

    if (type === 'dismissed') {
      const notificationId = data['notificationId'];
      const at = data['at'];
      if (typeof notificationId !== 'string' || !Number.isInteger(at)) {
        return;
      }
      this.db
        .prepare(
          `UPDATE notification_queue
           SET shown_at = COALESCE(shown_at, ?),
               dismissed_at = COALESCE(dismissed_at, ?),
               status = 'dismissed'
           WHERE notification_id = ?`,
        )
        .run(at as number, at as number, notificationId);
      return;
    }

    if (type === 'alarm_config_applied') {
      const configId = data['configId'];
      const revision = data['revision'];
      if (typeof configId !== 'string' || !Number.isInteger(revision)) {
        return;
      }
      withTransaction(this.db, () => {
        const row = this.getAlarmRow();
        if (!row) {
          return;
        }
        if (row.pending_config_id !== configId || row.pending_revision !== revision) {
          return;
        }
        this.db
          .prepare(
            `UPDATE alarm_config SET
              confirmed_config_id = pending_config_id,
              confirmed_revision = pending_revision,
              confirmed_hour = pending_hour,
              confirmed_minute = pending_minute,
              confirmed_days_json = pending_days_json,
              confirmed_enabled = pending_enabled,
              confirmed_entries = pending_entries
            WHERE id = 1`,
          )
          .run();
      });
      return;
    }

    if (type === 'alarm_config_stale') {
      const configId = data['configId'];
      const revision = data['revision'];
      const appliedRevision = data['appliedRevision'];
      if (
        typeof configId !== 'string' ||
        !Number.isInteger(revision) ||
        !Number.isInteger(appliedRevision) ||
        (appliedRevision as number) < 0
      ) {
        return;
      }

      const republished = withTransaction(this.db, (): AlarmConfig | null => {
        const row = this.getAlarmRow();
        if (!row) {
          return null;
        }
        if (row.pending_config_id !== configId || row.pending_revision !== revision) {
          return null;
        }
        const nextRevision = Math.max(row.pending_revision, appliedRevision as number) + 1;
        this.db
          .prepare(
            `UPDATE alarm_config SET
              pending_revision = ?,
              confirmed_revision = ?,
              updated_at = ?
            WHERE id = 1`,
          )
          .run(nextRevision, appliedRevision as number, nowSec);

        return { ...this.rowToPending(row), revision: nextRevision };
      });

      if (republished) {
        await this.publishAlarms(republished, nowSec);
      }
    }
  }

  getDeviceStatus(): DeviceStatusView {
    const state = this.db
      .prepare('SELECT online, last_seen_at FROM device_state WHERE device_id = ?')
      .get(this.deviceId) as { online: number; last_seen_at: number | null } | undefined;

    const alarmRow = this.getAlarmRow();
    if (!alarmRow) {
      return {
        deviceId: this.deviceId,
        online: state?.online === 1,
        lastSeenAt: state?.last_seen_at ?? null,
        syncState: 'unconfigured',
        pendingAlarm: null,
        confirmedAlarm: null,
        alarms: [],
      };
    }

    const pendingAlarm = this.rowToPending(alarmRow);
    const synced = this.isAlarmSynced(alarmRow);
    const confirmedAlarm: Partial<AlarmConfig> | null =
      alarmRow.confirmed_revision !== null
        ? {
            configId: alarmRow.confirmed_config_id ?? undefined,
            revision: alarmRow.confirmed_revision,
            hour: alarmRow.confirmed_hour ?? undefined,
            minute: alarmRow.confirmed_minute ?? undefined,
            days: alarmRow.confirmed_days_json
              ? (JSON.parse(alarmRow.confirmed_days_json) as number[])
              : undefined,
            enabled:
              alarmRow.confirmed_enabled !== null
                ? alarmRow.confirmed_enabled === 1
                : undefined,
          }
        : null;

    return {
      deviceId: this.deviceId,
      online: state?.online === 1,
      lastSeenAt: state?.last_seen_at ?? null,
      syncState: synced ? 'synced' : 'pending',
      pendingAlarm,
      confirmedAlarm,
      alarms: this.listAlarms(alarmRow),
    };
  }
}
