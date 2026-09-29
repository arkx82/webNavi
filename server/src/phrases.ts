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

export function turnPhrase(turn: Turn, rungM: number): string {
  const word = TURN_WORDS[turn];
  return rungM <= TURN_NEAR_M ? `잠시 후 ${word}입니다` : `${distance(rungM)} 앞에서 ${word}입니다`;
}

export type Warning = "speed" | "signal" | "speed-signal" | "section-start" | "section-end" | "bump" | "school" | "curve" | "curves" | "accident" | "bike-accident" | "other";
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

export function warningPhrase(kind: Warning, rungM: number, limit?: number): string {
  const d = `${distance(rungM)} 앞`;
  const lim = limit && LIMITS.includes(limit) ? `, 제한 속도 ${limit}` : "";
  switch (kind) {
    case "speed": return `${d} 과속 단속${lim}`;
    case "signal": return `${d} 신호 단속 구간입니다`;
    case "speed-signal": return `${d} 신호 과속 단속${lim}`;
    case "section-start": return `${d} 구간 단속 시작${lim}`;
    case "section-end": return `${d} 구간 단속이 끝납니다`;
    case "bump": return `${d} 과속 방지턱입니다`;
    case "school": return `${d} 어린이 보호구역입니다`;
    case "curve": return `${d} 급커브 구간입니다`;
    case "curves": return `${d} 연속 급커브 구간입니다`;
    case "accident": return `${d} 사고 다발 지역입니다`;
    case "bike-accident": return `${d} 자전거 사고 다발 지역입니다`;
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
} as const;

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
    }
  }
  return [...out];
}
