import type { Guide, Provider } from "./types";

/**
 * One set of turn arrows for four providers' turn codes. Each provider
 * numbers its manoeuvres its own way (TMAP 12 is left, Kakao 2 is left,
 * Naver 2 is left, OSRM says "turn/left"); the text is the tie-breaker
 * when a code is unknown, since all of them write 좌회전 for a left.
 */
export type Maneuver =
  | "straight" | "left" | "right" | "slight-left" | "slight-right" | "sharp-left" | "sharp-right"
  | "uturn" | "ramp-left" | "ramp-right" | "roundabout" | "arrive" | "depart" | "other";

const TMAP: Record<number, Maneuver> = {
  11: "straight", 12: "left", 13: "right", 14: "uturn", 16: "sharp-left", 17: "slight-left", 18: "slight-right", 19: "sharp-right",
  184: "straight", 185: "straight", 186: "straight", 187: "straight", 188: "straight", 189: "straight",
  200: "depart", 201: "arrive", 203: "arrive", 204: "arrive", 205: "arrive",
};
const KAKAO: Record<number, Maneuver> = {
  1: "straight", 2: "left", 3: "right", 4: "uturn", 5: "uturn", 6: "sharp-left", 7: "slight-left", 8: "slight-right", 9: "sharp-right",
  11: "slight-left", 12: "slight-right", 14: "ramp-right", 15: "ramp-right", 16: "slight-left", 17: "slight-right",
  18: "straight", 19: "straight", 100: "depart", 101: "arrive", 300: "roundabout",
};
const NAVER: Record<number, Maneuver> = {
  1: "straight", 2: "left", 3: "right", 4: "uturn", 5: "uturn", 6: "slight-left", 7: "slight-right",
  11: "ramp-right", 12: "ramp-right", 13: "roundabout", 14: "slight-left", 15: "slight-right",
  87: "arrive", 88: "arrive", 91: "depart",
};

export function maneuverOf(provider: Provider, guide: Guide): Maneuver {
  const t = guide.turnType;
  let m: Maneuver | undefined;
  if (provider === "osrm" && typeof t === "string") {
    const [type, mod] = t.split("/");
    if (type === "arrive") m = "arrive";
    else if (type === "roundabout" || type === "rotary") m = "roundabout";
    else if (type === "off ramp" || type === "on ramp") m = mod?.includes("left") ? "ramp-left" : "ramp-right";
    else if (mod) m = ({ left: "left", right: "right", "slight left": "slight-left", "slight right": "slight-right", "sharp left": "sharp-left", "sharp right": "sharp-right", uturn: "uturn", straight: "straight" } as Record<string, Maneuver>)[mod];
  } else if (typeof t === "number") {
    m = (provider === "tmap" ? TMAP : provider === "kakao" ? KAKAO : NAVER)[t];
  }
  return m ?? fromText(guide.text);
}

function fromText(text: string): Maneuver {
  if (/도착/.test(text)) return "arrive";
  if (/유턴|U턴/.test(text)) return "uturn";
  if (/회전교차로/.test(text)) return "roundabout";
  if (/급좌/.test(text)) return "sharp-left";
  if (/급우/.test(text)) return "sharp-right";
  if (/좌회전/.test(text)) return "left";
  if (/우회전/.test(text)) return "right";
  if (/왼쪽|좌측/.test(text)) return "slight-left";
  if (/오른쪽|우측|출구|진출|진입/.test(text)) return "slight-right";
  if (/직진/.test(text)) return "straight";
  return "other";
}

/** An arrow as inline SVG, white on whatever is behind it. */
export function arrowSvg(m: Maneuver, size = 56): string {
  const rot: Partial<Record<Maneuver, number>> = { straight: 0, "slight-right": 35, right: 90, "sharp-right": 135, "slight-left": -35, left: -90, "sharp-left": -135, "ramp-right": 35, "ramp-left": -35 };
  const head = "M12 3 L20 12 L15 12 L15 21 L9 21 L9 12 L4 12 Z";
  let body: string;
  switch (m) {
    case "uturn":
      body = `<path d="M8 21 V9 a4 4 0 0 1 8 0 V15" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M12 14 L16 20 L20 14 Z" fill="#fff"/>`;
      break;
    case "roundabout":
      body = `<circle cx="12" cy="13" r="5" fill="none" stroke="#fff" stroke-width="3"/><path d="M12 8 V2 M9 5 L12 2 L15 5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "arrive":
      body = `<circle cx="12" cy="9" r="5" fill="none" stroke="#fff" stroke-width="3"/><path d="M12 14 V22" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "other": case "depart":
      body = `<circle cx="12" cy="12" r="4" fill="#fff"/>`;
      break;
    default:
      body = `<path d="${head}" fill="#fff" transform="rotate(${rot[m] ?? 0} 12 12)"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}
