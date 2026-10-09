import type { Guide, Provider } from "./types";

/**
 * One set of turn arrows for four providers' turn codes. Each provider
 * numbers its manoeuvres its own way (TMAP 12 is left, Kakao 1 is left,
 * Naver 2 is left, OSRM says "turn/left"). All of them also write the
 * guide in Korean, and the words are what the driver reads, so where the
 * words say which way ("오른쪽 방향", "10시 방향", "왼쪽 고속도로 출구")
 * they decide; the code only where they do not. The tables are the codes
 * seen in real answers (2026-09-30), not guessed.
 */
export type Maneuver =
  | "straight" | "left" | "right" | "slight-left" | "slight-right" | "sharp-left" | "sharp-right"
  | "uturn" | "ramp-left" | "ramp-right" | "roundabout" | "arrive" | "depart" | "other"
  /** A loop ramp: the road curls round most of a circle (성수대교 onto 강변북로). The words say 오른쪽 방향; the arrow shows the loop. */
  | "loop-left" | "loop-right";

const TMAP: Record<number, Maneuver> = {
  11: "straight", 12: "left", 13: "right", 14: "uturn", 16: "sharp-left", 17: "slight-left", 18: "slight-right", 19: "sharp-right",
  101: "ramp-right", 102: "ramp-left", 103: "straight", 104: "ramp-right", 105: "ramp-left",
  111: "ramp-right", 112: "ramp-left", 113: "straight", 114: "ramp-right", 115: "ramp-left",
  117: "slight-right", 118: "slight-left",
  184: "straight", 185: "straight", 186: "straight", 187: "straight", 188: "straight", 189: "straight",
  200: "depart", 201: "arrive", 203: "arrive", 204: "arrive", 205: "arrive",
};
const KAKAO: Record<number, Maneuver> = {
  0: "straight", 1: "left", 2: "right", 3: "uturn", 5: "slight-left", 6: "slight-right",
  9: "ramp-right", 12: "ramp-right", 44: "ramp-right", 47: "ramp-right", 49: "ramp-right",
  // 17 + the hour: 18 is 1시 … 29 is 12시.
  18: "slight-right", 19: "slight-right", 20: "right", 21: "sharp-right", 22: "sharp-right", 23: "uturn",
  24: "sharp-left", 25: "sharp-left", 26: "left", 27: "slight-left", 28: "slight-left", 29: "straight",
  // 41/42 "왼쪽/오른쪽 도로 주행" at a junction, and 42 also the bare "도시고속도로 출구" where 동부간선로 ends at 장암
  // onto 동일로's right: read off the road's bend that one was said as 왼쪽 출구, the ramp curling left after it parts.
  41: "slight-left", 42: "slight-right", 46: "slight-left",
  82: "slight-left", 83: "slight-right",
  100: "depart", 101: "arrive", 300: "roundabout",
};
const NAVER: Record<number, Maneuver> = {
  1: "straight", 2: "left", 3: "right", 4: "slight-left", 5: "slight-right", 6: "uturn",
  41: "slight-left", 42: "slight-right", 60: "ramp-left", 64: "slight-left",
  66: "ramp-right", 67: "ramp-right", 68: "ramp-right", 69: "ramp-right", 74: "slight-right",
  87: "arrive", 88: "arrive", 91: "depart",
};

const OSRM_MOD: Record<string, Maneuver> = { left: "left", right: "right", "slight left": "slight-left", "slight right": "slight-right", "sharp left": "sharp-left", "sharp right": "sharp-right", uturn: "uturn", straight: "straight" };

/** Read once a guide (a guide's words do not change, and the panel, the card and the close-up ask every frame). */
const known = new WeakMap<Guide, { provider: Provider; m: Maneuver }>();

export function maneuverOf(provider: Provider, guide: Guide): Maneuver {
  const had = known.get(guide);
  if (had && had.provider === provider) return had.m;
  const m = readManeuver(provider, guide);
  known.set(guide, { provider, m });
  return m;
}

function readManeuver(provider: Provider, guide: Guide): Maneuver {
  const t = guide.turnType;
  if ((provider === "osrm" || provider === "korea") && typeof t === "string") {
    const [type, mod] = t.split("/");
    if (type === "arrive") return "arrive";
    if (type === "roundabout" || type === "rotary") return "roundabout";
    if (type === "off ramp" || type === "on ramp") return mod?.includes("left") ? "ramp-left" : "ramp-right";
    if (mod) {
      const m = OSRM_MOD[mod];
      if (m) return m;
    }
  }
  const said = fromText(guide.text ?? "");
  if (said) return said;
  if (typeof t === "number") {
    const m = (provider === "tmap" ? TMAP : provider === "kakao" ? KAKAO : provider === "naver" ? NAVER : {})[t];
    // The code's side with the words' kind: a side kept that the words call an exit is the exit on that side.
    if (m && EXIT.test(guide.text ?? "") && MOTORWAY.test(guide.text ?? "")) return m === "slight-left" ? "ramp-left" : m === "slight-right" ? "ramp-right" : m;
    if (m) return m;
  }
  return "other";
}

/** A clock hour's direction: 12 ahead, 3 right, 9 left. */
const CLOCK: Record<number, Maneuver> = {
  12: "straight", 1: "slight-right", 2: "slight-right", 3: "right", 4: "sharp-right", 5: "sharp-right", 6: "uturn",
  7: "sharp-left", 8: "sharp-left", 9: "left", 10: "slight-left", 11: "slight-left",
};

// The words looked for, compiled once (fromText runs for every guide asked about).
const TAIL = /\s*후\s.*$/;
const ARRIVE = /도착|목적지/, DEPART = /출발/, UTURN = /유턴|U턴/, ROUNDABOUT = /회전교차로/, TOLL = /톨게이트|요금소/;
const HOUR = /(\d{1,2})\s*시\s*방향/;
const SHARP_LEFT = /급좌/, SHARP_RIGHT = /급우/, LEFT_TURN = /좌회전/, RIGHT_TURN = /우회전/;
const LEFT = /왼쪽|좌측/, RIGHT = /오른쪽|우측/, EXIT = /출구|진출/, MOTORWAY = /고속|전용|램프|IC|JC/, STRAIGHT = /직진/;
/** A side named as the way ("오른쪽 방향", "왼쪽 고속도로 출구"), as against the lane to be in ("우측 2차로 이용"). */
const SIDE_OF_WAY = /(왼쪽|좌측|오른쪽|우측)(?=\s*(?:에\s*)?(?:방향|고속|도시고속|자동차전용|출구|진출|진입|입구|도로|램프|길))/;

/** The way the words say, or null when they do not say one (a 지하차도, a 톨게이트). */
export function fromText(text: string): Maneuver | null {
  // The guide's own action, not the "…을 따라 1025m 이동" after it.
  const t = text.replace(TAIL, "");
  if (ARRIVE.test(t)) return "arrive";
  if (DEPART.test(t)) return "depart";
  if (UTURN.test(t)) return "uturn";
  if (ROUNDABOUT.test(t)) return "roundabout";
  if (TOLL.test(t)) return null;
  const hour = t.match(HOUR);
  if (hour && CLOCK[Number(hour[1])]) return CLOCK[Number(hour[1])];
  if (SHARP_LEFT.test(t)) return "sharp-left";
  if (SHARP_RIGHT.test(t)) return "sharp-right";
  if (LEFT_TURN.test(t)) return "left";
  if (RIGHT_TURN.test(t)) return "right";
  const left = LEFT.test(t), right = RIGHT.test(t);
  // Off a motorway is an exit ("오른쪽 출구"); onto one is only a way to keep to ("오른쪽 방향").
  const ramp = EXIT.test(t) && MOTORWAY.test(t);
  if (left && !right) return ramp ? "ramp-left" : "slight-left";
  if (right && !left) return ramp ? "ramp-right" : "slight-right";
  if (left && right) {
    // Both sides named: one is the lane to be in, the other the way ("좌측 차로를 이용하여 오른쪽 방향"). The way is
    // the side bound to its word; failing that, the last said, as the action ends a Korean sentence.
    const bound = t.match(SIDE_OF_WAY)?.[1];
    const lastLeft = Math.max(t.lastIndexOf("왼쪽"), t.lastIndexOf("좌측")), lastRight = Math.max(t.lastIndexOf("오른쪽"), t.lastIndexOf("우측"));
    const goesLeft = bound ? LEFT.test(bound) : lastLeft > lastRight;
    if (goesLeft) return ramp ? "ramp-left" : "slight-left";
    return ramp ? "ramp-right" : "slight-right";
  }
  if (STRAIGHT.test(t)) return "straight";
  return null;
}

/** An arrow as inline SVG, white on whatever is behind it; made once a shape and size (the panel asks every frame). */
const arrows = new Map<string, string>();
export function arrowSvg(m: Maneuver, size = 56): string {
  const key = `${m}:${size}`;
  let svg = arrows.get(key);
  if (svg === undefined) arrows.set(key, (svg = drawArrow(m, size)));
  return svg;
}

function drawArrow(m: Maneuver, size: number): string {
  const rot: Partial<Record<Maneuver, number>> = { straight: 0, "slight-right": 35, right: 90, "sharp-right": 135, "slight-left": -35, left: -90, "sharp-left": -135, "ramp-right": 35, "ramp-left": -35 };
  const head = "M12 3 L20 12 L15 12 L15 21 L9 21 L9 12 L4 12 Z";
  let body: string;
  switch (m) {
    case "uturn":
      // Up the right, over to the left and down, the head pointing back the way the car came: a U-turn on a Korean
      // road is to the left (drawn before the other way round, which read as a U-turn to the right).
      body = `<path d="M16 21 V9 a4 4 0 0 0 -8 0 V15" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M4 14 L8 20 L12 14 Z" fill="#fff"/>`;
      break;
    case "roundabout":
      body = `<circle cx="12" cy="13" r="5" fill="none" stroke="#fff" stroke-width="3"/><path d="M12 8 V2 M9 5 L12 2 L15 5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "arrive":
      body = `<circle cx="12" cy="9" r="5" fill="none" stroke="#fff" stroke-width="3"/><path d="M12 14 V22" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "loop-right": case "loop-left": {
      // Up, then round three quarters of a circle, the head coming back across: a loop ramp.
      const loop = `<path d="M7 22 V12 a5.5 5.5 0 1 1 5.5 5.5 H10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M11.5 13 L5.5 17.5 L11.5 22 Z" fill="#fff"/>`;
      body = m === "loop-right" ? loop : `<g transform="translate(24 0) scale(-1 1)">${loop}</g>`;
      break;
    }
    case "other": case "depart":
      body = `<circle cx="12" cy="12" r="4" fill="#fff"/>`;
      break;
    case "left": case "right": {
      // A turn as the car apps draw it: up the stem, then round the corner, the head pointing the way — not a
      // straight arrow laid on its side.
      const turn = `<path d="M14 22v-9a4 4 0 0 0-4-4H4" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 4 4 9l5 5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      body = m === "left" ? turn : `<g transform="translate(24 0) scale(-1 1)">${turn}</g>`;
      break;
    }
    default:
      body = `<path d="${head}" fill="#fff" transform="rotate(${rot[m] ?? 0} 12 12)"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** How the road runs at a guide: its bearing change over ±60 m (signed, right positive), and how much it sweeps over the next 200 m. */
export interface Bend { d60: number; sweep200: number }
/** A road that sweeps this much within 200 m is a loop ramp. */
export const LOOP_DEG = 200;

/**
 * The manoeuvre [m] (from the words and codes) set against the road's
 * own shape: a loop ramp is shown as one whichever side the words name.
 * Explicit turn/exit directions from providers are never inverted by road curvature.
 */
export function shapedOf(m: Maneuver, bend: Bend | null): Maneuver {
  if (!bend) return m;
  if (m === "arrive" || m === "depart" || m === "roundabout" || m === "uturn") return m;
  if (Math.abs(bend.sweep200) >= LOOP_DEG) return bend.sweep200 > 0 ? "loop-right" : "loop-left";
  return m;
}

/**
 * The way the road bends, from its bearing before a guide and after it:
 * for a guide whose words and code say no way ("고속도로 출구"), so the
 * voice still has a fixed sentence to fall back on if the guide's own
 * words cannot be rendered. Null where it runs on (under 15°).
 */
export function fromBend(beforeDeg: number, afterDeg: number, exit: boolean): Exclude<Maneuver, "arrive" | "depart" | "other" | "roundabout" | "loop-left" | "loop-right"> | null {
  let d = afterDeg - beforeDeg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  const a = Math.abs(d), side = d > 0 ? "right" : "left";
  if (a < 15) return null;
  if (exit) return side === "right" ? "ramp-right" : "ramp-left";
  if (a < 60) return side === "right" ? "slight-right" : "slight-left";
  if (a < 135) return side;
  if (a < 165) return side === "right" ? "sharp-right" : "sharp-left";
  return "uturn";
}
