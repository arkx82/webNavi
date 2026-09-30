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

function distance(m: number): string {
  return m >= 1000 ? `${m / 1000}킬로미터` : `${m}미터`;
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
/** The rungs for a camera when the first warning comes at [firstM]: that, and 300 m. */
export function cameraRungs(firstM: number): number[] {
  return firstM > 300 ? [firstM, 300] : [300];
}

/** Posted limits a camera can come with. */
export const LIMITS = [30, 40, 50, 60, 70, 80, 90, 100, 110];
/** A school zone's: 30 almost everywhere, a few 40 or 50 where the road is wide. */
export const SCHOOL_LIMITS = [30, 40, 50];

export function warningPhrase(kind: Warning, rungM: number, limit?: number): string {
  const d = `${distance(rungM)} 앞`;
  // "…, 제한 속도 80입니다": a sentence that ends, as the car apps say it.
  const lim = limit && LIMITS.includes(limit) ? `, 제한 속도 ${limit}입니다` : "";
  const schoolLim = limit && SCHOOL_LIMITS.includes(limit) ? `, 제한 속도 ${limit}입니다` : "";
  switch (kind) {
    case "speed": return lim ? `${d} 과속 단속${lim}` : `${d} 과속 단속 구간입니다`;
    case "signal": return `${d} 신호 단속 구간입니다`;
    case "speed-signal": return lim ? `${d} 신호 과속 단속${lim}` : `${d} 신호 과속 단속 구간입니다`;
    case "section-start": return lim ? `${d} 구간 단속 시작${lim}` : `${d} 구간 단속이 시작됩니다`;
    case "section-end": return `${d} 구간 단속이 끝납니다`;
    case "bump": return `${d} 과속 방지턱입니다`;
    // A school zone and its camera read the same, so the pair is said once (voice.ts drops a repeat).
    case "school": case "school-zone": return schoolLim ? `${d} 어린이 보호구역${schoolLim}` : `${d} 어린이 보호구역입니다`;
    case "curve": return `${d} 급커브 구간입니다`;
    case "curves": return `${d} 연속 급커브 구간입니다`;
    case "accident": return `${d} 사고 다발 지역입니다`;
    case "bike-accident": return `${d} 자전거 사고 다발 지역입니다`;
    case "incident-crash": return `${d} 교통사고가 났습니다, 주의하세요`;
    case "incident-work": return `${d} 공사 구간입니다`;
    case "incident-other": return `${d} 돌발 상황이 있습니다, 주의하세요`;
    case "rest-area": return `${d} 휴게소입니다`;
    case "merge": return MERGE_PHRASE;
    case "signal-light": return FLASHING_PHRASE;
    case "senior-zone": return `${d} 노인 보호구역입니다`;
    default: return `${d} 주의하세요`;
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
  for (const g of Object.values(GUIDE_LINES)) out.add(g);
  return [...out];
}
