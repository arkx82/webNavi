import type { Kind } from "./warnings";

/**
 * What the voice says, and from how far: the 안내 설정 sheet. Kept in the
 * car's browser; every change is in force at once.
 */
export interface GuideSettings {
  /** The voice at all. */
  voice: boolean;
  /** Which voice speaks: one of Qwen's, or an id of one the owner made; null is the server's own. */
  voiceName: string | null;
  /** 0..1, the voice's own level (the music is ducked separately). */
  volume: number;
  turns: boolean;
  cameras: boolean;
  /** Where camera warnings start: 1000, 600 or 300 m ahead. */
  cameraFromM: 1000 | 600 | 300;
  sections: boolean;
  bumps: boolean;
  schools: boolean;
  curves: boolean;
  accidents: boolean;
  bikeAccidents: boolean;
  /** A soft chime while over the limit near a camera or inside a section. */
  overspeed: boolean;
  /** km/h over the limit before the chime: 0, 5 or 10. */
  overspeedBy: 0 | 5 | 10;
}

export const DEFAULTS: GuideSettings = {
  voice: true, voiceName: null, volume: 1, turns: true,
  cameras: true, cameraFromM: 600, sections: true, bumps: true, schools: true, curves: true, accidents: true, bikeAccidents: true,
  overspeed: true, overspeedBy: 0,
};

const KEY = "nav-guide";

export function loadGuide(): GuideSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GuideSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGuide(s: GuideSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ }
}

/** Whether a warning of [kind] is wanted at all. */
export function wants(s: GuideSettings, kind: Kind): boolean {
  switch (kind) {
    case "speed": case "signal": case "speed-signal": return s.cameras;
    case "section-start": case "section-end": return s.sections;
    case "bump": return s.bumps;
    case "school": return s.schools;
    case "curve": case "curves": return s.curves;
    case "accident": return s.accidents;
    case "bike-accident": return s.bikeAccidents;
    default: return true;
  }
}

/** What the server offers (GET /api/tts/voices). */
export interface VoiceList {
  current: string;
  system: { name: string; female: boolean; note?: string }[];
  mine: { id: string; name: string }[];
}

type Row =
  | { key: "voiceName"; label: string; kind: "voices" }
  | { key: keyof GuideSettings; label: string; kind: "toggle"; sub?: string }
  | { key: keyof GuideSettings; label: string; kind: "choice"; options: [number, string][] }
  | { key: "volume"; label: string; kind: "slider" };

const ROWS: Row[] = [
  { key: "voice", label: "음성 안내", kind: "toggle" },
  { key: "voiceName", label: "목소리", kind: "voices" },
  { key: "volume", label: "안내 음량", kind: "slider" },
  { key: "turns", label: "회전 안내", kind: "toggle", sub: "300미터 앞, 잠시 후 (고속에서는 1킬로미터·500미터)" },
  { key: "cameras", label: "과속·신호 단속 카메라", kind: "toggle" },
  { key: "cameraFromM", label: "카메라 안내 시작", kind: "choice", options: [[1000, "1km 앞"], [600, "600m 앞"], [300, "300m 앞"]] },
  { key: "sections", label: "구간 단속", kind: "toggle" },
  { key: "schools", label: "어린이 보호구역", kind: "toggle" },
  { key: "bumps", label: "과속 방지턱", kind: "toggle" },
  { key: "curves", label: "급커브", kind: "toggle", sub: "이어지는 굽이는 한 번만" },
  { key: "accidents", label: "사고 다발 지역", kind: "toggle", sub: "한국도로교통공단 지자체별 다발지역" },
  { key: "bikeAccidents", label: "자전거 사고 다발 지역", kind: "toggle" },
  { key: "overspeed", label: "과속 경고음", kind: "toggle", sub: "카메라 앞과 구간 단속 안에서 제한 속도를 넘으면" },
  { key: "overspeedBy", label: "경고음 기준", kind: "choice", options: [[0, "제한 속도"], [5, "+5km/h"], [10, "+10km/h"]] },
];

/** The list of voices is open, and what the server said is in it (kept while the sheet is redrawn). */
let voicesOpen = false;
let voices: VoiceList | null = null;

/** A voice's name for the row: its own, or the made one's, or the server's default. */
function voiceLabel(s: GuideSettings): string {
  if (!s.voiceName) return voices ? `기본 (${voices.current})` : "기본";
  return voices?.mine.find((v) => v.id === s.voiceName)?.name ?? s.voiceName;
}

/**
 * Draws the sheet into [box]; [changed] is called with the new settings
 * after every edit, and [loadVoices] fetches what the server offers when
 * the voice list is first opened.
 */
export function drawGuide(box: HTMLElement, s: GuideSettings, changed: (s: GuideSettings) => void, loadVoices?: () => Promise<VoiceList>, picked?: (voice: string | null) => void) {
  box.replaceChildren();
  const redraw = () => drawGuide(box, s, changed, loadVoices, picked);
  const set = (patch: Partial<GuideSettings>) => {
    Object.assign(s, patch);
    saveGuide(s);
    changed(s);
    redraw();
  };
  for (const row of ROWS) {
    const line = document.createElement("div");
    line.className = "gs-row";
    const words = document.createElement("div");
    words.className = "gs-words";
    words.innerHTML = `<div class="gs-label"></div>${"sub" in row && row.sub ? `<div class="gs-sub"></div>` : ""}`;
    words.querySelector(".gs-label")!.textContent = row.label;
    if ("sub" in row && row.sub) words.querySelector(".gs-sub")!.textContent = row.sub;
    line.append(words);
    // Rows that only mean something with their parent on are dimmed without it.
    const parentOff = (row.key === "cameraFromM" && !s.cameras) || (row.key === "overspeedBy" && !s.overspeed) || (row.key !== "voice" && !s.voice);
    line.classList.toggle("off", parentOff);
    if (row.kind === "voices") {
      // A button that opens the list, the way a car app shows its voices.
      const b = document.createElement("button");
      b.type = "button";
      b.className = "voice-pick";
      b.textContent = `${voiceLabel(s)} ${voicesOpen ? "▴" : "▾"}`;
      b.addEventListener("click", () => {
        voicesOpen = !voicesOpen;
        if (voicesOpen && !voices && loadVoices) {
          void loadVoices().then((v) => { voices = v; redraw(); }).catch(() => { voices = { current: "Cherry", system: [], mine: [] }; redraw(); });
        }
        redraw();
      });
      line.append(b);
      box.append(line);
      if (voicesOpen) box.append(voiceList(s, (name) => { set({ voiceName: name }); picked?.(name); }));
      continue;
    }
    if (row.kind === "toggle") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "switch" + (s[row.key] ? " on" : "");
      b.setAttribute("aria-pressed", String(!!s[row.key]));
      b.addEventListener("click", () => set({ [row.key]: !s[row.key] } as Partial<GuideSettings>));
      line.append(b);
    } else if (row.kind === "choice") {
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [value, label] of row.options) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.classList.toggle("on", s[row.key] === value);
        b.addEventListener("click", () => set({ [row.key]: value } as Partial<GuideSettings>));
        seg.append(b);
      }
      line.classList.add("wide");
      line.append(seg);
    } else {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0.2";
      input.max = "1";
      input.step = "0.1";
      input.value = String(s.volume);
      // Live while sliding; the sheet is not redrawn under the finger.
      input.addEventListener("input", () => { s.volume = Number(input.value); saveGuide(s); changed(s); });
      line.classList.add("wide");
      line.append(input);
    }
    box.append(line);
  }
}

/** The open voice list: the server's default, Qwen's voices, and the owner's own. */
function voiceList(s: GuideSettings, choose: (voice: string | null) => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "voice-list";
  if (!voices) {
    box.innerHTML = `<div class="gs-sub">목소리 목록을 받는 중…</div>`;
    return box;
  }
  const row = (label: string, sub: string, value: string | null) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "voice" + (s.voiceName === value ? " on" : "");
    b.innerHTML = `<span class="v-name"></span><small></small>`;
    b.querySelector(".v-name")!.textContent = label;
    b.querySelector("small")!.textContent = sub;
    b.addEventListener("click", () => choose(value));
    box.append(b);
  };
  const head = (text: string) => {
    const h = document.createElement("div");
    h.className = "v-head";
    h.textContent = text;
    box.append(h);
  };
  row(`기본 (${voices.current})`, "/admin 에서 정한 목소리", null);
  head("내가 만든 목소리");
  if (voices.mine.length === 0) {
    const none = document.createElement("div");
    none.className = "gs-sub";
    none.textContent = "Model Studio 에서 만든 목소리가 여기에 나옵니다";
    box.append(none);
  }
  for (const v of voices.mine) row(v.name, "직접 만든 목소리", v.id);
  head("기본 목소리");
  for (const v of voices.system) row(v.name, [v.female ? "여성" : "남성", v.note].filter(Boolean).join(" · "), v.name);
  return box;
}
