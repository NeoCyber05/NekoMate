import { useEffect, useRef, useState } from 'preact/hooks';

import { Brand, ClockStage, Icon, useDeskTime } from './device-visual.jsx';
import { Modal } from './alarms.jsx';

export function Login({ login, checking }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const { time } = useDeskTime();

  async function submit(event) {
    event.preventDefault();
    if (!password) {
      setError('Hãy nhập mật khẩu quản trị.');
      input.current.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(password);
    } catch (err) {
      setError(err.message);
      input.current.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" class="login-page wrap" tabIndex={-1}>
      <section class="hero login-hero" data-enter aria-labelledby="login-title">
        <div class="login-side">
          <Brand />
          <div class="login-copy">
            <h1 id="login-title">Đăng nhập NekoMate</h1>
            <p>Điều khiển báo thức và lịch nhắc trên đồng hồ.</p>
            <form class="login-form" onSubmit={submit} noValidate>
              <label for="owner-password">Mật khẩu quản trị</label>
              <div class="password-wrap">
                <Icon name="lock" />
                <input id="owner-password" type={visible ? 'text' : 'password'} ref={input} value={password}
                  autoComplete="current-password" required placeholder="Nhập mật khẩu" aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'login-error' : undefined}
                  onInput={(event) => { setPassword(event.currentTarget.value); setError(''); }} />
                <button class="password-toggle" type="button" aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  onClick={() => setVisible(!visible)}><Icon name={visible ? 'eyeOff' : 'eye'} /></button>
              </div>
              {error && <p class="error" id="login-error" role="alert">{error}</p>}
              <button class="btn btn--primary" type="submit" disabled={busy || checking}>
                {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}<Icon name="arrow" />
              </button>
            </form>
          </div>
        </div>
        <ClockStage time={time} large />
      </section>
    </main>
  );
}

const reminderLabels = { pending: 'Chờ nhắc', shown: 'Đã hiện', dismissed: 'Đã chạm tắt', missed: 'Quá hạn', date_only: 'Theo ngày', replaced: 'Đã chuyển thành báo thức' };

function Refresh({ onClick, busy }) {
  return <button type="button" class="btn btn--secondary" onClick={onClick} disabled={busy}>
    <Icon name="refresh" />{busy ? 'Đang tải…' : 'Làm mới'}
  </button>;
}

export function Reminders({ reminders, api, announce }) {
  const [title, setTitle] = useState('Uống nước nào 🐱');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function send(event) {
    event.preventDefault();
    setSending(true);
    setError('');
    try {
      await api('/notifications/test', { method: 'POST', body: { title } });
      announce('Đã đưa lời nhắc vào hàng đợi gửi tới đồng hồ.');
      void reminders.load();
    } catch (err) { setError(err.message); } finally { setSending(false); }
  }

  return <div class="panel-grid reminders-layout">
    <section class="panel quick-panel" aria-labelledby="quick-title">
      <div class="panel-heading"><span class="tile-icon tile-icon--alarm"><Icon name="send" /></span><h2 id="quick-title">Gửi lời nhắc nhanh</h2></div>
      <p>Lời nhắc hiện tối đa 30 giây. Chạm vào mèo để tắt.</p>
      <form onSubmit={send} class="quick-form">
        <div class="field"><label for="message-title">Nội dung lời nhắc</label>
          <input id="message-title" type="text" value={title} maxLength={80} onInput={(event) => setTitle(event.currentTarget.value)} /></div>
        {error && <p class="error" role="alert">{error}</p>}
        <button class="btn btn--primary" type="submit" disabled={sending}><Icon name="send" />{sending ? 'Đang gửi…' : 'Gửi lời nhắc'}</button>
      </form>
    </section>
    <section class="panel reminders-panel" aria-labelledby="reminders-title">
      <div class="panel-heading panel-heading--actions">
        <span class="tile-icon tile-icon--reminders"><Icon name="reminders" /></span>
        <div><h2 id="reminders-title">Lời nhắc sắp tới</h2><p>Trong 7 ngày tới</p></div>
        <Refresh onClick={reminders.load} busy={reminders.loading} />
      </div>
      {reminders.error && <p class="error" role="alert">{reminders.error}</p>}
      {reminders.loading && !reminders.data && <p class="empty">Đang tải lời nhắc…</p>}
      {reminders.data?.length === 0 && !reminders.error && <div class="empty"><Icon name="reminders" /><p>Chưa có lời nhắc nào trong 7 ngày tới.</p></div>}
      {!!reminders.data?.length && <ul class="reminder-list">
        {reminders.data.map((item) => <li key={item.id}>
          <div><strong>{item.title}</strong><p>{[item.source, item.localTime || item.dateOnly].filter(Boolean).join(' · ')}</p></div>
          <span class="status-tag">{reminderLabels[item.status] || item.status}</span>
        </li>)}
      </ul>}
    </section>
  </div>;
}

const sourceStatus = { connected: 'Đã kết nối', error: 'Lỗi đồng bộ', disconnected: 'Chưa liên kết' };
const sourceIcons = { google_calendar: 'google-calendar', google_tasks: 'google-tasks', todoist: 'todoist', ticktick: 'ticktick' };
const dateTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' });

function Source({ source, api, sources, reminders, announce, onBrowse }) {
  const [busy, setBusy] = useState('');
  const [options, setOptions] = useState(null);
  const [selection, setSelection] = useState('');
  const [error, setError] = useState('');
  const path = `/sources/${encodeURIComponent(source.id)}`;

  async function perform(action) {
    setBusy(action);
    setError('');
    try {
      const result = await api(`${path}/${action}`, action === 'options' ? undefined
        : action === 'scope' ? { method: 'PUT', body: { scopeId: selection } } : { method: 'POST' });
      if (action === 'connect') {
        window.location.assign(result.redirectUrl);
      } else if (action === 'options') {
        setOptions(result.options);
        setSelection(result.options.some((option) => option.id === source.scopeId) ? source.scopeId : '');
      } else {
        sources.replace(result.sources);
        void reminders.load();
        announce(action === 'scope' ? `Đã lưu phạm vi cho ${source.name}.` : `Đã đồng bộ ${source.name}.`);
      }
    } catch (err) {
      setError(err.message);
      if (action === 'sync') void sources.load();
    } finally { setBusy(''); }
  }

  const kind = source.kind === 'calendar' ? 'Lịch · nhắc trước 10 phút' : source.timeMode === 'date_only' ? 'Công việc · theo ngày' : 'Công việc';
  const logo = sourceIcons[source.id];
  return <article class="panel source-panel">
    <div class="source-head">
      {logo ? <span class="tile-icon source-logo"><img src={`/assets/source-icons/${logo}.svg`} alt="" width="23" height="23" /></span>
        : <span class="tile-icon tile-icon--sources"><Icon name={source.kind === 'calendar' ? 'reminders' : 'sources'} /></span>}
      <span class={`status-tag ${source.status === 'connected' ? 'status-tag--ok' : source.status === 'error' ? 'status-tag--error' : ''}`}>
        {sourceStatus[source.status] || source.status}
      </span>
    </div>
    <h3>{source.name}</h3>
    <p>{kind} · {source.liveVerified ? 'Đã xác minh' : 'Bản mở rộng'}</p>
    {source.lastSyncAt > 0 && <p>Đồng bộ lúc {dateTime.format(source.lastSyncAt * 1000)}</p>}
    {source.lastError && <p class="error">{source.lastError}</p>}
    {source.requiresScope && source.status !== 'disconnected' && <div class="source-scope field">
      <label for={`scope-${source.id}`}>Danh sách hoặc dự án</label>
      <select id={`scope-${source.id}`} disabled={!options?.length || Boolean(busy)} value={selection}
        onChange={(event) => setSelection(event.currentTarget.value)}>
        <option value="">{options ? options.length ? 'Chọn danh sách' : 'Không có danh sách' : source.scopeLabel || 'Chưa chọn danh sách'}</option>
        {options?.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
      <div class="source-actions">
        <button type="button" class="btn btn--secondary" disabled={Boolean(busy)} onClick={() => perform('options')}>{busy === 'options' ? 'Đang tải…' : 'Tải danh sách'}</button>
        <button type="button" class="btn btn--secondary" disabled={!selection || Boolean(busy)} onClick={() => perform('scope')}>{busy === 'scope' ? 'Đang lưu…' : 'Lưu phạm vi'}</button>
      </div>
    </div>}
    {error && <p class="error" role="alert">{error}</p>}
    <div class="source-actions source-actions--main">
      {source.status !== 'disconnected' && <button type="button" class="btn btn--primary source-browse"
        onClick={() => onBrowse(source)}><Icon name={source.kind === 'calendar' ? 'reminders' : 'tasks'} />
        {source.kind === 'calendar' ? 'Xem sự kiện' : 'Xem công việc'}</button>}
      <button type="button" class="btn btn--secondary" disabled={Boolean(busy)} onClick={() => perform('connect')}>
        {busy === 'connect' ? 'Đang kết nối…' : source.status === 'disconnected' ? 'Kết nối' : 'Kết nối lại'}
      </button>
      {source.status !== 'disconnected' && <button type="button" class="btn btn--secondary" disabled={Boolean(busy)} onClick={() => perform('sync')}>
        {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
      </button>}
    </div>
  </article>;
}

function SourceItems({ source, api, onClose, onChoose, alarms }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api(`/sources/${encodeURIComponent(source.id)}/items`, { signal: controller.signal })
      .then(result => setItems(result.items))
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, []);
  const visible = items?.filter(item => item.title.toLocaleLowerCase('vi').includes(query.trim().toLocaleLowerCase('vi')));
  return <Modal heading={source.name} detail={source.scopeLabel || (source.kind === 'calendar' ? 'Sự kiện đã đồng bộ' : 'Công việc đã đồng bộ')}
    onClose={onClose} wide>
    <div class="source-items-body">
      {items?.length > 0 && <div class="field"><label class="sr-only" for="source-search">Tìm theo tên</label>
        <input id="source-search" type="search" placeholder={source.kind === 'calendar' ? 'Tìm sự kiện…' : 'Tìm công việc…'} value={query}
          onInput={event => setQuery(event.currentTarget.value)} /></div>}
      {error && <p class="error" role="alert">{error}</p>}
      {!items && !error && <p class="empty" role="status">Đang tải dữ liệu…</p>}
      {visible?.length === 0 && <p class="empty">{items.length ? 'Không tìm thấy mục phù hợp.'
        : source.requiresScope && !source.scopeId ? 'Chọn danh sách hoặc dự án trong trang App kết nối.' : 'App này chưa có mục nào được đồng bộ.'}</p>}
      {!!visible?.length && <ul class="source-item-list">{visible.map(item => {
        const existing = alarms.find(alarm => alarm.sourceId === source.id && alarm.itemId === item.id);
        const changed = existing && existing.sourceDue !== item.sourceDue;
        const [date, time] = (item.localTime || item.dateOnly || '').split(' ');
        return <li key={item.id}>
          <span class="tile-icon tile-icon--reminders"><Icon name={source.kind === 'calendar' ? 'reminders' : 'tasks'} /></span>
          <div class="source-item-text"><strong>{item.title}</strong>
            <p>{date ? [time, date.split('-').reverse().join('/')].filter(Boolean).join(' · ') : 'Chưa có ngày giờ'}
              {changed ? ' · Hạn ở nguồn đã đổi' : existing ? ' · Đã đặt báo thức' : ''}</p>
          </div>
          <button type="button" class={`btn ${existing ? 'btn--secondary' : 'btn--source'}`}
            onClick={() => onChoose(source, item, existing)}><Icon name="alarm" />{existing ? 'Sửa báo thức' : 'Đặt báo thức'}</button>
        </li>;
      })}</ul>}
    </div>
  </Modal>;
}

export function Sources({ sources, reminders, api, announce, onChoose, alarms }) {
  const [selected, select] = useState(null);
  return <section class="sources" aria-labelledby="sources-title">
    <div class="sources-toolbar"><h2 id="sources-title">Lịch và danh sách công việc</h2><Refresh onClick={sources.load} busy={sources.loading} /></div>
    {sources.error && <p class="error" role="alert">{sources.error}</p>}
    {sources.loading && !sources.data && <p class="empty">Đang tải danh sách app…</p>}
    {sources.data?.length === 0 && <p class="empty">Chưa có app nào để liên kết.</p>}
    <div class="source-grid">
      {sources.data?.map((source) => <Source key={source.id} source={source} api={api} sources={sources} reminders={reminders} announce={announce} onBrowse={select} />)}
    </div>
    {selected && <SourceItems source={selected} api={api} alarms={alarms} onClose={() => select(null)}
      onChoose={(source, item, existing) => { select(null); onChoose(source, item, existing); }} />}
    {sources.data?.some((source) => sourceIcons[source.id]) && <footer class="source-credit">Tên và biểu trưng thuộc về các nhà cung cấp tương ứng.</footer>}
  </section>;
}
