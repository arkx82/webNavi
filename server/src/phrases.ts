/**
 * Every sentence the voice says, built from a small vocabulary the way the
 * car apps speak ("300미터 앞에서 좌회전입니다", "잠시 후 오른쪽 방향입니다"),
 * rather than reading out each provider's own guide text. The set is
 * closed, so all of it is rendered once and kept (tts.ts); a drive asks
 * the voice service for nothing new.
 *
 * One file for both sides: the server renders fixedPhrases(), the page
 * (web/src) imports the same builders, and a test checks the page can
 * only say what is in the list.
 */

export type Turn =
  | "straight" | "left" | "right" | "slight-left" | "slight-right" | "sharp-left" | "sharp-right"
  | "uturn" | "ramp-left" | "ramp-right" | "roundabout";

const TURN_WORDS: Record<Turn, string> = {
  straight: "직진",
  left: "좌회전",
  right: "우회전",
  "slight-left": "왼쪽 방향",
  "slight-right": "오른쪽 방향",
  "sharp-left": "왼쪽 급회전",
  "sharp-right": "오른쪽 급회전",
  uturn: "유턴",
  "ramp-left": "왼쪽 출구",
  "ramp-right": "오른쪽 출구",
  roundabout: "회전교차로",
};
export const TURNS = Object.keys(TURN_WORDS) as Turn[];

/** Where a turn is spoken from: far rungs in metres, then "잠시 후" close in. */
export const TURN_FAR_M = [1000, 500, 300] as const;
export const TURN_NEAR_M = 150;

/**
 * A number as Korean reads it (sino-Korean: 삼십, 백오십, 천이백): the voice
 * given digits sometimes reads them in English ("피프티"), so no digit
 * reaches it. 1 before 십·백·천 is silent (백, not 일백); alone it is 일.
 */
export function sino(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "영";
  const whole = Math.floor(n);
  const frac = n - whole;
  const digits = "영일이삼사오육칠팔구";
  const under10000 = (v: number): string => {
    let out = "";
    for (const [unit, name] of [[1000, "천"], [100, "백"], [10, "십"]] as const) {
      const d = Math.floor(v / unit) % 10;
      if (d) out += (d === 1 ? "" : digits[d]) + name;
    }
    const one = v % 10;
    if (one) out += digits[one];
    return out;
  };
  let words = "";
  const man = Math.floor(whole / 10000);
  if (man) words += (man === 1 ? "" : under10000(man)) + "만";
  words += under10000(whole % 10000);
  if (frac > 0) words += "점" + String(Math.round(frac * 100) / 100).slice(2).split("").map((c) => digits[Number(c)]).join("");
  return words;
}

/** Every number in [text] read out in Korean, digits and all; "2번째" becomes "두 번째". */
export function koreanNumbers(text: string): string {
  const ordinal = ["", "첫", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"];
  return text
    .replace(/(\d+)\s*번째/g, (_, d) => (Number(d) <= 10 ? `${ordinal[Number(d)]} 번째` : `${sino(Number(d))} 번째`))
    .replace(/\d+(?:\.\d+)?/g, (d) => sino(Number(d)));
}

function distance(m: number): string {
  return m >= 1000 ? `${sino(m / 1000)}킬로미터` : `${sino(m)}미터`;
}

/** A turn's word ("좌회전", "오른쪽 방향" …), for sentences built round a junction's name. */
export function turnWord(turn: Turn): string {
  return TURN_WORDS[turn];
}

export function distanceWords(m: number): string {
  return distance(m);
}

export function turnPhrase(turn: Turn, rungM: number): string {
  const word = TURN_WORDS[turn];
  return rungM <= TURN_NEAR_M ? `잠시 후 ${word}입니다` : `${distance(rungM)} 앞에서 ${word}입니다`;
}

export type Warning =
  | "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "curve" | "curves" | "accident" | "bike-accident"
  | "school-zone" | "incident-crash" | "incident-work" | "incident-other" | "rest-area" | "merge" | "signal-light" | "senior-zone" | "other";
export const WARNING_RUNGS_M: Record<Warning, number[]> = {
  speed: [600, 300],
  signal: [600, 300],
  "speed-signal": [600, 300],
  "section-start": [600, 300],
  "section-end": [300],
  bump: [150],
  school: [300],
  curve: [200],
  curves: [200],
  accident: [300],
  "bike-accident": [300],
  "school-zone": [300],
  // ITS 돌발상황: far enough out on a motorway to change lanes.
  "incident-crash": [1000, 300],
  "incident-work": [1000, 300],
  "incident-other": [1000, 300],
  "rest-area": [2000],
  // Placed past the ramp's start (web/src/highway.ts), said on the ramp.
  merge: [150],
  // A traffic light only speaks when it is flashing at night (web/src/warnings.ts).
  "signal-light": [200],
  // 노인·장애인 보호구역: shown (a band on the road), said only if the driver asks.
  "senior-zone": [300],
  other: [300],
};
/** Cameras (speed, signal, section) can be announced from further out; the driver picks where from. */
export const CAMERA_KINDS: Warning[] = ["speed", "signal", "speed-signal", "section-start"];
export const CAMERA_FIRST_M = [1000, 600, 300] as const;
export function cameraRungs(firstM: number): number[] {
  if (firstM >= 1000) return [1000, 600, 300];
  if (firstM >= 600) return [600, 300];
  return [300];
}

/** Posted limits a camera can come with. */
export const LIMITS = [30, 40, 50, 60, 70, 80, 90, 100, 110];
/** A school zone's: 30 almost everywhere, a few 40 or 50 where the road is wide. */
export const SCHOOL_LIMITS = [30, 40, 50];

export function warningPhrase(kind: Warning, rungM: number, limit?: number): string {
  // "600미터 앞에 …가 있습니다", not "600미터 앞 …": the bare 앞 at a phrase's edge is what the voice
  // stretches ("아앞…"); with a particle after it the sentence runs on as speech does.
  const at = `${distance(rungM)} 앞에`;
  const from = `${distance(rungM)} 앞에서`;
  const since = `${distance(rungM)} 앞부터`;
  // "…, 제한 속도 80입니다": a sentence that ends, as the car apps say it.
  const lim = limit && LIMITS.includes(limit) ? `, 제한 속도 ${sino(limit)}입니다` : "";
  const schoolLim = limit && SCHOOL_LIMITS.includes(limit) ? `, 제한 속도 ${sino(limit)}입니다` : "";
  switch (kind) {
    case "speed": return `${at} 과속 단속 카메라가 있습니다${lim}`;
    case "signal": return `${at} 신호 단속 카메라가 있습니다`;
    case "speed-signal": return `${at} 신호 과속 단속 카메라가 있습니다${lim}`;
    case "section-start": return `${from} 구간 단속이 시작됩니다${lim}`;
    case "section-end": return `${from} 구간 단속이 끝납니다`;
    case "bump": return `${at} 과속 방지턱이 있습니다`;
    // A school zone and its camera read the same, so the pair is said once (voice.ts drops a repeat).
    case "school": case "school-zone": return `${since} 어린이 보호구역입니다${schoolLim}`;
    case "curve": return `${at} 급커브 구간이 있습니다`;
    case "curves": return `${at} 연속 급커브 구간이 있습니다`;
    case "accident": return `${at} 사고 다발 지역이 있습니다`;
    case "bike-accident": return `${at} 자전거 사고 다발 지역이 있습니다`;
    case "incident-crash": return `${at} 교통사고가 났습니다, 주의하세요`;
    case "incident-work": return `${at} 공사 구간이 있습니다`;
    case "incident-other": return `${at} 돌발 상황이 있습니다, 주의하세요`;
    case "rest-area": return `${at} 휴게소가 있습니다`;
    case "merge": return MERGE_PHRASE;
    case "signal-light": return FLASHING_PHRASE;
    case "senior-zone": return `${since} 노인 보호구역입니다`;
    default: return `${at} 주의할 곳이 있습니다`;
  }
}

export const EVENTS = {
  start: "안내를 시작합니다",
  changed: "목적지를 변경합니다",
  faster: "더 빠른 길로 안내합니다",
  off: "경로를 벗어나 다시 탐색합니다",
  nearGoal: "잠시 후 목적지에 도착합니다",
  arrived: "목적지에 도착했습니다. 안내를 종료합니다",
  weakGps: "GPS 신호가 약합니다",
  resumed: "이전 안내를 이어서 시작합니다",
} as const;

/** "사분 빠른 길이 있습니다": the periodic recheck found a quicker way; the driver takes it or keeps the road. */
export const FASTER_MINUTES = Array.from({ length: 28 }, (_, i) => i + 3);
export function fasterPhrase(minutes: number): string {
  const m = Math.max(FASTER_MINUTES[0], Math.min(FASTER_MINUTES[FASTER_MINUTES.length - 1], Math.round(minutes)));
  return `${sino(m)}분 빠른 길이 있습니다`;
}

export const MERGE_PHRASE = "잠시 후 합류 구간입니다, 주의하세요";
export const FLASHING_PHRASE = "잠시 후 점멸 신호 교차로입니다, 서행하세요";

/** 노면색깔유도선: the line to follow at a motorway junction (server/src/road/color-guides.ts). */
export const GUIDE_LINES = {
  pink: "분홍색 유도선을 따라가세요",
  green: "녹색 유도선을 따라가세요",
  blue: "파란색 유도선을 따라가세요",
  orange: "주황색 유도선을 따라가세요",
} as const;

/** Before a motorway exit or branch: which side to be on, a kilometre out (not lane data: the side of the turn). */
export const LANE_HINTS = { right: "오른쪽 차로로 미리 이동하세요", left: "왼쪽 차로로 미리 이동하세요" } as const;

/** 기상특보 a driver is told of: the rest (풍랑, 폭풍해일, 건조) are shown, not said. */
export const ALERT_KINDS = ["호우", "대설", "태풍", "강풍", "한파", "폭염", "황사"] as const;
export const ALERT_LEVELS = ["주의보", "경보"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export function alertPhrase(kind: AlertKind, level: AlertLevel): string {
  return `이 지역에 ${kind}${level}가 발효 중입니다. 안전 운전하세요`;
}

/** Everything above, in every form: what the server renders ahead of any drive. */
export function fixedPhrases(): string[] {
  const out = new Set<string>(Object.values(EVENTS));
  for (const t of TURNS) {
    for (const r of TURN_FAR_M) out.add(turnPhrase(t, r));
    out.add(turnPhrase(t, TURN_NEAR_M));
  }
  for (const [kind, base] of Object.entries(WARNING_RUNGS_M) as [Warning, number[]][]) {
    const rungs = CAMERA_KINDS.includes(kind) ? [...CAMERA_FIRST_M] : base;
    for (const r of rungs) {
      out.add(warningPhrase(kind, r));
      if (kind === "speed" || kind === "speed-signal" || kind === "section-start") {
        for (const l of LIMITS) out.add(warningPhrase(kind, r, l));
      }
      if (kind === "school" || kind === "school-zone") {
        for (const l of SCHOOL_LIMITS) out.add(warningPhrase(kind, r, l));
      }
    }
  }
  for (const k of ALERT_KINDS) for (const l of ALERT_LEVELS) out.add(alertPhrase(k, l));
  for (const h of Object.values(LANE_HINTS)) out.add(h);
  for (const m of FASTER_MINUTES) out.add(fasterPhrase(m));
  for (const g of Object.values(GUIDE_LINES)) out.add(g);
  return [...out];
}
