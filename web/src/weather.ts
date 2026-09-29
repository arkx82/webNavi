import type { LonLat } from "./types";

/**
 * The weather button at the top of the map's right edge, and the sheet it
 * opens: now, the next day by the hour, and ten days — 기상청's forecasts
 * through the server (/api/weather). The button's icon follows the sky, a
 * moon at night; its number is the temperature now.
 */
export type Sky = "clear" | "partly" | "cloudy" | "rain" | "sleet" | "snow" | "shower";
interface Hour { t: string; temp?: number; sky: Sky; pop?: number }
interface Day { date: string; min?: number; max?: number; am: Sky; pm: Sky; pop?: number }
interface Weather {
  place: string;
  now: { temp?: number; sky: Sky; rain1h?: number; humidity?: number; windMs?: number } | null;
  hours: Hour[];
  days: Day[];
}

export const SKY_WORDS: Record<Sky, string> = {
  clear: "맑음", partly: "구름 많음", cloudy: "흐림", rain: "비", sleet: "비 또는 눈", snow: "눈", shower: "소나기",
};

const isNight = (hour: number) => hour >= 19 || hour < 6;

/** Soft round icons, drawn here (no emoji font to rely on in the car). */
export function skyIcon(sky: Sky, night: boolean, size = 28): string {
  const sun = `<circle cx="12" cy="12" r="4.6" fill="#ffd166"/><g stroke="#ffd166" stroke-width="2" stroke-linecap="round"><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/></g>`;
  const moon = `<path d="M15.8 4.2a8 8 0 1 0 4 11.5 6.3 6.3 0 0 1-4-11.5z" fill="#ffe8a3"/>`;
  const cloud = (fill: string, dx = 0, dy = 0) => `<path transform="translate(${dx} ${dy})" d="M7.2 19h9.6a4.2 4.2 0 0 0 .5-8.4 5.4 5.4 0 0 0-10.3 1.2A3.6 3.6 0 0 0 7.2 19z" fill="${fill}"/>`;
  const drops = `<g stroke="#7cc4ff" stroke-width="2" stroke-linecap="round"><path d="M9 21.2l-.8 1.6M13 21.2l-.8 1.6M17 21.2l-.8 1.6"/></g>`;
  const flakes = `<g fill="#e8f4ff"><circle cx="9" cy="22" r="1.3"/><circle cx="13" cy="22.6" r="1.3"/><circle cx="17" cy="22" r="1.3"/></g>`;
  let body: string;
  switch (sky) {
    case "clear": body = night ? moon : sun; break;
    case "partly": body = `<g transform="translate(-3 -3) scale(.8)">${night ? moon : sun}</g>${cloud("#eef0ff", 1.5, 1)}`; break;
    case "cloudy": body = `${cloud("#b9bdd6", -2.5, -2.5)}${cloud("#e4e7f5", 1, 0)}`; break;
    case "rain": case "shower": body = `${cloud("#c9cde6", 0, -3)}${drops}`; break;
    case "snow": body = `${cloud("#e4e7f5", 0, -3)}${flakes}`; break;
    case "sleet": body = `${cloud("#d6d9ec", 0, -3)}<g stroke="#7cc4ff" stroke-width="2" stroke-linecap="round"><path d="M9 21.2l-.8 1.6M17 21.2l-.8 1.6"/></g><circle cx="13" cy="22.4" r="1.3" fill="#e8f4ff"/>`; break;
  }
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

const round = (n?: number) => (n == null ? "–" : `${Math.round(n)}°`);
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export class WeatherPanel {
  private last: { at: LonLat; t: number; w: Weather } | null = null;
  private busy = false;

  constructor(private button: HTMLElement, private sheet: HTMLElement, private body: HTMLElement, private log: (text: string) => void) {}

  /** Asks again when the car has gone 10 km or 15 minutes have passed. */
  async refresh(at: LonLat) {
    if (this.busy) return;
    const moved = this.last ? Math.hypot((at[0] - this.last.at[0]) * 88, (at[1] - this.last.at[1]) * 111) : Infinity;
    if (this.last && moved < 10 && Date.now() - this.last.t < 15 * 60_000) return;
    this.busy = true;
    try {
      const a = await fetch(`/api/weather?at=${at[0]},${at[1]}`);
      const j = (await a.json()) as Weather & { error?: string };
      if (!a.ok) throw new Error(j.error ?? `${a.status}`);
      this.last = { at, t: Date.now(), w: j };
      this.drawButton();
      if (!this.sheet.hidden) this.draw();
    } catch (e) {
      this.log(`날씨 실패 ${(e as Error).message}`);
      this.button.hidden = !this.last;
    } finally {
      this.busy = false;
    }
  }

  private drawButton() {
    const w = this.last?.w;
    if (!w) return;
    this.button.hidden = false;
    const sky = w.now?.sky ?? w.hours[0]?.sky ?? "clear";
    this.button.innerHTML = `${skyIcon(sky, isNight(new Date().getHours()), 30)}<small>${round(w.now?.temp ?? w.hours[0]?.temp)}</small>`;
    this.button.title = `${SKY_WORDS[sky]} · ${w.place}`;
  }

  /** The sheet: now, the hours, the days. */
  draw() {
    const w = this.last?.w;
    if (!w) { this.body.innerHTML = `<div class="hint">날씨를 받는 중…</div>`; return; }
    const sky = w.now?.sky ?? w.hours[0]?.sky ?? "clear";
    const night = isNight(new Date().getHours());
    const facts = [
      w.now?.humidity != null ? `습도 ${w.now.humidity}%` : null,
      w.now?.windMs != null ? `바람 ${w.now.windMs}m/s` : null,
      w.now?.rain1h ? `1시간 ${w.now.rain1h}mm` : null,
      w.hours[0]?.pop != null ? `강수확률 ${w.hours[0].pop}%` : null,
    ].filter(Boolean);
    const hours = w.hours.map((h) => {
      const hour = Number(h.t.slice(11, 13));
      return `<div class="wx-hour"><small>${hour === 0 ? "내일" : `${hour}시`}</small>${skyIcon(h.sky, isNight(hour), 28)}<b>${round(h.temp)}</b>${h.pop != null && h.pop >= 30 ? `<i class="wx-pop">${h.pop}%</i>` : `<i class="wx-pop none">·</i>`}</div>`;
    }).join("");
    const lo = Math.min(...w.days.map((d) => d.min ?? 99)), hi = Math.max(...w.days.map((d) => d.max ?? -99));
    const today = new Date().toISOString().slice(0, 10);
    const days = w.days.map((d, i) => {
      const date = new Date(`${d.date}T12:00:00+09:00`);
      const name = d.date === today || i === 0 ? "오늘" : i === 1 ? "내일" : `${DAYS[date.getDay()]} ${date.getDate()}일`;
      const span = hi - lo || 1;
      const left = (((d.min ?? lo) - lo) / span) * 100, width = Math.max(6, (((d.max ?? hi) - (d.min ?? lo)) / span) * 100);
      return `<div class="wx-day"><span class="wx-name">${name}</span><span class="wx-ampm">${skyIcon(d.am, false, 22)}${skyIcon(d.pm, false, 22)}</span><span class="wx-pct">${d.pop != null && d.pop >= 30 ? `${d.pop}%` : ""}</span><span class="wx-t">${round(d.min)}</span><span class="wx-bar"><i style="left:${left}%;width:${width}%"></i></span><span class="wx-t">${round(d.max)}</span></div>`;
    }).join("");
    this.body.innerHTML =
      `<div class="wx-now">${skyIcon(sky, night, 72)}<div><div class="wx-temp">${round(w.now?.temp ?? w.hours[0]?.temp)}</div><div class="wx-word">${SKY_WORDS[sky]}</div></div></div>` +
      `<div class="wx-facts">${facts.map((f) => `<span>${f}</span>`).join("")}</div>` +
      `<div class="wx-hours">${hours}</div>` +
      `<div class="wx-days">${days}</div>` +
      `<div class="wx-src">${w.place} 기준 · 자료: 기상청 단기예보·중기예보 (공공데이터포털)</div>`;
  }
}
