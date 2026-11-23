import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import mqttLib from 'mqtt';

import {
  LoginRateLimiter,
  SESSION_TTL_SEC,
  createSession,
  extractSessionToken,
  isAllowedOrigin,
  revokeSession,
  serializeSessionCookie,
  validateSession,
  verifyPassword,
} from './auth.ts';
import { formatLocalDateTime } from './adapters/time.ts';
import { openDatabase } from './db.ts';
import { DeviceService, type MqttTransport } from './device.ts';
import {
  SourceHttpError,
  SourcesService,
  createSdkComposioGateway,
} from './sources.ts';

export interface AppDependencies {
  db: DatabaseSync;
  deviceService: DeviceService;
  sourcesService?: SourcesService;
  appBaseUrl: string;
  ownerPasswordHash: string;
  deviceId?: string;
  timezone?: string;
  nowSec?: () => number;
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  const limiter = new LoginRateLimiter();
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const deviceId = deps.deviceId ?? 'nekomate-01';
  const timezone = deps.timezone ?? 'Asia/Ho_Chi_Minh';

  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.resolve(import.meta.dirname, '../public')));

  const checkOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (!isAllowedOrigin(req.get('origin'), deps.appBaseUrl)) {
      res.status(403).json({ error: 'Origin không hợp lệ' });
      return;
    }
    next();
  };

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractSessionToken(req.get('cookie'));
    if (!token) {
      res.status(401).json({ error: 'Chưa đăng nhập' });
      return;
    }
    const session = validateSession(deps.db, token, nowSec());
    if (!session) {
      res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ' });
      return;
    }
    res.locals['sessionToken'] = token;
    res.locals['sessionTokenHash'] = session.tokenHash;
    next();
  };

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const token = extractSessionToken(req.get('cookie'));
    const session = token ? validateSession(deps.db, token, nowSec()) : null;
    res.json({ authenticated: session !== null });
  });

  app.post('/api/auth/login', checkOrigin, (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const currentSec = nowSec();
    if (limiter.isBlocked(ip, currentSec)) {
      res.status(429).json({ error: 'Đăng nhập sai quá nhiều lần, vui lòng thử lại sau' });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyPassword(password, deps.ownerPasswordHash)) {
      limiter.recordFailure(ip, currentSec);
      res.status(401).json({ error: 'Sai mật khẩu' });
      return;
    }

    limiter.reset(ip);
    const { token } = createSession(deps.db, currentSec);
    res.setHeader(
      'Set-Cookie',
      serializeSessionCookie(token, deps.appBaseUrl, SESSION_TTL_SEC),
    );
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', checkOrigin, requireAuth, (_req: Request, res: Response) => {
    const token = res.locals['sessionToken'] as string | undefined;
    if (token) {
      revokeSession(deps.db, token);
    }
    res.setHeader('Set-Cookie', serializeSessionCookie('', deps.appBaseUrl, 0));
    res.json({ authenticated: false });
  });

  app.get('/api/device', requireAuth, (_req: Request, res: Response) => {
    res.json(deps.deviceService.getDeviceStatus());
  });

  app.put('/api/alarm', checkOrigin, requireAuth, async (req: Request, res: Response) => {
    try {
      const saved = await deps.deviceService.saveAlarm(req.body, nowSec());
      res.json({
        alarm: saved,
        device: deps.deviceService.getDeviceStatus(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cấu hình báo thức không hợp lệ' });
    }
  });

  app.post('/api/notifications/test', checkOrigin, requireAuth, async (req: Request, res: Response) => {
    const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = rawTitle || 'Kiểm tra NekoMate';
    const currentSec = nowSec();
    const notificationId = `${deviceId}:test:${crypto.randomUUID()}`;

    deps.deviceService.queueNotification(
      {
        notificationId,
        source: 'NekoMate Test',
        title,
        notifyAt: currentSec,
        expiresAt: currentSec + 300,
      },
      currentSec,
    );
    await deps.deviceService.tickDevice(currentSec);
    res.json({ notificationId, title, notifyAt: currentSec, expiresAt: currentSec + 300 });
  });

  app.get('/api/reminders', requireAuth, (_req: Request, res: Response) => {
    const sourceNames = new Map<string, string>();
    if (deps.sourcesService) {
      for (const s of deps.sourcesService.listSources()) {
        sourceNames.set(s.id, s.name);
      }
    }

    const timedRows = deps.db
      .prepare(
        `SELECT notification_id, source, source_id, title, notify_at, expires_at, status
         FROM notification_queue
         WHERE status != 'cancelled'
         ORDER BY notify_at ASC`,
      )
      .all() as Array<{
      notification_id: string;
      source: string;
      source_id: string | null;
      title: string;
      notify_at: number;
      expires_at: number;
      status: string;
    }>;

    const dateOnlyRows = deps.db
      .prepare(
        `SELECT source_id, external_id, title, date_only
         FROM source_items
         WHERE notify_at IS NULL AND date_only IS NOT NULL
         ORDER BY date_only ASC, title ASC`,
      )
      .all() as Array<{
      source_id: string;
      external_id: string;
      title: string;
      date_only: string;
    }>;

    const reminders = [
      ...timedRows.map((row) => ({
        id: row.notification_id,
        sourceId: row.source_id,
        source: row.source,
        title: row.title,
        notifyAt: row.notify_at,
        expiresAt: row.expires_at,
        localTime: formatLocalDateTime(row.notify_at, timezone),
        dateOnly: null,
        status: row.status,
      })),
      ...dateOnlyRows.map((row) => ({
        id: `${row.source_id}:${row.external_id}`,
        sourceId: row.source_id,
        source: sourceNames.get(row.source_id) ?? row.source_id,
        title: row.title,
        notifyAt: null,
        expiresAt: null,
        localTime: null,
        dateOnly: row.date_only,
        status: 'date_only',
      })),
    ];

    res.json({ timezone, reminders });
  });

  if (deps.sourcesService) {
    const sourcesSvc = deps.sourcesService;

    app.get('/api/sources', requireAuth, (_req: Request, res: Response) => {
      res.json({ sources: sourcesSvc.listSources() });
    });

    app.post('/api/sources/:id/connect', checkOrigin, requireAuth, async (req: Request, res: Response) => {
      try {
        const sourceId = String(req.params['id'] ?? '');
        const sessionTokenHash = res.locals['sessionTokenHash'] as string;
        const result = await sourcesSvc.startConnect(
          sourceId,
          sessionTokenHash,
          deps.appBaseUrl,
          nowSec(),
        );
        res.json(result);
      } catch (err) {
        if (err instanceof SourceHttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi tạo liên kết nguồn' });
      }
    });

    app.get('/api/sources/oauth/callback', requireAuth, async (req: Request, res: Response) => {
      try {
        const nonce = typeof req.query['nonce'] === 'string' ? req.query['nonce'] : '';
        const connectedAccountId =
          typeof req.query['connectedAccountId'] === 'string'
            ? req.query['connectedAccountId']
            : typeof req.query['connected_account_id'] === 'string'
              ? req.query['connected_account_id']
              : '';
        const sessionTokenHash = res.locals['sessionTokenHash'] as string;
        const result = await sourcesSvc.completeOAuthCallback({
          nonce,
          connectedAccountId,
          sessionTokenHash,
          nowSec: nowSec(),
        });

        const accept = req.get('accept') ?? '';
        if (accept.includes('text/html')) {
          res.status(200).type('html').send(
            '<!doctype html><html lang="vi"><meta charset="utf-8"><title>NekoMate</title>' +
            '<p>Đã liên kết thành công. Đang quay lại NekoMate...</p>' +
            '<script>location.replace("/");</script></html>',
          );
          return;
        }
        res.json(result);
      } catch (err) {
        if (err instanceof SourceHttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi xác nhận OAuth' });
      }
    });

    app.post('/api/sources/:id/sync', checkOrigin, requireAuth, async (req: Request, res: Response) => {
      try {
        const sourceId = String(req.params['id'] ?? '');
        await sourcesSvc.syncSource(sourceId, nowSec());
        res.json({ sources: sourcesSvc.listSources() });
      } catch (err) {
        if (err instanceof SourceHttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : 'Đồng bộ nguồn thất bại' });
      }
    });

    app.get('/api/sources/:id/options', requireAuth, async (req: Request, res: Response) => {
      try {
        const sourceId = String(req.params['id'] ?? '');
        const options = await sourcesSvc.listOptions(sourceId);
        res.json({ options });
      } catch (err) {
        if (err instanceof SourceHttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : 'Không lấy được danh sách từ nguồn' });
      }
    });

    app.put('/api/sources/:id/scope', checkOrigin, requireAuth, async (req: Request, res: Response) => {
      try {
        const sourceId = String(req.params['id'] ?? '');
        const scopeId = typeof req.body?.scopeId === 'string' ? req.body.scopeId : '';
        await sourcesSvc.updateScope(sourceId, scopeId, nowSec());
        res.json({ sources: sourcesSvc.listSources() });
      } catch (err) {
        if (err instanceof SourceHttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : 'Không cập nhật được phạm vi nguồn' });
      }
    });
  }

  return app;
}

function startServer(): void {
  const host = process.env['HOST'] || '127.0.0.1';
  const port = Number(process.env['PORT'] || '3000');
  const appBaseUrl = process.env['APP_BASE_URL'] || `http://${host}:${port}`;
  const ownerPasswordHash = process.env['OWNER_PASSWORD_HASH'] || '';
  const dbPath = path.resolve(process.env['DB_PATH'] || './data/nekomate.db');
  const deviceId = process.env['DEVICE_ID'] || 'nekomate-01';
  const timezone = process.env['TIMEZONE'] || 'Asia/Ho_Chi_Minh';
  const mqttUrl = process.env['MQTT_URL'] || 'mqtt://127.0.0.1:1883';
  const composioApiKey = process.env['COMPOSIO_API_KEY'] || '';
  const composioUserId = process.env['COMPOSIO_USER_ID'] || 'nekomate-owner';
  const verifiedEnv = process.env['NEKOMATE_VERIFIED_SOURCES'] || 'google_calendar,todoist';
  const verifiedSources = new Set(
    verifiedEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!ownerPasswordHash) {
    console.error('Thiếu OWNER_PASSWORD_HASH trong môi trường.');
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  const mqttClient = mqttLib.connect(mqttUrl, {
    username: process.env['MQTT_USERNAME'] || undefined,
    password: process.env['MQTT_PASSWORD'] || undefined,
    protocolVersion: 4,
    reconnectPeriod: 3000,
  });

  const mqttTransport: MqttTransport = {
    publish: (topic, payload, options) =>
      new Promise<void>((resolve, reject) => {
        if (!mqttClient.connected) {
          resolve();
          return;
        }
        mqttClient.publish(topic, payload, { qos: options.qos, retain: options.retain }, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };

  const deviceService = new DeviceService({ db, deviceId, mqtt: mqttTransport });
  const gateway = composioApiKey ? createSdkComposioGateway(composioApiKey) : null;
  const sourcesService = new SourcesService({
    db,
    deviceId,
    gateway,
    composioUserId,
    timezone,
    verifiedSources,
  });

  mqttClient.on('connect', () => {
    mqttClient.subscribe(
      [deviceService.topic('events'), deviceService.topic('status')],
      { qos: 1 },
    );
    void deviceService.handleMqttReconnect(Math.floor(Date.now() / 1000)).catch((err) => {
      console.error('Lỗi đồng bộ khi MQTT kết nối lại:', err);
    });
  });

  mqttClient.on('message', (topic, message) => {
    void deviceService
      .handleMqttMessage(topic, message.toString('utf8'), Math.floor(Date.now() / 1000))
      .catch((err) => {
        console.error('Lỗi xử lý MQTT message:', err);
      });
  });

  mqttClient.on('error', (err) => {
    console.error('Lỗi MQTT:', err.message);
  });

  const app = createApp({
    db,
    deviceService,
    sourcesService,
    appBaseUrl,
    ownerPasswordHash,
    deviceId,
    timezone,
  });

  setInterval(() => {
    void deviceService.tickDevice(Math.floor(Date.now() / 1000)).catch((err) => {
      console.error('Lỗi tick thiết bị:', err);
    });
  }, 5000);

  setInterval(() => {
    void sourcesService.syncAllConnected(Math.floor(Date.now() / 1000)).catch((err) => {
      console.error('Lỗi đồng bộ nguồn định kỳ:', err);
    });
  }, 5 * 60 * 1000);

  app.listen(port, host, () => {
    console.log(`NekoMate server đang chạy tại http://${host}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
