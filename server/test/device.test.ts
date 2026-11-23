import assert from 'node:assert/strict';
import test from 'node:test';

import { openDatabase } from '../src/db.ts';
import { DeviceService, toDeviceTitle, type MqttTransport } from '../src/device.ts';

interface PublishedMessage {
  topic: string;
  payload: Record<string, unknown>;
  qos: 1;
  retain: boolean;
}

class FakeMqttTransport implements MqttTransport {
  readonly published: PublishedMessage[] = [];

  async publish(topic: string, payload: string, options: { qos: 1; retain: boolean }): Promise<void> {
    this.published.push({
      topic,
      payload: JSON.parse(payload) as Record<string, unknown>,
      qos: options.qos,
      retain: options.retain,
    });
  }
}

test('toDeviceTitle strips Vietnamese diacritics, đ/Đ, emoji and limits to 48 chars', () => {
  assert.equal(toDeviceTitle('Họp nhóm 🐱'), 'Hop nhom');
  assert.equal(toDeviceTitle('Đổi giờ'), 'Doi gio');
  assert.equal(toDeviceTitle('   🐱✨  '), 'Loi nhac');

  const longTitle = 'Đây là một tiêu đề thông báo rất dài vượt quá giới hạn bốn mươi tám ký tự cho phép';
  const normalized = toDeviceTitle(longTitle);
  assert.ok(normalized.length <= 48, `Expected <= 48 chars, got ${normalized.length}: ${normalized}`);
  assert.ok(normalized.endsWith('...'));
});

test('retries notification every 15s, stops on shown, and marks missed after expiresAt', async () => {
  const db = openDatabase(':memory:');
  const mqtt = new FakeMqttTransport();
  const svc = new DeviceService({ db, deviceId: 'nekomate-01', mqtt });

  svc.queueNotification({
    notificationId: 'n1',
    source: 'Google Calendar',
    title: 'Họp nhóm 🐱',
    notifyAt: 1000,
    expiresAt: 1300,
  });

  // Trước giờ nhắc không gửi
  await svc.tickDevice(999);
  assert.equal(mqtt.published.length, 0);

  // Đến hạn lần 1
  await svc.tickDevice(1000);
  assert.equal(mqtt.published.length, 1);
  assert.equal(mqtt.published[0]?.topic, 'nekomate/devices/nekomate-01/notify');
  assert.equal(mqtt.published[0]?.qos, 1);
  assert.equal(mqtt.published[0]?.retain, false);
  assert.equal(mqtt.published[0]?.payload['title'], 'Hop nhom');

  // Chưa tới 15s không gửi lại
  await svc.tickDevice(1014);
  assert.equal(mqtt.published.length, 1);

  // Đủ 15s thử lại
  await svc.tickDevice(1015);
  assert.equal(mqtt.published.length, 2);

  // Thiết bị báo shown -> chặn retry tiếp theo
  await svc.handleMqttMessage(
    'nekomate/devices/nekomate-01/events',
    JSON.stringify({ type: 'shown', notificationId: 'n1', at: 1016 }),
    1016,
  );
  await svc.tickDevice(1040);
  assert.equal(mqtt.published.length, 2);

  // Thông báo thứ hai quá hạn chưa có shown -> đánh dấu missed và không gửi nữa
  svc.queueNotification({
    notificationId: 'n2',
    source: 'Todoist',
    title: 'Đổi giờ',
    notifyAt: 2000,
    expiresAt: 2300,
  });
  await svc.tickDevice(2300);
  assert.equal(mqtt.published.length, 2);

  const row = db
    .prepare('SELECT status FROM notification_queue WHERE notification_id = ?')
    .get('n2') as { status: string } | undefined;
  assert.equal(row?.status, 'missed');
  db.close();
});

test('empty SQLite does not auto-publish alarm_config and stale revision 12 bumps to 13', async () => {
  const db = openDatabase(':memory:');
  const mqtt = new FakeMqttTransport();
  const svc = new DeviceService({ db, deviceId: 'nekomate-01', mqtt });

  await svc.tickDevice(5000);
  await svc.handleMqttReconnect(5000);
  assert.equal(mqtt.published.length, 0);
  assert.equal(svc.getDeviceStatus().syncState, 'unconfigured');

  // Chủ thiết bị lưu cấu hình mới -> revision = 1
  const saved = await svc.saveAlarm({ hour: 7, minute: 0, days: [1, 3, 5], enabled: true }, 5010);
  assert.equal(saved.revision, 1);
  assert.equal(mqtt.published.length, 1);
  assert.equal(mqtt.published[0]?.topic, 'nekomate/devices/nekomate-01/alarms/config');
  assert.equal(mqtt.published[0]?.retain, true);
  assert.equal(mqtt.published[0]?.qos, 1);

  // ACK cùng revision nhưng sai configId -> giữ nguyên trạng thái chờ
  await svc.handleMqttMessage(
    'nekomate/devices/nekomate-01/events',
    JSON.stringify({ type: 'alarm_config_applied', configId: 'wrong-id', revision: 1 }),
    5011,
  );
  assert.equal(svc.getDeviceStatus().syncState, 'pending');

  // Thiết bị báo stale vì NVS đang giữ revision 12 -> nâng lên 13 và giữ nguyên configId
  await svc.handleMqttMessage(
    'nekomate/devices/nekomate-01/events',
    JSON.stringify({
      type: 'alarm_config_stale',
      configId: saved.configId,
      revision: 1,
      appliedRevision: 12,
    }),
    5012,
  );

  assert.equal(mqtt.published.length, 2);
  assert.equal(mqtt.published[1]?.payload['configId'], saved.configId);
  assert.equal(mqtt.published[1]?.payload['revision'], 13);
  assert.equal(svc.getDeviceStatus().syncState, 'pending');

  // ACK khớp cả configId và revision=13 -> xác nhận đã đồng bộ
  await svc.handleMqttMessage(
    'nekomate/devices/nekomate-01/events',
    JSON.stringify({ type: 'alarm_config_applied', configId: saved.configId, revision: 13 }),
    5015,
  );
  const status = svc.getDeviceStatus();
  assert.equal(status.syncState, 'synced');
  assert.equal(status.confirmedAlarm?.revision, 13);
  assert.equal(status.confirmedAlarm?.configId, saved.configId);
  db.close();
});
