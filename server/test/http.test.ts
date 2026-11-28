import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { hashPassword } from '../src/auth.ts';
import type { ComposioGateway } from '../src/adapters/types.ts';
import { openDatabase } from '../src/db.ts';
import { DeviceService, type MqttTransport } from '../src/device.ts';
import { createApp } from '../src/index.ts';
import { SourcesService } from '../src/sources.ts';

class NoopMqtt implements MqttTransport {
  async publish(): Promise<void> {}
}

test('HTTP endpoints enforce guest auth, Chờ đồng bộ -> synced lifecycle, Unicode reminders, and safe static dashboard', async () => {
  const nowSec = Math.floor(Date.parse('2026-11-23T08:00:00+07:00') / 1000);
  const db = openDatabase(':memory:');
  const deviceService = new DeviceService({ db, deviceId: 'nekomate-01', mqtt: new NoopMqtt() });

  const gateway: ComposioGateway = {
    async createConnectLink() {
      return { connectionRequestId: 'r1', redirectUrl: 'https://composio.test/auth' };
    },
    async getConnectedAccount() {
      return null;
    },
    async executeTool({ toolSlug }) {
      if (toolSlug === 'GOOGLECALENDAR_EVENTS_LIST') {
        return {
          items: [
            {
              id: 'evt-xss',
              status: 'confirmed',
              summary: 'Họp nhóm 🐱 <script>alert(1)</script>',
              start: { dateTime: '2026-11-23T09:00:00+07:00' },
            },
          ],
        };
      }
      if (toolSlug === 'GOOGLETASKS_LIST_TASKS') {
        return {
          items: [
            {
              id: 'gt-date',
              title: 'Nộp thuế năm',
              status: 'needsAction',
              due: '2026-11-24T00:00:00.000Z',
            },
          ],
        };
      }
      return { items: [] };
    },
  };

  const sourcesService = new SourcesService({
    db,
    deviceId: 'nekomate-01',
    gateway,
    composioUserId: 'nekomate-owner',
    timezone: 'Asia/Ho_Chi_Minh',
  });
  sourcesService.setConnectedAccountForTest('google_calendar', 'c-gcal');
  sourcesService.setConnectedAccountForTest('google_tasks', 'c-gt', 'list-1', 'Danh sách 1');
  await sourcesService.syncSource('google_calendar', nowSec);
  await sourcesService.syncSource('google_tasks', nowSec);

  const appBaseUrl = 'http://127.0.0.1:3000';
  const app = createApp({
    db,
    deviceService,
    sourcesService,
    appBaseUrl,
    ownerPasswordHash: hashPassword('owner-pass'),
    timezone: 'Asia/Ho_Chi_Minh',
    nowSec: () => nowSec,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unexpected address');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Khách bị từ chối ở các API dữ liệu
    assert.equal((await fetch(`${baseUrl}/api/reminders`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/device`)).status, 401);

    // 2. Đăng nhập
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: appBaseUrl },
      body: JSON.stringify({ password: 'owner-pass' }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    // 3. Đặt báo thức -> trạng thái chờ đồng bộ cho tới khi nhận đúng configId & revision
    const putRes = await fetch(`${baseUrl}/api/alarm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: appBaseUrl, Cookie: cookie },
      body: JSON.stringify({ hour: 7, minute: 30, days: [1, 2, 3, 4, 5], enabled: true }),
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as {
      alarm: { configId: string; revision: number };
      device: { syncState: string };
    };
    assert.equal(putBody.device.syncState, 'pending');

    await deviceService.handleMqttMessage(
      'nekomate/devices/nekomate-01/events',
      JSON.stringify({
        type: 'alarm_config_applied',
        configId: 'other-config',
        revision: putBody.alarm.revision,
      }),
      nowSec + 1,
    );
    const devPending = (await (
      await fetch(`${baseUrl}/api/device`, { headers: { Cookie: cookie } })
    ).json()) as { syncState: string };
    assert.equal(devPending.syncState, 'pending');

    await deviceService.handleMqttMessage(
      'nekomate/devices/nekomate-01/events',
      JSON.stringify({
        type: 'alarm_config_applied',
        configId: putBody.alarm.configId,
        revision: putBody.alarm.revision,
      }),
      nowSec + 2,
    );
    const devSynced = (await (
      await fetch(`${baseUrl}/api/device`, { headers: { Cookie: cookie } })
    ).json()) as { syncState: string };
    assert.equal(devSynced.syncState, 'synced');

    // 4. GET /api/reminders giữ nguyên Unicode & ký tự đặc biệt, format localTime & dateOnly
    const remRes = await fetch(`${baseUrl}/api/reminders`, { headers: { Cookie: cookie } });
    assert.equal(remRes.status, 200);
    const remBody = (await remRes.json()) as {
      reminders: Array<{
        title: string;
        source: string;
        localTime: string | null;
        dateOnly: string | null;
        status: string;
      }>;
    };
    const evt = remBody.reminders.find((r) => r.source === 'Google Calendar');
    assert.equal(evt?.title, 'Họp nhóm 🐱 <script>alert(1)</script>');
    assert.equal(evt?.localTime, '2026-11-23 08:50');
    assert.equal(evt?.status, 'pending');

    const dateTask = remBody.reminders.find((r) => r.source === 'Google Tasks');
    assert.equal(dateTask?.dateOnly, '2026-11-24');
    assert.equal(dateTask?.localTime, null);
    assert.equal(dateTask?.status, 'date_only');

    // 5. Express phục vụ trang và tài nguyên đã build từ cùng origin.
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /color-scheme/);
    assert.match(html, /NekoMate/);

    assert.match(html, /src="\/ui\/dashboard\.js"/);
    assert.match(html, /href="\/ui\/dashboard\.css"/);

    const jsRes = await fetch(`${baseUrl}/ui/dashboard.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') ?? '', /javascript/);
    const cssRes = await fetch(`${baseUrl}/ui/dashboard.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') ?? '', /text\/css/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
