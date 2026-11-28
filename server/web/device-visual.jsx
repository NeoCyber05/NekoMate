import { useEffect, useRef, useState } from 'preact/hooks';

import mountSpotlight from '/assets/moments/cursor-spotlight/moment.js';
import { coarse, reduced } from '/assets/moments/lib.js';

const icons = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  alarm: 'M5 3 2 6m17-3 3 3M7 19l-2 2m12-2 2 2M12 8v5l3 2m5-2a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  reminders: 'M4 10h16M8 3v4m8-4v4M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 9h3m-3 3h6',
  sources: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2m2 6a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  exit: 'M10 17l5-5-5-5m5 5H3m11-8h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5',
  refresh: 'M20 4v5h-5m5-.5A8 8 0 0 0 6 6m-2 14v-5h5m-5 .5A8 8 0 0 0 18 18',
  send: 'm22 2-7 20-4-9-9-4 20-7zm0 0L11 13',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  eyeOff: 'm3 3 18 18M10.5 6.1A12 12 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3 3.5m-3 1.9c-1.2.4-2.5.6-4 .6-6.5 0-10-6-10-6a15 15 0 0 1 4-4',
  device: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 22h8m-4-4v4',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zm7 5v2',
};

export function Icon({ name }) {
  return <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={icons[name]} /></svg>;
}

export function Brand() {
  return <div class="brand"><img src="/nekomate.svg" alt="" width="38" height="38" /> NekoMate</div>;
}

export function formatAlarm(alarm) {
  if (!Number.isInteger(alarm?.hour) || !Number.isInteger(alarm?.minute)) return '';
  return `${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}`;
}

export function daysLabel(days = []) {
  return days.map((day) => day === 7 ? 'CN' : `T${day + 1}`).join(' · ') || 'Không lặp';
}

const clockFormat = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dateFormat = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: 'numeric', month: 'long',
});

export function useDeskTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5000);
    return () => clearInterval(timer);
  }, []);
  const date = dateFormat.format(now);
  return { time: clockFormat.format(now), date: date[0].toLocaleUpperCase('vi-VN') + date.slice(1) };
}

function CatFace({ online, time }) {
  return (
    <svg class="cat-face" viewBox="0 0 240 240" shape-rendering="crispEdges" aria-hidden="true">
      <path class="cat-ear" d="M48 8h12v8h6v8h6v8h6v8h6v8h6v8H18v-8h6v-8h6v-8h6v-8h6v-8h6zM180 8h12v8h6v8h6v8h6v8h6v8h6v8h-72v-8h6v-8h6v-8h6v-8h6v-8h6z" />
      <path class="cat-ear-inner" d="M48 24h12v8h6v8h6v8H36v-8h6v-8h6zM180 24h12v8h6v8h6v8h-36v-8h6v-8h6z" />
      {online ? <>
        <path class="cat-eye" d="M55 90h30v10h10v20H85v10H55v-10H45v-20h10zM155 90h30v10h10v20h-10v10h-30v-10h-10v-20h10z" />
        <path class="cat-spark" d="M55 100h10v10H55zM155 100h10v10h-10z" />
      </> : <>
        <path class="cat-eye" d="M45 110h10v10h30v-10h10v10H85v10H55v-10H45zM145 110h10v10h30v-10h10v10h-10v10h-30v-10h-10z" />
        <path class="cat-spark" d="M195 86h12v3l-7 7h7v3h-12v-3l7-7h-7zM210 66h16v4l-10 10h10v4h-16v-4l10-10h-10z" />
      </>}
      <path class="cat-ear-inner" d="M108 140h24v6h-6v6h-4v4h-4v-4h-4v-6h-6z" />
      <path class="cat-spark" d="M105 158h6v6h-6zm6 6h6v6h-6zm6-6h6v6h-6zm6 6h6v6h-6zm6-6h6v6h-6z" />
      <path class="cat-whisker" d="M22 148h30v5H22zm6 14h24v5H28zm160-14h30v5h-30zm0 14h24v5h-24z" />
      <text x="120" y="221" class="cat-clock">{time}</text>
    </svg>
  );
}

export function ClockStage({ online = false, time, large = false }) {
  const stage = useRef(null);
  useEffect(() => {
    const moment = mountSpotlight(stage.current, { rest: [0.63, 0.28], radius: 470, grid: false }, { coarse, reduced });
    return () => moment.destroy();
  }, []);

  return (
    <div class={`clock-stage${large ? ' clock-stage--large' : ''}`} ref={stage}
      data-enter-media data-visual data-moment="cursor-spotlight" aria-hidden="true">
      <div class="clock-model">
        <span class="clock-top" />
        <div class="clock-body">
          <div class="clock-glass"><CatFace online={online} time={time} /></div>
          <div class="clock-trim"><span>NEKOMATE</span><i class={online ? 'clock-led on' : 'clock-led'} /></div>
        </div>
        <div class="clock-foot" />
      </div>
    </div>
  );
}
