import type { Kind } from "./warnings";
import { push } from "./userdata";

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
  /** On a motorway: the junction's name and way ("신갈JC에서 원주 방면") in the far turn sentences. */
  junctionNames: boolean;
  /** On a motorway, a kilometre before an exit or branch: which side to move to. */
  laneHints: boolean;
  /** 합류 구간: on the ramp after an entrance or a junction. */
  merges: boolean;
  /** 분기점 확대: the camera closes on a tricky junction (closeup.ts). */
  closeups: boolean;
  /** 정밀도로지도's lane lines and road markings on the map, close in (hdmap-layer.ts). */
  hdLanes: boolean;
  /** The lanes at the junction ahead, the ones to be in lit (lanes-strip.ts). */
  laneGuide: boolean;
  /** "분홍색 유도선을 따라가세요": 한국도로공사's painted guide lines at motorway junctions. */
  colorLines: boolean;
  /** The 진단 log sent to the server, to be read after a drive (users.ts keeps it under WORK_DIR). */
  sendLogs: boolean;
  /** 화면 배치: the full panel, or a narrow one with only what a glance needs. */
  layout: "classic" | "mini";
  /** 낮/밤: by the sun where the car is, or always light, or always dark (theme.ts). */
  theme: "auto" | "light" | "dark";
  /** 야경: by night in the 3D view, the buildings lit (night-city.ts). */
  nightCity: boolean;
  /** Traffic lights on the map: only those on the route ahead while driving, every one, or none. */
  lightsOnMap: "route" | "all" | "off";
  /** The cameras on the map, the same way. */
  camerasOnMap: "route" | "all" | "off";
  /** "다음 신호등 250 m" on the drive panel. */
  nextLight: boolean;
  /** "잠시 후 점멸 신호 교차로입니다" at a light switched to flashing for the night. */
  flashSignals: boolean;
  cameras: boolean;
  /** Where camera warnings start: 1000, 600 or 300 m ahead. */
  cameraFromM: 1000 | 600 | 300;
  sections: boolean;
  schools: boolean;
  /** The road's lesser things: a card at the top right by default, not a sentence (the voice is kept for what cannot wait). */
  bumps: Mode;
  curves: Mode;
  accidents: Mode;
  bikeAccidents: Mode;
  /** A soft chime while over the limit near a camera or inside a section. */
  overspeed: boolean;
  /** km/h over the limit before the chime: 0, 5 or 10. */
  overspeedBy: 0 | 5 | 10;
  /**
   * The kinds that can be only shown — a card at the map's top right, or
   * the limit sign — so the voice need not say everything the road has.
   */
  schoolZones: Mode;
  /** 노인·장애인 보호구역: shown as a band on the road by default. */
  seniorZones: Mode;
  /** ITS: a crash ahead, and roadworks or anything else. */
  incidents: Mode;
  roadworks: Mode;
  restAreas: Mode;
  weatherAlerts: Mode;
}

/** Said and shown, shown only, or neither. */
export type Mode = "voice" | "show" | "off";

export const DEFAULTS: GuideSettings = {
  voice: true, voiceName: null, volume: 1, turns: true, junctionNames: true, laneHints: true, merges: true, closeups: true, sendLogs: true, layout: "classic", hdLanes: true, laneGuide: true, colorLines: true, theme: "auto", nightCity: true, lightsOnMap: "route", camerasOnMap: "route", nextLight: true, flashSignals: true,
  cameras: true, cameraFromM: 600, sections: true, schools: true,
  bumps: "show", curves: "show", accidents: "show", bikeAccidents: "show",
  overspeed: true, overspeedBy: 0,
  schoolZones: "voice", seniorZones: "show", incidents: "voice", roadworks: "show", restAreas: "show", weatherAlerts: "voice",
};

const KEY = "nav-guide";

export function loadGuide(): GuideSettings {
  try {
    return migrate({ ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GuideSettings>) });
  } catch {
    return { ...DEFAULTS };
  }
}

/** Kinds that were a switch and are now a mode: on becomes the new default, off stays off. */
const WERE_SWITCHES = ["bumps", "curves", "accidents", "bikeAccidents"] as const;
export function migrate(s: GuideSettings): GuideSettings {
  for (const k of WERE_SWITCHES) {
    const v = s[k] as unknown;
    if (typeof v === "boolean") s[k] = v ? DEFAULTS[k] : "off";
  }
  const lights = s.lightsOnMap as unknown;
  if (typeof lights === "boolean") s.lightsOnMap = lights ? "route" : "off";
  return s;
}

export function saveGuide(s: GuideSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ }
  push("guide", s);
}

/** The mode of a kind that has one; the rest are said or not by their switch. */
export function modeOf(s: GuideSettings, kind: Kind): Mode | null {
  switch (kind) {
    case "school-zone": return s.schoolZones;
    case "senior-zone": return s.seniorZones;
    case "incident-crash": return s.incidents;
    case "incident-work": case "incident-other": return s.roadworks;
    case "rest-area": return s.restAreas;
    case "bump": return s.bumps;
    case "curve": case "curves": return s.curves;
    case "accident": return s.accidents;
    case "bike-accident": return s.bikeAccidents;
    default: return null;
  }
}

/** Whether [kind] is shown on the screen. */
export function shows(s: GuideSettings, kind: Kind): boolean {
  const mode = modeOf(s, kind);
  return mode == null ? wants(s, kind) : mode !== "off";
}

/** Whether a warning of [kind] is said aloud. */
export function wants(s: GuideSettings, kind: Kind): boolean {
  const mode = modeOf(s, kind);
  if (mode != null) return mode === "voice";
  switch (kind) {
    case "speed": case "signal": case "speed-signal": return s.cameras;
    case "section-start": case "section-end": return s.sections;
    case "school": return s.schools;
    case "merge": return s.merges;
    case "signal-light": return s.flashSignals;
    default: return true;
  }
}

/** What the server offers (GET /api/tts/voices). */
export interface VoiceList {
  current: string;
  system: { name: string; female: boolean; note?: string }[];
  mine: { id: string; name: string }[];
  /** The cloning model's free allowance is gone: made voices come out in the default one for now. */
  mineSpent?: boolean;
}

type Row =
  | { key: "voiceName"; label: string; kind: "voices" }
  | { key: keyof GuideSettings; label: string; kind: "toggle"; sub?: string }
  | { key: keyof GuideSettings; label: string; kind: "choice"; options: [number | string, string][]; sub?: string }
  | { key: "volume"; label: string; kind: "slider" };

const MODES: [string, string][] = [["voice", "음성"], ["show", "표시만"], ["off", "끔"]];

const ROWS: Row[] = [
  { key: "voice", label: "음성 안내", kind: "toggle" },
  { key: "voiceName", label: "목소리", kind: "voices" },
  { key: "volume", label: "안내 음량", kind: "slider" },
  { key: "turns", label: "회전 안내", kind: "toggle", sub: "300미터 앞, 잠시 후 (고속에서는 1킬로미터·500미터)" },
  { key: "junctionNames", label: "IC · JC 이름", kind: "toggle", sub: "고속도로에서 \"1킬로미터 앞 신갈JC에서 원주 방면\" (이름마다 처음 한 번 음성 합성)" },
  { key: "laneHints", label: "차로 미리 이동", kind: "toggle", sub: "고속도로 출구 · 분기 1km 앞, 나갈 쪽 차로로 (차로 정보가 아닌 방향 기준)" },
  { key: "merges", label: "합류 구간", kind: "toggle", sub: "고속도로 입구 · 분기 뒤 램프에서" },
  { key: "closeups", label: "분기점 확대", kind: "toggle", sub: "IC · JC · 출구 500m 앞(시내 250m)에서 지도가 기울어 분기점까지 보이게" },
  { key: "cameras", label: "과속·신호 단속 카메라", kind: "toggle" },
  { key: "camerasOnMap", label: "지도에 카메라", kind: "choice", options: [["route", "경로만"], ["all", "모두"], ["off", "끔"]], sub: "경로만: 안내 중 가는 길 앞 3km 안의 것만 (제한 속도 표지판)" },
  { key: "flashSignals", label: "점멸 신호 경고", kind: "toggle", sub: "밤에 점멸로 바뀌는 교차로 앞에서 (전국신호등표준데이터 — 서울은 동작구만)" },
  { key: "colorLines", label: "색깔 유도선", kind: "toggle", sub: "고속도로 분기점 · 나들목에서 \"분홍색 유도선을 따라가세요\" 와 갈림길 그림 (한국도로공사)" },
  { key: "laneGuide", label: "차로 안내", kind: "toggle", sub: "회전 800m 앞(고속도로 2km)부터 지날 때까지, 그리고 직진 중 앞 차로가 좌·우회전 전용이 되는 곳에서 탈 차로를 아래쪽에 (정밀도로지도가 있는 곳)" },
  { key: "hdLanes", label: "정밀 차선 그리기", kind: "toggle", sub: "정밀도로지도가 있는 곳에서 크게 확대하면 실제 차선 · 화살표 · 횡단보도 (느린 차량이면 끄세요)" },
  { key: "layout", label: "화면 배치", kind: "choice", options: [["classic", "기본"], ["mini", "미니"]], sub: "미니: 왼쪽 창을 좁게, 시계 · 다음 신호등 · 그다음 안내는 숨김" },
  { key: "sendLogs", label: "진단 기록 보내기", kind: "toggle", sub: "주행 중 진단 기록(음성, 재탐색, 차로 판정 …)을 서버에 남겨 문제를 나중에 확인" },
  { key: "theme", label: "화면 테마", kind: "choice", options: [["auto", "자동 (해 기준)"], ["light", "밝게"], ["dark", "어둡게"]], sub: "밤에는 바탕 지도도 어둡게" },
  { key: "nightCity", label: "야경 건물", kind: "toggle", sub: "밤에 3D 화면이면 건물에 불이 켜진 듯 (OpenStreetMap 건물이라 도심 밖에는 드묾. 느린 차량이면 끄세요)" },
  { key: "nextLight", label: "다음 신호등 거리", kind: "toggle", sub: "안내 중 왼쪽 패널에 \"다음 신호등 250 m · 약 15초\"" },
  { key: "lightsOnMap", label: "지도에 신호등", kind: "choice", options: [["route", "경로만"], ["all", "모두"], ["off", "끔"]], sub: "경로만: 안내 중 가는 길 앞 3km 안의 것만. 점멸 중이면 노란색" },
  { key: "cameraFromM", label: "카메라 안내 시작", kind: "choice", options: [[1000, "1km 앞"], [600, "600m 앞"], [300, "300m 앞"]] },
  { key: "sections", label: "구간 단속", kind: "toggle" },
  { key: "schools", label: "어린이 보호구역 카메라", kind: "toggle" },
  { key: "schoolZones", label: "어린이 보호구역", kind: "choice", options: MODES, sub: "들어서기 전에 알리고, 안에서는 제한 속도 30 표시" },
  { key: "seniorZones", label: "노인 · 장애인 보호구역", kind: "choice", options: MODES, sub: "경로 위 구간을 주황색으로 (전국노인장애인보호구역표준데이터 활용신청 필요)" },
  { key: "bumps", label: "과속 방지턱", kind: "choice", options: MODES, sub: "표시만: 오른쪽 위 팝업, 누르면 닫히고 지나가면 사라짐" },
  { key: "curves", label: "급커브", kind: "choice", options: MODES, sub: "이어지는 굽이는 한 번만" },
  { key: "accidents", label: "사고 다발 지역", kind: "choice", options: MODES, sub: "한국도로교통공단 지자체별 다발지역" },
  { key: "bikeAccidents", label: "자전거 사고 다발 지역", kind: "choice", options: MODES },
  { key: "incidents", label: "교통사고 (돌발상황)", kind: "choice", options: MODES, sub: "ITS 국가교통정보센터, 경로 앞 1km·300m" },
  { key: "roadworks", label: "공사 · 기타 돌발", kind: "choice", options: MODES, sub: "차로 통제, 고장 차량, 낙하물" },
  { key: "restAreas", label: "고속도로 휴게소", kind: "choice", options: MODES, sub: "다음 휴게소의 기름값과 편의시설을 오른쪽 위에" },
  { key: "weatherAlerts", label: "기상특보", kind: "choice", options: MODES, sub: "호우 · 대설 · 태풍 · 강풍 · 한파 · 폭염 · 황사" },
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
    const parentOff = (row.key === "cameraFromM" && !s.cameras) || (row.key === "overspeedBy" && !s.overspeed) || (row.key !== "voice" && !s.voice && !(row.kind === "choice" && row.options === MODES));
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
  if (voices.mine.length && voices.mineSpent) {
    const note = document.createElement("div");
    note.className = "gs-sub warn";
    note.textContent = "음성 복제 모델의 무료 한도가 소진되어, 지금은 기본 목소리로 나옵니다 (Model Studio 에서 '무료 한도만 사용'을 끄면 다시 이 목소리로)";
    box.append(note);
  }
  for (const v of voices.mine) row(v.name, voices.mineSpent ? "직접 만든 목소리 · 지금은 기본 목소리로 나옴" : "직접 만든 목소리", v.id);
  head("기본 목소리");
  for (const v of voices.system) row(v.name, [v.female ? "여성" : "남성", v.note].filter(Boolean).join(" · "), v.name);
  return box;
}
