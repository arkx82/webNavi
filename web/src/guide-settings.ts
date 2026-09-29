import type { Kind } from "./warnings";

/**
 * What the voice says, and from how far: the 안내 설정 sheet. Kept in the
 * car's browser; every change is in force at once.
 */
export interface GuideSettings {
  /** The voice at all. */
  voice: boolean;
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
  voice: true, volume: 1, turns: true,
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

type Row =
  | { key: keyof GuideSettings; label: string; kind: "toggle"; sub?: string }
  | { key: keyof GuideSettings; label: string; kind: "choice"; options: [number, string][] }
  | { key: "volume"; label: string; kind: "slider" };

const ROWS: Row[] = [
  { key: "voice", label: "음성 안내", kind: "toggle" },
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

/** Draws the sheet into [box]; [changed] is called with the new settings after every edit. */
export function drawGuide(box: HTMLElement, s: GuideSettings, changed: (s: GuideSettings) => void) {
  box.replaceChildren();
  const set = (patch: Partial<GuideSettings>) => {
    Object.assign(s, patch);
    saveGuide(s);
    changed(s);
    drawGuide(box, s, changed);
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
