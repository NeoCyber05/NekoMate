import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { Brand, ClockStage, Icon, formatAlarm, useDeskTime } from './device-visual.jsx';
import { Alarms, alarmFromItem, nextAlarm } from './alarms.jsx';
import { Login, Reminders, Sources } from './panels.jsx';
import './style.css';

const screens = {
  overview: 'Tổng quan',
  alarm: 'Báo thức',
  reminders: 'Lời nhắc',
  sources: 'App kết nối',
};

const screenDescriptions = {
  alarm: 'Quản lý các mốc reo trên đồng hồ NekoMate.',
  reminders: 'Gửi lời nhắc ngay hoặc xem các lời nhắc đã lên lịch.',
  sources: 'Mở lịch và công việc đã đồng bộ để đặt báo thức.',
};

const pollInterval = 3000;

function readScreen() {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(screens, hash) ? hash : 'overview';
}

async function request(path, { body, method = 'GET', signal } = {}, onUnauthorized) {
  const response = await fetch(`/api${path}`, {
    method, signal, credentials: 'same-origin',
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) onUnauthorized?.();
  if (!response.ok) throw new Error(data.error || `Máy chủ trả về lỗi ${response.status}.`);
  return data;
}

function Connection({ device, error }) {
  const label = error ? 'Mất kết nối máy chủ' : !device ? 'Đang kiểm tra' : device.online ? 'Trực tuyến' : 'Ngoại tuyến';
  return <span class={`connection ${device?.online && !error ? 'connection--on' : ''}`}><i aria-hidden="true" />{label}</span>;
}

function Nav({ screen, device, deviceError, onLogout, loggingOut }) {
  return (
    <aside class="rail">
      <Brand />
      <nav class="rail-nav" aria-label="Bảng điều khiển">
        {Object.entries(screens).map(([id, label]) => (
          <a key={id} class="nav-item m-link m-link--bare" href={`#${id}`} aria-current={screen === id ? 'page' : undefined}>
            <Icon name={id} /><span>{label}</span>
          </a>
        ))}
      </nav>
      <div class="rail-bottom">
        <div class="rail-device">
          <span class="rail-device-icon"><Icon name="device" /></span>
          <div><strong>{device?.deviceId || 'Đồng hồ NekoMate'}</strong><Connection device={device} error={deviceError} /></div>
        </div>
        <button type="button" class="rail-exit btn" onClick={onLogout} disabled={loggingOut}>
          <Icon name="exit" /><span>{loggingOut ? 'Đang đăng xuất' : 'Đăng xuất'}</span>
        </button>
      </div>
    </aside>
  );
}

function Overview({ device, deviceError, reminders, sources, deskTime }) {
  const alarm = nextAlarm(device?.alarms);
  const alarmTime = formatAlarm(alarm);
  const linked = sources.data?.filter((item) => item.status === 'connected').length;
  const next = reminders.data?.find((item) => item.status === 'pending' || item.status === 'date_only');
  const stats = [
    ['alarm', 'Báo thức kế tiếp', alarmTime || '—',
      deviceError || (device?.syncState === 'pending' ? 'Chờ đồng hồ xác nhận' : alarm?.title || (device ? 'Chưa có báo thức sắp reo' : 'Đang tải…'))],
    ['reminders', 'Lời nhắc trong 7 ngày', reminders.data?.length ?? '—',
      reminders.error || (reminders.data ? next?.title || 'Chưa có lời nhắc đang chờ' : 'Đang tải…')],
    ['sources', 'App kết nối', sources.data ? `${linked}/${sources.data.length}` : '—',
      sources.error || (sources.data ? 'Lịch và danh sách công việc' : 'Đang tải…')],
  ];

  return (
    <>
      <section class="hero overview-hero app-frame" data-enter aria-labelledby="device-title">
        <div class="device-copy">
          <Connection device={device} error={deviceError} />
          <h2 id="device-title">Đồng hồ NekoMate</h2>
          <dl class="device-time"><div><dt>Giờ Việt Nam</dt><dd><time>{deskTime.time}</time></dd></div></dl>
          <p>{deviceError || (!device ? 'Đang kiểm tra kết nối với đồng hồ.' : device.online
            ? 'Sẵn sàng nhận báo thức và lời nhắc.'
            : 'Báo thức đã lưu vẫn reo khi mất kết nối.')}</p>
          <a class="btn btn--primary" href="#alarm"><Icon name="alarm" /> Đặt báo thức</a>
        </div>
        <ClockStage online={device?.online && !deviceError} time={deskTime.time} />
      </section>
      <section class="summary" aria-labelledby="summary-title">
        <h2 id="summary-title">Báo thức, lời nhắc và app kết nối</h2>
        <div class="summary-grid">
          {stats.map(([id, title, value, detail]) => (
            <a key={id} href={`#${id}`} class="summary-card card">
              <span class={`tile-icon tile-icon--${id}`}><Icon name={id} /></span>
              <span class="summary-arrow"><Icon name="arrow" /></span>
              <span class="summary-label">{title}</span><strong>{value}</strong><span class="summary-detail">{detail}</span>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

function useCollection(path, key, api) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const version = useRef(0);

  async function load() {
    const id = ++version.current;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const data = await api(path);
      if (id === version.current) replace(data[key]);
    } catch (err) {
      if (id === version.current) setState((previous) => ({ ...previous, error: err.message, loading: false }));
    }
  }

  function replace(data) {
    version.current += 1;
    setState({ data, error: '', loading: false });
  }

  return { ...state, load, replace };
}

function Dashboard({ api, logout, loggingOut, announce }) {
  const [screen, setScreen] = useState(readScreen);
  const [device, setDevice] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [alarmDraft, setAlarmDraft] = useState(null);
  const deviceVersion = useRef(0);
  const syncedRevision = useRef(null);
  const reminders = useCollection('/reminders', 'reminders', api);
  const sources = useCollection('/sources', 'sources', api);
  const deskTime = useDeskTime();

  useEffect(() => {
    function onNavigate() {
      setScreen(readScreen());
      document.getElementById('main-content').focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', onNavigate);
    return () => window.removeEventListener('hashchange', onNavigate);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let poll;

    async function refreshDevice() {
      const id = deviceVersion.current;
      try {
        const data = await api('/device', { signal: controller.signal });
        if (controller.signal.aborted || id !== deviceVersion.current) return;
        setDevice(data);
        setDeviceError('');
        if (data.syncState === 'synced' && data.pendingAlarm && data.pendingAlarm.configId !== syncedRevision.current) {
          syncedRevision.current = data.pendingAlarm.configId;
          void reminders.load();
        }
      } catch (err) {
        if (!controller.signal.aborted && id === deviceVersion.current) setDeviceError(err.message);
      }
    }

    function updatePolling(refresh = false) {
      clearInterval(poll);
      if (document.visibilityState !== 'visible') return;
      if (refresh) void refreshDevice();
      poll = setInterval(refreshDevice, pollInterval);
    }

    const onVisibility = () => updatePolling(true);
    document.addEventListener('visibilitychange', onVisibility);
    void refreshDevice();
    void reminders.load();
    void sources.load();
    updatePolling();
    return () => {
      controller.abort();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  async function changeAlarm(id, body) {
    deviceVersion.current += 1;
    const path = id ? `/alarms/${encodeURIComponent(id)}` : '/alarms';
    const { device: updated } = await api(path, { method: !id ? 'POST' : body === null ? 'DELETE' : 'PUT', body: body ?? undefined });
    deviceVersion.current += 1;
    setDevice(updated);
    setDeviceError('');
    if (updated.syncState === 'synced') {
      syncedRevision.current = updated.pendingAlarm?.configId ?? null;
      void reminders.load();
    }
    announce(body === null ? 'Đã xóa báo thức.' : 'Đã lưu báo thức.');
  }

  function chooseSourceItem(source, item, existing) {
    setAlarmDraft(existing ? { ...existing, time: formatAlarm(existing), sourceName: source.name } : alarmFromItem(source, item));
    window.location.hash = 'alarm';
  }

  return (
    <div class="shell">
      <Nav screen={screen} device={device} deviceError={deviceError} onLogout={logout} loggingOut={loggingOut} />
      <main id="main-content" class="workspace wrap" tabIndex={-1}>
        <header class="page-head">
          <div><h1>{screens[screen]}</h1>{screen !== 'overview' && <p>{screenDescriptions[screen]}</p>}</div>
          <span class="page-date"><Icon name="reminders" />{deskTime.date}</span>
        </header>
        {screen === 'overview' && <Overview device={device} deviceError={deviceError} reminders={reminders} sources={sources} deskTime={deskTime} />}
        {screen === 'alarm' && <Alarms device={device} deviceError={deviceError} draft={alarmDraft} setDraft={setAlarmDraft}
          change={changeAlarm} api={api} sources={sources} />}
        {screen === 'reminders' && <Reminders reminders={reminders} api={api} announce={announce} />}
        {screen === 'sources' && <Sources sources={sources} reminders={reminders} api={api} announce={announce}
          alarms={device?.alarms ?? []} onChoose={chooseSourceItem} />}
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState('checking');
  const [toast, setToast] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const toastTimer = useRef(null);

  function announce(message, error = false) {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    if (!error) toastTimer.current = setTimeout(() => setToast(null), 4500);
  }

  useEffect(() => {
    void request('/auth/me').then(({ authenticated }) => setSession(authenticated ? 'owner' : 'guest'))
      .catch((err) => { setSession('guest'); announce(err.message, true); });
    return () => clearTimeout(toastTimer.current);
  }, []);

  function api(path, options) {
    return request(path, options, () => {
      setSession('guest');
      announce('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', true);
    });
  }

  async function login(password) {
    await request('/auth/login', { method: 'POST', body: { password } });
    setToast(null);
    setSession('owner');
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await api('/auth/logout', { method: 'POST' });
      setSession('guest');
      announce('Đã đăng xuất.');
    } catch (err) {
      announce(err.message, true);
    } finally {
      setLoggingOut(false);
    }
  }

  return <>
    {session === 'owner' ? <Dashboard api={api} logout={logout} loggingOut={loggingOut} announce={announce} />
      : <Login login={login} checking={session === 'checking'} />}
    <div class="toast" data-error={toast?.error ? 'true' : undefined} role="status">{toast?.message}</div>
  </>;
}

render(<App />, document.getElementById('app'));
