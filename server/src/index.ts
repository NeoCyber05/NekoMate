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
import { openDatabase } from './db.ts';
import { DeviceService, type MqttTransport } from './device.ts';

export interface AppDependencies {
  db: DatabaseSync;
  deviceService: DeviceService;
  appBaseUrl: string;
  ownerPasswordHash: string;
  deviceId?: string;
  nowSec?: () => number;
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  const limiter = new LoginRateLimiter();
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const deviceId = deps.deviceId ?? 'nekomate-01';

  app.use(express.json({ limit: '64kb' }));

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

  app.post('/api/auth/logout', checkOrigin, requireAuth, (req: Request, res: Response) => {
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

  return app;
}

function startServer(): void {
  const host = process.env['HOST'] || '127.0.0.1';
  const port = Number(process.env['PORT'] || '3000');
  const appBaseUrl = process.env['APP_BASE_URL'] || `http://${host}:${port}`;
  const ownerPasswordHash = process.env['OWNER_PASSWORD_HASH'] || '';
  const dbPath = path.resolve(process.env['DB_PATH'] || './data/nekomate.db');
  const deviceId = process.env['DEVICE_ID'] || 'nekomate-01';
  const mqttUrl = process.env['MQTT_URL'] || 'mqtt://127.0.0.1:1883';

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
    appBaseUrl,
    ownerPasswordHash,
    deviceId,
  });

  setInterval(() => {
    void deviceService.tickDevice(Math.floor(Date.now() / 1000)).catch((err) => {
      console.error('Lỗi tick thiết bị:', err);
    });
  }, 5000);

  app.listen(port, host, () => {
    console.log(`NekoMate server đang chạy tại http://${host}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
