import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, daysLabel, formatAlarm } from './device-visual.jsx';

const weekdays = ['Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy', 'Chủ nhật'];
const dayMs = 86_400_000;
const vietnamMs = 25_200_000;

function localNow() {
  return new Date(Date.now() + vietnamMs).toISOString().slice(0, 16).replace('T', ' ');
}

export function nextAlarm(entries = []) {
  const now = Date.now() + vietnamMs;
  const midnight = Math.floor(now / dayMs) * dayMs;
  let next = null;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const offset = (entry.hour * 60 + entry.minute) * 60_000;
    for (let i = 0; i <= 7; i += 1) {
      const day = new Date(midnight + i * dayMs);
      const matches = entry.date ? entry.date === day.toISOString().slice(0, 10) : entry.days.includes(day.getUTCDay() || 7);
      const deadline = day.getTime() + offset;
      if (matches && deadline >= now && (!next || deadline < next.deadline)) {
        next = { ...entry, deadline, day: i, resolvedDate: day.toISOString().slice(0, 10) };
        break;
      }
    }
    // One-time entries can also fall outside the recurring week being scanned.
    if (entry.date) {
      const deadline = Date.parse(`${entry.date}T00:00:00Z`) + offset;
      if (deadline >= now && (!next || deadline < next.deadline)) {
        next = { ...entry, deadline, day: Math.floor(deadline / dayMs) - Math.floor(now / dayMs), resolvedDate: entry.date };
      }
    }
  }
  return next;
}

function dateLabel(date) {
  return date.split('-').reverse().join('/');
}

export function Modal({ heading, detail, onClose, children, wide = false }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} class={`app-dialog ${wide ? 'app-dialog--wide' : ''}`} aria-labelledby="dialog-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div class="dialog-head">
      <div><h2 id="dialog-title">{heading}</h2>{detail && <p>{detail}</p>}</div>
      <button class="btn btn--secondary icon-button" type="button" onClick={onClose} aria-label="Đóng"><Icon name="close" /></button>
    </div>
    {children}
  </dialog>;
}

export function alarmFromItem(source, item) {
  const [date, time] = (item.localTime ?? item.dateOnly ?? '').split(' ');
  const now = localNow();
  return {
    title: item.title.slice(0, 80), date: date >= now.slice(0, 10) ? date : now.slice(0, 10),
    time: time && item.localTime > now ? time : '', enabled: true, days: [],
    sourceId: source.id, sourceName: source.name, itemId: item.id, sourceDue: item.sourceDue,
    reminderTime: item.reminderTime, replacesReminder: Boolean(item.reminderTime),
  };
}

function AlarmEditor({ initial, close, change, api }) {
  const [draft, setDraft] = useState(initial);
  const [once, setOnce] = useState(Boolean(initial.date));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [sourceUpdate, setSourceUpdate] = useState(null);
  const [reminderTime, setReminderTime] = useState(initial.reminderTime ?? Boolean(initial.sourceNotifyAt));
  const update = values => setDraft(current => ({ ...current, ...values }));

  useEffect(() => {
    if (!initial.id || !initial.sourceId) return;
    const controller = new AbortController();
    api(`/sources/${encodeURIComponent(initial.sourceId)}/items`, { signal: controller.signal }).then(({ items }) => {
      const item = items.find(item => item.id === initial.itemId);
      if (item && item.sourceDue !== initial.sourceDue) setSourceUpdate(item);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  async function commit(remove = false) {
    setBusy(true);
    setError('');
    try {
      const [hour, minute] = draft.time.split(':').map(Number);
      if (!remove && !once && draft.enabled && !draft.days.length) throw new Error('Chọn ít nhất một ngày lặp.');
      await change(draft.id, remove ? null : { ...draft, hour, minute, date: once ? draft.date : null });
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal heading={draft.id ? 'Sửa báo thức' : 'Đặt báo thức'}
    detail={draft.sourceName ? `Từ ${draft.sourceName}` : 'Giờ reo trên đồng hồ · Giờ Việt Nam'}
    onClose={() => { if (!busy) close(); }}>
    <form class="schedule-form" onSubmit={event => { event.preventDefault(); void commit(); }}>
      {sourceUpdate && <div class="source-update">
        <div><strong>Giờ ở nguồn đã thay đổi</strong><p>{sourceUpdate.localTime || sourceUpdate.dateOnly || 'Nguồn đã bỏ hạn'}</p></div>
        <button type="button" class="btn btn--secondary" onClick={() => {
          const replacement = alarmFromItem({ id: initial.sourceId }, sourceUpdate);
          update({ date: replacement.date, time: replacement.time, updateSource: true,
            replacesReminder: Boolean(replacement.reminderTime) && draft.replacesReminder });
          setReminderTime(replacement.reminderTime);
          setOnce(true);
          setSourceUpdate(null);
        }}>Dùng mốc mới</button>
      </div>}
      <div class="field"><label for="alarm-title">Tên báo thức</label>
        <input id="alarm-title" value={draft.title} required maxLength={80} placeholder="Ví dụ: Họp nhóm đồ án"
          onInput={event => update({ title: event.currentTarget.value })} />
      </div>
      <fieldset class="schedule-mode"><legend>Lịch reo</legend>
        <label><input type="radio" name="schedule" checked={once} onChange={() => {
          setOnce(true);
          if (!draft.date) update({ date: localNow().slice(0, 10) });
        }} /><span>Một lần</span></label>
        <label><input type="radio" name="schedule" checked={!once} onChange={() => setOnce(false)} /><span>Lặp theo tuần</span></label>
      </fieldset>
      <div class="schedule-fields">
        <div class="field"><label for="alarm-time">Giờ reo</label>
          <input id="alarm-time" type="time" value={draft.time} required onInput={event => update({ time: event.currentTarget.value })} />
        </div>
        {once && <div class="field"><label for="alarm-date">Ngày reo</label>
          <input id="alarm-date" type="date" value={draft.date ?? ''} required onInput={event => update({ date: event.currentTarget.value })} />
        </div>}
      </div>
      {!once && <fieldset><legend>Ngày lặp</legend>
        <div class="day-grid">{weekdays.map((label, index) => <label class="day-choice" key={label}>
          <input type="checkbox" checked={draft.days.includes(index + 1)} aria-label={label}
            onChange={event => update({ days: event.currentTarget.checked ? [...draft.days, index + 1] : draft.days.filter(day => day !== index + 1) })} />
          <span aria-hidden="true">{index === 6 ? 'CN' : `T${index + 2}`}</span>
        </label>)}</div>
      </fieldset>}
      {once && reminderTime && <label class="replace-reminder">
        <input type="checkbox" checked={draft.replacesReminder} onChange={event => update({ replacesReminder: event.currentTarget.checked })} />
        <span>Thay lời nhắc tự động của mục này
          <small>Áp dụng khi đồng hồ xác nhận đã lưu báo thức.</small>
        </span>
      </label>}
      {error && <p class="error" role="alert">{error}</p>}
      {deleteConfirm && <p class="error" role="status">Xóa báo thức này khỏi lịch trên đồng hồ?</p>}
      <div class="dialog-actions">
        {draft.id && <button type="button" class="btn btn--quiet-danger" disabled={busy}
          onClick={() => deleteConfirm ? void commit(true) : setDeleteConfirm(true)}>{deleteConfirm ? 'Xác nhận xóa' : 'Xóa báo thức'}</button>}
        <button type="button" class="btn btn--secondary" onClick={close} disabled={busy}>Hủy</button>
        <button type="submit" class="btn btn--primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu báo thức'}</button>
      </div>
    </form>
  </Modal>;
}

export function Alarms({ device, deviceError, draft, setDraft, change, api, sources }) {
  const [error, setError] = useState('');
  const [toggling, setToggling] = useState(false);
  const entries = [...(device?.alarms ?? [])].sort((a, b) => formatAlarm(a).localeCompare(formatAlarm(b)));
  const next = nextAlarm(entries);
  const sync = device?.syncState === 'synced' ? 'Đã lưu trên đồng hồ'
    : device?.syncState === 'pending' ? 'Chờ đồng hồ xác nhận' : 'Chưa có lịch trên đồng hồ';
  const sourceNames = new Map((sources.data ?? []).map(source => [source.id, source.name]));
  const today = localNow();

  async function toggle(entry) {
    setToggling(true);
    setError('');
    try {
      await change(entry.id, { ...entry, enabled: !entry.enabled });
    } catch (err) {
      setError(err.message);
    } finally {
      setToggling(false);
    }
  }

  return <div class="schedule-page" data-enter>
    <section class="panel schedule-feature" aria-labelledby="next-alarm-title">
      <span class="tile-icon tile-icon--alarm"><Icon name="alarm" /></span>
      <div class="schedule-next"><h2 id="next-alarm-title">Báo thức kế tiếp</h2>
        <strong>{next ? formatAlarm(next) : '—:—'}</strong>
      </div>
      <div class="schedule-next-info"><b>{next?.title ?? 'Chưa có báo thức sắp reo'}</b>
        <p>{next ? next.day === 0 ? 'Hôm nay' : next.day === 1 ? 'Ngày mai' : dateLabel(next.resolvedDate) : 'Chọn một giờ reo hoặc đặt từ công việc đã đồng bộ.'}</p>
      </div>
      {device && <div class="schedule-sync"><span class={`status-tag ${device.syncState === 'synced' ? 'status-tag--ok' : ''}`}>
        <Icon name="device" />{sync}</span>
        {device.syncState === 'pending' && <small>{device.online ? 'Kiểm tra firmware nếu trạng thái chờ kéo dài.' : 'Đồng hồ đang ngoại tuyến.'}</small>}
      </div>}
    </section>
    <section class="panel schedule-list" aria-labelledby="alarm-list-heading">
      <div class="schedule-list-head"><div><h2 id="alarm-list-heading">Lịch báo thức</h2>
        <p>{device ? `${entries.length}/12 báo thức · Giờ Việt Nam` : 'Đang tải lịch đồng hồ'}</p></div>
        <button type="button" class="btn btn--primary" disabled={!device || entries.length >= 12} onClick={() =>
          setDraft({ title: '', date: null, time: '07:00', days: [1, 2, 3, 4, 5], enabled: true })}><Icon name="plus" />Thêm báo thức</button>
      </div>
      {(error || deviceError) && <p class="error" role="alert">{error || deviceError}</p>}
      {device && !entries.length && <div class="empty">
        <Icon name="reminders" /><p>Chưa có mốc nào được đặt.</p><a class="btn btn--secondary" href="#sources">Chọn việc từ app đã kết nối <Icon name="arrow" /></a>
      </div>}
      {!!entries.length && <ul class="schedule-rows">{entries.map(entry => {
        const time = formatAlarm(entry);
        const passed = entry.date && `${entry.date} ${time}` < today;
        const sourceName = sourceNames.get(entry.sourceId);
        return <li class="schedule-row" key={entry.id}>
          <time>{time}</time>
          <button type="button" class="schedule-row-name" onClick={() => setDraft({ ...entry, time, sourceName })}>
            <strong>{entry.title}</strong><span>{entry.date ? dateLabel(entry.date) : daysLabel(entry.days)}{sourceName ? ` · ${sourceName}` : ''}</span>
          </button>
          <span class="schedule-row-status">{passed ? 'Đã qua' : entry.enabled ? 'Đang bật' : 'Đang tắt'}</span>
          <label class="switch-row schedule-switch">
            <input type="checkbox" role="switch" aria-label={`Bật báo thức ${entry.title}`}
              checked={entry.enabled && !passed} disabled={toggling || Boolean(passed)} onChange={() => void toggle(entry)} />
            <span class="switch-track" aria-hidden="true" />
          </label>
        </li>;
      })}</ul>}
    </section>
    {draft && <AlarmEditor key={draft.id ?? draft.itemId ?? 'new'} initial={draft} close={() => setDraft(null)} change={change} api={api} />}
  </div>;
}
