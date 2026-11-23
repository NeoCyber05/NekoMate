import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { hashPassword } from '../src/auth.ts';
import { openDatabase } from '../src/db.ts';
import { DeviceService, type MqttTransport } from '../src/device.ts';
import { createApp } from '../src/index.ts';

class NoopMqtt implements MqttTransport {
  async publish(): Promise<void> {}
}

function startTestServer() {
  let nowSec = 1_760_000_000;
  const db = openDatabase(':memory:');
  const deviceService = new DeviceService({ db, deviceId: 'nekomate-01', mqtt: new NoopMqtt() });
  const appBaseUrl = 'http://127.0.0.1:3000';
  const ownerPasswordHash = hashPassword('super-secret-cat');

  const app = createApp({
    db,
    deviceService,
    appBaseUrl,
    ownerPasswordHash,
    nowSec: () => nowSec,
  });

  const server = http.createServer(app);
  return new Promise<{
    baseUrl: string;
    advanceSec: (delta: number) => void;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Unexpected address');
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        advanceSec: (delta: number) => {
          nowSec += delta;
        },
        close: async () => {
          await new Promise<void>((res) => server.close(() => res()));
          db.close();
        },
      });
    });
  });
}

test('auth enforces guest rejection, origin check, rate limit, session expiry and logout', async () => {
  const srv = await startTestServer();
  const origin = 'http://127.0.0.1:3000';

  try {
    // 1. Khách gọi API cấu hình bị từ chối 401
    const unauthPut = await fetch(`${srv.baseUrl}/api/alarm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ hour: 7, minute: 0, days: [1], enabled: true }),
    });
    assert.equal(unauthPut.status, 401);

    // 2. Đăng nhập sai Origin bị chặn 403
    const badOriginLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ password: 'super-secret-cat' }),
    });
    assert.equal(badOriginLogin.status, 403);

    // 3. Đăng nhập sai liên tiếp -> lần thứ 6 bị giới hạn 429
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      assert.equal(bad.status, 401);
    }
    const limited = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'super-secret-cat' }),
    });
    assert.equal(limited.status, 429);

    // Qua 61 giây hết cửa sổ khóa IP
    srv.advanceSec(61);

    // 4. Đăng nhập đúng mật khẩu -> cấp cookie HttpOnly; SameSite=Lax
    const okLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'super-secret-cat' }),
    });
    assert.equal(okLogin.status, 200);
    const setCookie = okLogin.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookiePair = setCookie.split(';')[0] ?? '';

    // Ghi thiếu Origin dù có cookie vẫn bị chặn 403
    const missingOriginPut = await fetch(`${srv.baseUrl}/api/alarm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({ hour: 7, minute: 0, days: [1], enabled: true }),
    });
    assert.equal(missingOriginPut.status, 403);

    // Ghi đúng Origin + cookie thành công
    const okPut = await fetch(`${srv.baseUrl}/api/alarm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookiePair },
      body: JSON.stringify({ hour: 7, minute: 0, days: [1], enabled: true }),
    });
    assert.equal(okPut.status, 200);

    // 5. Hết hạn sau 24 giờ
    srv.advanceSec(24 * 3600 + 1);
    const expiredRes = await fetch(`${srv.baseUrl}/api/device`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(expiredRes.status, 401);

    // 6. Đăng nhập lại rồi đăng xuất -> thu hồi phiên
    const relogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'super-secret-cat' }),
    });
    assert.equal(relogin.status, 200);
    const cookie2 = (relogin.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const logoutRes = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie2 },
    });
    assert.equal(logoutRes.status, 200);

    const afterLogout = await fetch(`${srv.baseUrl}/api/device`, {
      headers: { Cookie: cookie2 },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await srv.close();
  }
});
