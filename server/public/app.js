const POLL_INTERVAL_MS = 3000;

const headerStatus = document.getElementById('header-status');
const onlineBadge = document.getElementById('online-badge');
const syncBadge = document.getElementById('sync-badge');
const logoutBtn = document.getElementById('logout-btn');
const liveStatus = document.getElementById('live-status');

const loginSection = document.getElementById('login-section');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const togglePasswordBtn = document.getElementById('toggle-password-btn');
const passwordError = document.getElementById('password-error');

const dashboardSection = document.getElementById('dashboard-section');
const alarmForm = document.getElementById('alarm-form');
const alarmTime = document.getElementById('alarm-time');
const alarmTimeError = document.getElementById('alarm-time-error');
const alarmDaysError = document.getElementById('alarm-days-error');
const alarmEnabled = document.getElementById('alarm-enabled');
const alarmConfirmedSummary = document.getElementById('alarm-confirmed-summary');

const testNotifyForm = document.getElementById('test-notify-form');
const testTitleInput = document.getElementById('test-title');

const sourcesListEl = document.getElementById('sources-list');
const refreshSourcesBtn = document.getElementById('refresh-sources-btn');
const remindersListEl = document.getElementById('reminders-list');
const remindersEmptyEl = document.getElementById('reminders-empty');
const refreshRemindersBtn = document.getElementById('refresh-reminders-btn');

let authenticated = false;
let pollTimerId = null;

function announceStatus(message, tone = 'info') {
  liveStatus.textContent = message;
  liveStatus.dataset.tone = tone;
  liveStatus.hidden = !message;
}

function setFieldInvalid(input, errorEl, invalid, message) {
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  input.classList.toggle('user-invalid-fallback', invalid);
  const errorId = errorEl.id;
  const currentIds = (input.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (invalid) {
    currentIds.push(errorId);
    if (message) {
      errorEl.textContent = `Lỗi: ${message}`;
    }
  }
  if (currentIds.length > 0) {
    input.setAttribute('aria-describedby', currentIds.join(' '));
  } else {
    input.removeAttribute('aria-describedby');
  }
  errorEl.hidden = !invalid;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/auth/login') {
    setAuthState(false);
  }
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Lỗi HTTP ${res.status}`);
  }
  return data;
}

function formatSyncStateText(syncState) {
  if (syncState === 'pending') {
    return 'Chờ đồng bộ';
  }
  if (syncState === 'synced') {
    return 'Đã đồng bộ';
  }
  return 'Chưa cài đặt';
}

function renderDeviceStatus(device) {
  onlineBadge.textContent = device.online ? 'Trực tuyến' : 'Ngoại tuyến';
  onlineBadge.className = `badge ${device.online ? 'badge-ok' : 'badge-warn'}`;

  syncBadge.textContent = formatSyncStateText(device.syncState);
  syncBadge.className =
    device.syncState === 'synced'
      ? 'badge badge-ok'
      : device.syncState === 'pending'
        ? 'badge badge-warn'
        : 'badge';

  const active = device.confirmedAlarm;
  if (active && typeof active.hour === 'number' && typeof active.minute === 'number') {
    const hh = String(active.hour).padStart(2, '0');
    const mm = String(active.minute).padStart(2, '0');
    const daysText = Array.isArray(active.days) ? active.days.map((d) => (d === 7 ? 'CN' : `T${d + 1}`)).join(', ') : '';
    const stateText = active.enabled ? 'Đang bật' : 'Đang tắt';
    alarmConfirmedSummary.textContent = `Đồng hồ đang giữ: ${hh}:${mm} (${daysText || 'không lặp'}) · ${stateText} · Rev ${active.revision}`;
  } else {
    alarmConfirmedSummary.textContent = 'Chưa có cấu hình xác nhận từ đồng hồ.';
  }
}

function populateAlarmForm(alarm) {
  if (!alarm) {
    return;
  }
  const hh = String(alarm.hour).padStart(2, '0');
  const mm = String(alarm.minute).padStart(2, '0');
  alarmTime.value = `${hh}:${mm}`;
  alarmEnabled.checked = Boolean(alarm.enabled);
  const selected = new Set(Array.isArray(alarm.days) ? alarm.days : []);
  alarmForm.querySelectorAll('input[name="days"]').forEach((cb) => {
    cb.checked = selected.has(Number(cb.value));
  });
}

function formatTimestamp(epochSec) {
  if (!epochSec) {
    return 'Chưa đồng bộ';
  }
  return new Date(epochSec * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function statusLabelForSource(status) {
  if (status === 'connected') return 'Đã kết nối';
  if (status === 'error') return 'Lỗi đồng bộ';
  return 'Chưa liên kết';
}

function renderSources(sources) {
  sourcesListEl.replaceChildren();
  for (const src of sources) {
    const card = document.createElement('article');
    card.className = 'source-item';

    const top = document.createElement('div');
    top.className = 'source-top';

    const title = document.createElement('h3');
    title.className = 'source-name';
    title.textContent = src.name;

    const statusBadge = document.createElement('span');
    statusBadge.className =
      src.status === 'connected'
        ? 'badge badge-ok'
        : src.status === 'error'
          ? 'badge badge-err'
          : 'badge';
    statusBadge.textContent = statusLabelForSource(src.status);

    top.append(title, statusBadge);
    card.appendChild(top);

    const meta = document.createElement('p');
    meta.className = 'hint';
    const kindLabel = src.kind === 'calendar' ? 'Lịch (nhắc trước 10 phút)' : src.timeMode === 'date_only' ? 'Công việc (chỉ hiển thị ngày)' : 'Công việc';
    const verifiedText = src.liveVerified ? 'Đã xác minh' : 'Bản mở rộng';
    meta.textContent = `${kindLabel} · ${verifiedText} · Lần cuối: ${formatTimestamp(src.lastSyncAt)}`;
    card.appendChild(meta);

    if (src.lastError) {
      const errP = document.createElement('p');
      errP.className = 'error-msg';
      errP.textContent = `Lỗi: ${src.lastError}`;
      card.appendChild(errP);
    }

    if (src.requiresScope && src.status !== 'disconnected') {
      const scopeRow = document.createElement('div');
      scopeRow.className = 'scope-row';

      const scopeLabel = document.createElement('label');
      const selectId = `scope-select-${src.id}`;
      scopeLabel.setAttribute('for', selectId);
      scopeLabel.textContent = 'Danh sách / Project theo dõi';

      const select = document.createElement('select');
      select.id = selectId;
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = src.scopeLabel ? `${src.scopeLabel} (đang chọn)` : '-- Chọn danh sách --';
      select.appendChild(placeholderOpt);

      const loadOptsBtn = document.createElement('button');
      loadOptsBtn.type = 'button';
      loadOptsBtn.className = 'btn-secondary';
      loadOptsBtn.textContent = 'Tải danh sách';

      const applyScopeBtn = document.createElement('button');
      applyScopeBtn.type = 'button';
      applyScopeBtn.className = 'btn-primary';
      applyScopeBtn.textContent = 'Lưu phạm vi';

      loadOptsBtn.addEventListener('click', async () => {
        try {
          loadOptsBtn.disabled = true;
          const data = await apiFetch(`/api/sources/${encodeURIComponent(src.id)}/options`);
          select.replaceChildren();
          for (const opt of data.options || []) {
            const o = document.createElement('option');
            o.value = opt.id;
            o.textContent = opt.label;
            if (opt.id === src.scopeId) {
              o.selected = true;
            }
            select.appendChild(o);
          }
          announceStatus(`Đã tải ${data.options?.length ?? 0} danh sách cho ${src.name}.`, 'ok');
        } catch (err) {
          announceStatus(err.message, 'error');
        } finally {
          loadOptsBtn.disabled = false;
        }
      });

      applyScopeBtn.addEventListener('click', async () => {
        if (!select.value) {
          announceStatus('Vui lòng chọn một danh sách trước khi lưu.', 'error');
          return;
        }
        try {
          applyScopeBtn.disabled = true;
          const data = await apiFetch(`/api/sources/${encodeURIComponent(src.id)}/scope`, {
            method: 'PUT',
            body: JSON.stringify({ scopeId: select.value }),
          });
          renderSources(data.sources || []);
          await refreshReminders();
          announceStatus(`Đã cập nhật phạm vi và đồng bộ ${src.name}.`, 'ok');
        } catch (err) {
          announceStatus(err.message, 'error');
        } finally {
          applyScopeBtn.disabled = false;
        }
      });

      const scopeBtns = document.createElement('div');
      scopeBtns.className = 'source-actions';
      scopeBtns.append(loadOptsBtn, applyScopeBtn);
      scopeRow.append(scopeLabel, select, scopeBtns);
      card.appendChild(scopeRow);
    }

    const actions = document.createElement('div');
    actions.className = 'source-actions';

    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'btn-secondary';
    connectBtn.textContent = src.status === 'disconnected' ? 'Kết nối' : 'Kết nối lại';
    connectBtn.addEventListener('click', async () => {
      try {
        connectBtn.disabled = true;
        const data = await apiFetch(`/api/sources/${encodeURIComponent(src.id)}/connect`, {
          method: 'POST',
        });
        if (data.redirectUrl) {
          window.location.assign(data.redirectUrl);
        }
      } catch (err) {
        announceStatus(err.message, 'error');
        connectBtn.disabled = false;
      }
    });

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn-primary';
    syncBtn.textContent = 'Đồng bộ ngay';
    syncBtn.disabled = src.status === 'disconnected';
    syncBtn.addEventListener('click', async () => {
      try {
        syncBtn.disabled = true;
        const data = await apiFetch(`/api/sources/${encodeURIComponent(src.id)}/sync`, {
          method: 'POST',
        });
        renderSources(data.sources || []);
        await refreshReminders();
        announceStatus(`Đã đồng bộ xong ${src.name}.`, 'ok');
      } catch (err) {
        announceStatus(err.message, 'error');
        await refreshSources();
      }
    });

    actions.append(connectBtn, syncBtn);
    card.appendChild(actions);
    sourcesListEl.appendChild(card);
  }
}

function reminderStatusLabel(status) {
  switch (status) {
    case 'pending': return 'Chờ nhắc';
    case 'shown': return 'Đã hiện';
    case 'dismissed': return 'Đã chạm tắt';
    case 'missed': return 'Quá hạn';
    case 'date_only': return 'Theo ngày';
    default: return status;
  }
}

function renderReminders(reminders) {
  remindersListEl.replaceChildren();
  remindersEmptyEl.hidden = reminders.length > 0;
  for (const item of reminders) {
    const li = document.createElement('li');
    li.className = 'reminder-row';

    const main = document.createElement('div');
    main.className = 'reminder-main';

    const titleEl = document.createElement('span');
    titleEl.className = 'reminder-title';
    titleEl.textContent = item.title;

    const metaEl = document.createElement('span');
    metaEl.className = 'reminder-meta';
    const timeText = item.localTime ? `Nhắc lúc ${item.localTime}` : item.dateOnly ? `Ngày hạn ${item.dateOnly}` : '';
    metaEl.textContent = `${item.source} · ${timeText}`;

    main.append(titleEl, metaEl);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = reminderStatusLabel(item.status);

    li.append(main, badge);
    remindersListEl.appendChild(li);
  }
}

async function refreshDevice(populateForm = false) {
  const device = await apiFetch('/api/device');
  renderDeviceStatus(device);
  if (populateForm && device.pendingAlarm) {
    populateAlarmForm(device.pendingAlarm);
  }
}

async function refreshSources() {
  const data = await apiFetch('/api/sources');
  renderSources(data.sources || []);
}

async function refreshReminders() {
  const data = await apiFetch('/api/reminders');
  renderReminders(data.reminders || []);
}

function stopPolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }
}

function startPolling() {
  stopPolling();
  if (!authenticated || document.visibilityState !== 'visible') {
    return;
  }
  pollTimerId = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void refreshDevice(false).catch(() => {});
    }
  }, POLL_INTERVAL_MS);
}

function setAuthState(nextAuth) {
  authenticated = nextAuth;
  loginSection.hidden = authenticated;
  dashboardSection.hidden = !authenticated;
  headerStatus.hidden = !authenticated;
  if (authenticated) {
    void Promise.all([refreshDevice(true), refreshSources(), refreshReminders()]).catch((err) => {
      announceStatus(err.message, 'error');
    });
    startPolling();
  } else {
    stopPolling();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!authenticated) {
    stopPolling();
    return;
  }
  if (document.visibilityState === 'visible') {
    void refreshDevice(false).catch(() => {});
    startPolling();
  } else {
    stopPolling();
  }
});

togglePasswordBtn.addEventListener('click', () => {
  const showing = loginPassword.type === 'text';
  loginPassword.type = showing ? 'password' : 'text';
  togglePasswordBtn.setAttribute('aria-pressed', String(!showing));
  togglePasswordBtn.textContent = showing ? 'Hiện' : 'Ẩn';
});

loginPassword.addEventListener('blur', () => {
  if (!loginPassword.value) {
    setFieldInvalid(loginPassword, passwordError, true, 'Vui lòng nhập mật khẩu quản trị.');
  }
});

loginPassword.addEventListener('input', () => {
  if (loginPassword.value) {
    setFieldInvalid(loginPassword, passwordError, false);
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!loginPassword.value) {
    setFieldInvalid(loginPassword, passwordError, true, 'Vui lòng nhập mật khẩu quản trị.');
    loginPassword.focus();
    return;
  }
  const btn = document.getElementById('login-submit-btn');
  try {
    btn.disabled = true;
    await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: loginPassword.value }),
    });
    loginPassword.value = '';
    setFieldInvalid(loginPassword, passwordError, false);
    announceStatus('Đăng nhập thành công.', 'ok');
    setAuthState(true);
  } catch (err) {
    setFieldInvalid(loginPassword, passwordError, true, err.message);
    announceStatus(err.message, 'error');
    loginPassword.focus();
  } finally {
    btn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    setAuthState(false);
    announceStatus('Đã đăng xuất.', 'info');
  }
});

alarmForm.addEventListener('change', () => {
  const selectedDays = Array.from(alarmForm.querySelectorAll('input[name="days"]:checked'));
  if (!alarmEnabled.checked || selectedDays.length > 0) {
    alarmDaysError.hidden = true;
  }
});

alarmForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const [hourStr, minStr] = (alarmTime.value || '').split(':');
  const hour = Number(hourStr);
  const minute = Number(minStr);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    setFieldInvalid(alarmTime, alarmTimeError, true, 'Vui lòng chọn giờ báo thức hợp lệ.');
    alarmTime.focus();
    return;
  }
  setFieldInvalid(alarmTime, alarmTimeError, false);

  const days = Array.from(alarmForm.querySelectorAll('input[name="days"]:checked')).map((el) =>
    Number(el.value),
  );
  const enabled = alarmEnabled.checked;
  if (enabled && days.length === 0) {
    alarmDaysError.hidden = false;
    announceStatus('Khi bật báo thức phải chọn ít nhất một ngày lặp.', 'error');
    return;
  }
  alarmDaysError.hidden = true;

  const btn = document.getElementById('alarm-submit-btn');
  try {
    btn.disabled = true;
    const data = await apiFetch('/api/alarm', {
      method: 'PUT',
      body: JSON.stringify({ hour, minute, days, enabled }),
    });
    renderDeviceStatus(data.device);
    announceStatus('Đã lưu báo thức và gửi lệnh đồng bộ xuống NekoMate.', 'ok');
  } catch (err) {
    announceStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

testNotifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('test-submit-btn');
  try {
    btn.disabled = true;
    await apiFetch('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ title: testTitleInput.value }),
    });
    await refreshReminders();
    announceStatus('Đã đưa lời nhắc thử vào hàng đợi gửi xuống đồng hồ.', 'ok');
  } catch (err) {
    announceStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

refreshSourcesBtn.addEventListener('click', () => {
  void refreshSources()
    .then(() => announceStatus('Đã làm mới danh sách nguồn.', 'ok'))
    .catch((err) => announceStatus(err.message, 'error'));
});

refreshRemindersBtn.addEventListener('click', () => {
  void refreshReminders()
    .then(() => announceStatus('Đã cập nhật danh sách lời nhắc.', 'ok'))
    .catch((err) => announceStatus(err.message, 'error'));
});

void apiFetch('/api/auth/me')
  .then((data) => {
    setAuthState(Boolean(data.authenticated));
  })
  .catch(() => {
    setAuthState(false);
  });
