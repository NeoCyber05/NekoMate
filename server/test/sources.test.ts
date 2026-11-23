import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { hashPassword } from '../src/auth.ts';
import type { ComposioConnectedAccount, ComposioGateway } from '../src/adapters/types.ts';
import { openDatabase } from '../src/db.ts';
import { DeviceService, type MqttTransport } from '../src/device.ts';
import { createApp } from '../src/index.ts';
import { SourcesService } from '../src/sources.ts';

const FIXTURES_DIR = path.resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;
}

class NoopMqtt implements MqttTransport {
  async publish(): Promise<void> {}
}

test('Google Calendar & Todoist normalize items, keep queue IDs on title edit, coalesce concurrent sync, and protect last good data on page failure', async () => {
  const db = openDatabase(':memory:');
  const deviceService = new DeviceService({ db, deviceId: 'nekomate-01', mqtt: new NoopMqtt() });

  let gcalMode: 'initial' | 'renamed' | 'rescheduled_and_cancelled' | 'fail_last_page' | 'slow' = 'initial';
  let gcalReadCalls = 0;
  let releaseSlowPage = () => {};

  const gcalPage1 = loadFixture('google-calendar-page1.json');
  const gcalPage2 = loadFixture('google-calendar-page2.json');
  const todoPage1 = loadFixture('todoist-page1.json');
  const todoPage2 = loadFixture('todoist-page2.json');

  const gateway: ComposioGateway = {
    async createConnectLink({ toolkit }) {
      return { connectionRequestId: `req-${toolkit}`, redirectUrl: `https://composio.test/auth/${toolkit}` };
    },
    async getConnectedAccount(id): Promise<ComposioConnectedAccount | null> {
      return { id, userId: 'nekomate-owner', toolkitSlug: 'googlecalendar', status: 'ACTIVE' };
    },
    async executeTool({ toolSlug, arguments: args }) {
      if (toolSlug === 'GOOGLECALENDAR_EVENTS_LIST') {
        const pageToken = args['pageToken'];
        if (!pageToken) {
          gcalReadCalls++;
          if (gcalMode === 'slow') {
            await new Promise<void>((resolve) => {
              releaseSlowPage = resolve;
            });
          }
          if (gcalMode === 'renamed') {
            const clone = structuredClone(gcalPage1);
            const items = clone['items'] as Array<Record<string, unknown>>;
            items[0]!['summary'] = 'Họp nhóm đã đổi tên';
            return clone;
          }
          if (gcalMode === 'rescheduled_and_cancelled') {
            const clone = structuredClone(gcalPage1);
            const items = clone['items'] as Array<Record<string, unknown>>;
            items[0]!['status'] = 'cancelled';
            (items[1]!['start'] as Record<string, unknown>)['dateTime'] = '2026-11-24T10:00:00+07:00';
            return clone;
          }
          return structuredClone(gcalPage1);
        }
        if (pageToken === 'gcal-page-2') {
          if (gcalMode === 'fail_last_page') {
            throw new Error('Lỗi mạng trang cuối');
          }
          return structuredClone(gcalPage2);
        }
      }
      if (toolSlug === 'TODOIST_GET_ALL_TASKS') {
        const cursor = args['cursor'];
        if (!cursor) {
          return structuredClone(todoPage1);
        }
        if (cursor === 'todo-cursor-2') {
          return structuredClone(todoPage2);
        }
      }
      throw new Error(`Unexpected tool ${toolSlug}`);
    },
  };

  const sources = new SourcesService({
    db,
    deviceId: 'nekomate-01',
    gateway,
    composioUserId: 'nekomate-owner',
    timezone: 'Asia/Ho_Chi_Minh',
  });

  // Liên kết thủ công cho test sync
  sources.setConnectedAccountForTest('google_calendar', 'conn-gcal-1');
  sources.setConnectedAccountForTest('todoist', 'conn-todo-1');

  const nowInitial = Math.floor(Date.parse('2026-11-23T08:00:00+07:00') / 1000);
  await sources.syncSource('google_calendar', nowInitial);
  await sources.syncSource('todoist', nowInitial);

  // Kiểm tra Google Calendar: 09:00 -> nhắc 08:50, lịch lặp giữ buổi valid, bỏ cancelled, cả ngày giữ dateOnly
  const evt1Notify = Math.floor(Date.parse('2026-11-23T08:50:00+07:00') / 1000);
  const gcalItems = db
    .prepare('SELECT external_id, title, date_only, notify_at FROM source_items WHERE source_id = ? ORDER BY external_id')
    .all('google_calendar') as Array<{ external_id: string; title: string; date_only: string | null; notify_at: number | null }>;

  assert.equal(gcalItems.length, 3);
  const evt1 = gcalItems.find((i) => i.external_id === 'evt-1');
  assert.equal(evt1?.notify_at, evt1Notify);
  const allDay = gcalItems.find((i) => i.external_id === 'evt-allday');
  assert.equal(allDay?.date_only, '2026-11-26');
  assert.equal(allDay?.notify_at, null);
  assert.equal(gcalItems.find((i) => i.external_id === 'evt-rec_20261125T020000Z'), undefined);

  const qBefore = db
    .prepare('SELECT notification_id, title, notify_at, status FROM notification_queue WHERE source_id = ? AND external_id = ?')
    .get('google_calendar', 'evt-1') as { notification_id: string; title: string; notify_at: number; status: string };
  assert.equal(qBefore.title, 'Họp nhóm 🐱');
  assert.equal(qBefore.notify_at, evt1Notify);
  assert.equal(qBefore.status, 'pending');

  // Kiểm tra Todoist: timed (có & không TZ), date-only (notifyAt=null), bỏ completed
  const todoItems = db
    .prepare('SELECT external_id, date_only, notify_at FROM source_items WHERE source_id = ? ORDER BY external_id')
    .all('todoist') as Array<{ external_id: string; date_only: string | null; notify_at: number | null }>;
  assert.equal(todoItems.length, 3);
  assert.equal(
    todoItems.find((i) => i.external_id === 'todo-floating')?.notify_at,
    Math.floor(Date.parse('2026-11-23T15:00:00+07:00') / 1000),
  );
  assert.equal(todoItems.find((i) => i.external_id === 'todo-dateonly')?.date_only, '2026-11-24');
  assert.equal(todoItems.find((i) => i.external_id === 'todo-dateonly')?.notify_at, null);
  assert.equal(todoItems.find((i) => i.external_id === 'todo-done'), undefined);

  // Đổi tiêu đề cùng giờ nhắc -> giữ nguyên notification_id, cập nhật title
  gcalMode = 'renamed';
  await sources.syncSource('google_calendar', nowInitial + 10);
  const qAfterRename = db
    .prepare('SELECT notification_id, title, status FROM notification_queue WHERE notification_id = ?')
    .get(qBefore.notification_id) as { notification_id: string; title: string; status: string };
  assert.equal(qAfterRename.title, 'Họp nhóm đã đổi tên');
  assert.equal(qAfterRename.status, 'pending');

  // Lỗi ở trang cuối -> giữ nguyên dữ liệu cũ
  gcalMode = 'fail_last_page';
  await assert.rejects(() => sources.syncSource('google_calendar', nowInitial + 20));
  const keptCount = (
    db.prepare('SELECT COUNT(*) AS c FROM source_items WHERE source_id = ?').get('google_calendar') as { c: number }
  ).c;
  assert.equal(keptCount, 3);
  const srcStatus = sources.listSources().find((s) => s.id === 'google_calendar');
  assert.equal(srcStatus?.status, 'error');

  // Dời giờ và hủy sự kiện -> lệnh cũ cancelled, lệnh giờ mới được tạo
  gcalMode = 'rescheduled_and_cancelled';
  await sources.syncSource('google_calendar', nowInitial + 30);
  const cancelledRow = db
    .prepare('SELECT status FROM notification_queue WHERE notification_id = ?')
    .get(qBefore.notification_id) as { status: string };
  assert.equal(cancelledRow.status, 'cancelled');
  const rescheduledNotify = Math.floor(Date.parse('2026-11-24T09:50:00+07:00') / 1000);
  const rescheduledRows = db
    .prepare('SELECT notify_at, status FROM notification_queue WHERE source_id = ? AND external_id = ? ORDER BY notify_at')
    .all('google_calendar', 'evt-rec_20261124T020000Z') as Array<{ notify_at: number; status: string }>;
  assert.equal(rescheduledRows[0]?.status, 'cancelled');
  assert.equal(rescheduledRows[1]?.notify_at, rescheduledNotify);
  assert.equal(rescheduledRows[1]?.status, 'pending');

  // Gộp timer và bấm Đồng bộ ngay khi đang chạy cùng phạm vi -> chỉ đọc 1 lần
  gcalMode = 'slow';
  const callsBefore = gcalReadCalls;
  const p1 = sources.syncSource('google_calendar', nowInitial + 40);
  const p2 = sources.syncSource('google_calendar', nowInitial + 41);
  // Đợi một microtask để p1 vào tới executeTool
  await new Promise((r) => setTimeout(r, 15));
  releaseSlowPage();
  await Promise.all([p1, p2]);
  assert.equal(gcalReadCalls - callsBefore, 1);

  void deviceService;
  db.close();
});

test('OAuth callback rejects expired attempt, replay, wrong session, and wrong owner account without changing source', async () => {
  let nowSec = 1_760_000_000;
  const db = openDatabase(':memory:');
  const deviceService = new DeviceService({ db, deviceId: 'nekomate-01', mqtt: new NoopMqtt() });
  const appBaseUrl = 'http://127.0.0.1:3000';

  let mockAccount: ComposioConnectedAccount | null = {
    id: 'acct-good',
    userId: 'nekomate-owner',
    toolkitSlug: 'googlecalendar',
    status: 'ACTIVE',
  };

  const gateway: ComposioGateway = {
    async createConnectLink({ toolkit, callbackUrl }) {
      assert.ok(callbackUrl.startsWith(`${appBaseUrl}/api/sources/oauth/callback?nonce=`));
      return {
        connectionRequestId: `req-${toolkit}`,
        redirectUrl: `https://composio.test/link?cb=${encodeURIComponent(callbackUrl)}`,
      };
    },
    async getConnectedAccount(id) {
      return mockAccount && mockAccount.id === id ? mockAccount : null;
    },
    async executeTool() {
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

  const app = createApp({
    db,
    deviceService,
    sourcesService,
    appBaseUrl,
    ownerPasswordHash: hashPassword('owner-pass'),
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
    const login = async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: appBaseUrl },
        body: JSON.stringify({ password: 'owner-pass' }),
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };

    const cookieA = await login();
    const cookieB = await login();

    const startConnect = async (cookie: string) => {
      const res = await fetch(`${baseUrl}/api/sources/google_calendar/connect`, {
        method: 'POST',
        headers: { Origin: appBaseUrl, Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { redirectUrl: string };
      const outer = new URL(body.redirectUrl);
      const cbUrl = new URL(outer.searchParams.get('cb')!);
      return cbUrl.searchParams.get('nonce')!;
    };

    // 1. Khác phiên chủ -> 403/401 từ chối, nguồn giữ nguyên disconnected
    const nonce1 = await startConnect(cookieA);
    const wrongSessionRes = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce1}&connectedAccountId=acct-good`,
      { headers: { Cookie: cookieB } },
    );
    assert.equal(wrongSessionRes.status, 403);

    // 2. Tài khoản sai chủ -> từ chối
    mockAccount = {
      id: 'acct-wrong-owner',
      userId: 'other-user',
      toolkitSlug: 'googlecalendar',
      status: 'ACTIVE',
    };
    const wrongOwnerRes = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce1}&connectedAccountId=acct-wrong-owner`,
      { headers: { Cookie: cookieA } },
    );
    assert.equal(wrongOwnerRes.status, 403);

    // 3. Hết hạn sau 10 phút -> từ chối
    mockAccount = {
      id: 'acct-good',
      userId: 'nekomate-owner',
      toolkitSlug: 'googlecalendar',
      status: 'ACTIVE',
    };
    nowSec += 601;
    const expiredRes = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce1}&connectedAccountId=acct-good`,
      { headers: { Cookie: cookieA } },
    );
    assert.equal(expiredRes.status, 400);
    assert.equal(sourcesService.listSources().find((s) => s.id === 'google_calendar')?.status, 'disconnected');

    // 4. Nonce mới hợp lệ -> thành công lần 1, gọi lần 2 (replay) bị từ chối
    const nonce2 = await startConnect(cookieA);
    const okRes = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce2}&connectedAccountId=acct-good`,
      { headers: { Cookie: cookieA } },
    );
    assert.equal(okRes.status, 200);
    assert.equal(sourcesService.listSources().find((s) => s.id === 'google_calendar')?.status, 'connected');

    const replayRes = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce2}&connectedAccountId=acct-good`,
      { headers: { Cookie: cookieA } },
    );
    assert.equal(replayRes.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('extended adapters (Outlook, To Do, TickTick, Google Tasks), safe Outlook scope upgrade, and scope switch lock', async () => {
  let nowSec = Math.floor(Date.parse('2026-11-23T08:00:00+07:00') / 1000);
  const db = openDatabase(':memory:');
  const deviceService = new DeviceService({ db, deviceId: 'nekomate-01', mqtt: new NoopMqtt() });
  const appBaseUrl = 'http://127.0.0.1:3000';

  const olCal = loadFixture('outlook-calendar.json');
  const todoLists = loadFixture('microsoft-todo-lists.json');
  const todoTasks = loadFixture('microsoft-todo-tasks.json');
  const ttProjects = loadFixture('ticktick-projects.json');
  const ttData = loadFixture('ticktick-project-data.json');
  const gtLists = loadFixture('google-tasks-lists.json');
  const gtItems = loadFixture('google-tasks-items.json');

  let slowListA = false;
  let releaseListA = () => {};

  const gateway: ComposioGateway = {
    async createConnectLink({ toolkit, callbackUrl }) {
      return {
        connectionRequestId: `req-${toolkit}`,
        redirectUrl: `https://composio.test/link?cb=${encodeURIComponent(callbackUrl)}`,
      };
    },
    async getConnectedAccount(id) {
      if (id === 'acct-ol-cal-only' || id === 'acct-ol-full') {
        return { id, userId: 'nekomate-owner', toolkitSlug: 'outlook', status: 'ACTIVE' };
      }
      return null;
    },
    async executeTool({ toolSlug, connectedAccountId, arguments: args }) {
      if (toolSlug === 'OUTLOOK_GET_CALENDAR_VIEW') {
        return structuredClone(olCal);
      }
      if (toolSlug === 'OUTLOOK_LIST_TO_DO_LISTS') {
        if (connectedAccountId === 'acct-ol-cal-only') {
          throw new Error('Thiếu quyền Tasks.Read');
        }
        return structuredClone(todoLists);
      }
      if (toolSlug === 'OUTLOOK_LIST_TODO_TASKS') {
        const listId = args['todoTaskListId'];
        if (listId === 'list-a') {
          if (slowListA) {
            await new Promise<void>((resolve) => {
              releaseListA = resolve;
            });
          }
          return structuredClone(todoTasks);
        }
        if (listId === 'list-b') {
          return {
            value: [
              {
                id: 'ms-todo-b1',
                title: 'Việc ở danh sách B',
                status: 'notStarted',
                isReminderOn: true,
                reminderDateTime: {
                  dateTime: '2026-11-23T18:00:00.0000000',
                  timeZone: 'Asia/Bangkok',
                },
              },
            ],
          };
        }
      }
      if (toolSlug === 'TICKTICK_GET_USER_PROJECT') {
        return structuredClone(ttProjects);
      }
      if (toolSlug === 'TICKTICK_GET_PROJECT_WITH_DATA') {
        return structuredClone(ttData);
      }
      if (toolSlug === 'GOOGLETASKS_LIST_TASK_LISTS') {
        return structuredClone(gtLists);
      }
      if (toolSlug === 'GOOGLETASKS_LIST_TASKS') {
        return structuredClone(gtItems);
      }
      throw new Error(`Unexpected tool ${toolSlug}`);
    },
  };

  const sourcesService = new SourcesService({
    db,
    deviceId: 'nekomate-01',
    gateway,
    composioUserId: 'nekomate-owner',
    timezone: 'Asia/Ho_Chi_Minh',
  });

  // 1. Outlook Calendar đang chạy với acct-ol-cal-only
  sourcesService.setConnectedAccountForTest('outlook_calendar', 'acct-ol-cal-only');
  await sourcesService.syncSource('outlook_calendar', nowSec);

  const olItems = db
    .prepare('SELECT external_id, date_only, notify_at FROM source_items WHERE source_id = ?')
    .all('outlook_calendar') as Array<{ external_id: string; date_only: string | null; notify_at: number | null }>;
  assert.equal(olItems.length, 2);
  assert.equal(
    olItems.find((i) => i.external_id === 'ol-evt-rec-1')?.notify_at,
    Math.floor(Date.parse('2026-11-23T10:20:00+07:00') / 1000),
  );
  assert.equal(olItems.find((i) => i.external_id === 'ol-evt-allday')?.date_only, '2026-11-25');
  assert.equal(olItems.find((i) => i.external_id === 'ol-evt-allday')?.notify_at, null);

  // 2. Thử nâng cấp Outlook cho Microsoft To Do nhưng thiếu quyền Tasks.Read -> giữ nguyên Outlook Calendar
  const app = createApp({
    db,
    deviceService,
    sourcesService,
    appBaseUrl,
    ownerPasswordHash: hashPassword('owner-pass'),
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
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: appBaseUrl },
      body: JSON.stringify({ password: 'owner-pass' }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const connRes1 = await fetch(`${baseUrl}/api/sources/microsoft_todo/connect`, {
      method: 'POST',
      headers: { Origin: appBaseUrl, Cookie: cookie },
    });
    const nonce1 = new URL(
      new URL(((await connRes1.json()) as { redirectUrl: string }).redirectUrl).searchParams.get('cb')!,
    ).searchParams.get('nonce')!;

    // Tài khoản chưa đủ quyền -> bị từ chối, Outlook Calendar vẫn hoạt động
    const failUpgrade = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce1}&connectedAccountId=acct-ol-cal-only`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(failUpgrade.status, 403);
    await sourcesService.syncSource('outlook_calendar', nowSec + 5);

    // Liên kết mới đủ quyền -> cập nhật dùng chung cho cả Outlook Calendar và Microsoft To Do
    const connRes2 = await fetch(`${baseUrl}/api/sources/microsoft_todo/connect`, {
      method: 'POST',
      headers: { Origin: appBaseUrl, Cookie: cookie },
    });
    const nonce2 = new URL(
      new URL(((await connRes2.json()) as { redirectUrl: string }).redirectUrl).searchParams.get('cb')!,
    ).searchParams.get('nonce')!;
    const okUpgrade = await fetch(
      `${baseUrl}/api/sources/oauth/callback?nonce=${nonce2}&connectedAccountId=acct-ol-full`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(okUpgrade.status, 200);

    // Chọn list-a cho Microsoft To Do qua HTTP
    const optRes = await fetch(`${baseUrl}/api/sources/microsoft_todo/options`, {
      headers: { Cookie: cookie },
    });
    assert.equal(optRes.status, 200);
    const optBody = (await optRes.json()) as { options: Array<{ id: string; label: string }> };
    assert.equal(optBody.options.length, 2);

    const scopeARes = await fetch(`${baseUrl}/api/sources/microsoft_todo/scope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: appBaseUrl, Cookie: cookie },
      body: JSON.stringify({ scopeId: 'list-a' }),
    });
    assert.equal(scopeARes.status, 200);

    const todoItems = db
      .prepare('SELECT external_id, date_only, notify_at FROM source_items WHERE source_id = ?')
      .all('microsoft_todo') as Array<{ external_id: string; date_only: string | null; notify_at: number | null }>;
    assert.equal(todoItems.length, 2);
    assert.equal(
      todoItems.find((i) => i.external_id === 'ms-todo-1')?.notify_at,
      Math.floor(Date.parse('2026-11-23T15:15:00+07:00') / 1000),
    );
    assert.equal(todoItems.find((i) => i.external_id === 'ms-todo-noreminder')?.notify_at, null);
    assert.equal(todoItems.find((i) => i.external_id === 'ms-todo-noreminder')?.date_only, '2026-11-24');

    // 3. Đồng bộ phạm vi A bị giữ ở trang cuối, đổi phạm vi B chờ, sau đó B thay dữ liệu sạch
    slowListA = true;
    const syncAPromise = sourcesService.syncSource('microsoft_todo', nowSec + 10);
    await new Promise((r) => setTimeout(r, 15));
    const switchBPromise = sourcesService.updateScope('microsoft_todo', 'list-b', nowSec + 11);
    await new Promise((r) => setTimeout(r, 15));
    releaseListA();
    await Promise.all([syncAPromise, switchBPromise]);

    const itemsAfterB = db
      .prepare('SELECT external_id FROM source_items WHERE source_id = ?')
      .all('microsoft_todo') as Array<{ external_id: string }>;
    assert.deepEqual(itemsAfterB.map((i) => i.external_id), ['ms-todo-b1']);

    // 4. TickTick & Google Tasks
    sourcesService.setConnectedAccountForTest('ticktick', 'conn-tt-1', 'proj-work', 'Dự án A');
    await sourcesService.syncSource('ticktick', nowSec + 20);
    const ttRows = db
      .prepare('SELECT external_id, date_only, notify_at FROM source_items WHERE source_id = ?')
      .all('ticktick') as Array<{ external_id: string; date_only: string | null; notify_at: number | null }>;
    assert.equal(ttRows.length, 2);
    assert.equal(
      ttRows.find((i) => i.external_id === 'tt-timed')?.notify_at,
      Math.floor(Date.parse('2026-11-23T08:45:00.000Z') / 1000),
    );
    assert.equal(ttRows.find((i) => i.external_id === 'tt-allday')?.date_only, '2026-11-24');
    assert.equal(ttRows.find((i) => i.external_id === 'tt-allday')?.notify_at, null);

    sourcesService.setConnectedAccountForTest('google_tasks', 'conn-gt-1', 'gtask-list-1', 'Việc cần làm');
    await sourcesService.syncSource('google_tasks', nowSec + 30);
    const gtRows = db
      .prepare('SELECT external_id, date_only, notify_at FROM source_items WHERE source_id = ?')
      .all('google_tasks') as Array<{ external_id: string; date_only: string | null; notify_at: number | null }>;
    assert.deepEqual(
      gtRows.map((r) => ({ ...r })),
      [{ external_id: 'gtask-1', date_only: '2026-11-24', notify_at: null }],
    );
    const gtQueueCount = (
      db.prepare('SELECT COUNT(*) AS c FROM notification_queue WHERE source_id = ?').get('google_tasks') as { c: number }
    ).c;
    assert.equal(gtQueueCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
