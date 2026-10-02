/**
 * The lanes for the turn ahead, in a card at the foot of the map: the
 * turn's arrow, how far, which lanes to be in ("3차로", counted from the
 * left as Korean roads are), and — where 정밀도로지도 has the junction
 * (server/src/lanes.ts) — a box a lane with the ways it may go, the ones to
 * be in lit. Without the map's lanes, only the side to keep to. Not where
 * the car is — no GPS tells a lane — but where to be before the stop line.
 */
import { escape } from "./html";

export type Turn = "uturn" | "left" | "straight" | "right";
export interface Lanes { lanes: { turns: Turn[]; best: boolean; /** Can take the way too, but a lane nearer the turn after is better (main.ts narrows best by it). */ ok?: boolean }[]; stopM?: number }

/** An arrow a way, drawn on a 24 px square: a stem up the middle, bent where it turns. */
const PATH: Record<Turn, string> = {
  straight: "M12 21V5M7 10l5-5 5 5",
  left: "M14 21v-8a3 3 0 0 0-3-3H5M9 6 5 10l4 4",
  right: "M10 21v-8a3 3 0 0 1 3-3h6M15 6l4 4-4 4",
  uturn: "M16 21V9a4 4 0 0 0-8 0v6M5 12l3 3 3-3",
};

/**
 * A lane's ways as one drawing: a stem up the middle, and where it may also
 * turn, a branch off that stem with its own head — "straight or right" is
 * one arrow that forks, not two arrows on top of each other.
 */
export function laneGlyph(turns: Turn[]): string {
  const set = new Set(turns);
  const has = (...t: Turn[]) => t.every((x) => set.has(x));
  if (has("straight", "right") && !set.has("left") && !set.has("uturn")) {
    return `<path d="M8 21V5"/><path d="M4 9l4-4 4 4"/><path d="M8 15h9"/><path d="M14 12l3 3-3 3"/>`;
  }
  if (has("straight", "left") && !set.has("right") && !set.has("uturn")) {
    return `<path d="M16 21V5"/><path d="M12 9l4-4 4 4"/><path d="M16 15H7"/><path d="M10 12l-3 3 3 3"/>`;
  }
  if (has("left", "right") && !set.has("straight") && !set.has("uturn")) {
    return `<path d="M12 21v-8"/><path d="M12 13H4"/><path d="M7 10l-3 3 3 3"/><path d="M12 13h8"/><path d="M17 10l3 3-3 3"/>`;
  }
  if (has("straight", "left", "right") && !set.has("uturn")) {
    return `<path d="M12 21V4"/><path d="M8 8l4-4 4 4"/><path d="M12 15H4"/><path d="M7 12l-3 3 3 3"/><path d="M12 15h8"/><path d="M17 12l3 3-3 3"/>`;
  }
  if (set.has("uturn") && set.size > 1) return uturnGlyph(set);
  return turns.map((t) => `<path d="${PATH[t]}"/>`).join("");
}

/**
 * A U-turn lane that may go other ways too, as one arrow: the stem up the
 * right, the U-turn bending over off it to the left and coming down, the
 * other ways branching off the same stem below it — never two arrows laid
 * on one another. Without 직진 the stem's top is itself the U-turn.
 */
function uturnGlyph(set: Set<Turn>): string {
  const x = 16;
  const out: string[] = [];
  if (set.has("straight")) {
    out.push(`<path d="M${x} 22V3"/>`, `<path d="M${x - 3.5} 6.5 ${x} 3l3.5 3.5"/>`);
    // Off the stem's side, under the straight arrow's head.
    out.push(`<path d="M${x} 13a3.5 3.5 0 0 0-7 0v1.5"/>`, `<path d="M${x - 9.5} 12l2.5 2.5 2.5-2.5"/>`);
  } else {
    out.push(`<path d="M${x} 22V8.5a3.5 3.5 0 0 0-7 0v3"/>`, `<path d="M${x - 9.5} 9l2.5 2.5 2.5-2.5"/>`);
  }
  // The other ways low on the stem, clear of the U-turn's head.
  const y = 19.5;
  if (set.has("left")) out.push(`<path d="M${x} ${y}H5"/>`, `<path d="M7.5 ${y - 2.5} 5 ${y}l2.5 2.5"/>`);
  if (set.has("right")) out.push(`<path d="M${x} ${y}h5"/>`, `<path d="M19 ${y - 2.5}l2.5 2.5-2.5 2.5"/>`);
  return out.join("");
}

/** "2차로", "1·2차로", "3~5차로": the lanes to be in, numbered from the left. */
export function laneWords(lanes: Lanes["lanes"]): string | null {
  const n = lanes.map((l, i) => (l.best ? i + 1 : 0)).filter(Boolean);
  if (n.length === 0 || n.length === lanes.length) return null;
  const run = n.every((v, i) => i === 0 || v === n[i - 1] + 1);
  return `${run && n.length > 2 ? `${n[0]}~${n[n.length - 1]}` : n.join("·")}차로`;
}

const ONLY_WORDS: Record<Turn, string> = { uturn: "유턴", left: "좌회전", straight: "직진", right: "우회전" };
/** "1차로 좌회전 전용 · 4차로 우회전 전용": the lanes that cannot go [way], and what they are for. */
export function onlyWords(lanes: Lanes["lanes"], way: Turn): string | null {
  const parts = lanes.map((l, i) => (l.turns.length && !l.turns.includes(way) ? `${i + 1}차로 ${l.turns.map((t) => ONLY_WORDS[t]).join("·")} 전용` : null)).filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export interface LaneCard {
  /** The turn's own arrow (maneuver.ts arrowSvg). */
  arrow: string;
  /** "230 m" */
  inText: string;
  /** "우회전" … */
  what: string;
  /** Where 정밀도로지도 has the junction. */
  lanes: Lanes | null;
  /** Without it: the side to keep to, "왼쪽 차로로" or "오른쪽 차로로". */
  side: string | null;
  /** A warning line: the lanes that must turn at the stop line ("1차로 좌회전 전용"). */
  note?: string | null;
  /** The route's way there: a lane that cannot take it is marked 전용 in its box. */
  way?: Turn;
  /** 노면색깔유도선 at a motorway junction: each branch's colour, and the branch to take. */
  lines?: { left?: GuideColour; right?: GuideColour; go: "left" | "right" } | null;
  /** A motorway junction drawn as a picture: a fork, an exit off the main road, or an entrance onto it. */
  junction?: Junction | null;
}

export interface Junction {
  kind: "fork" | "exit" | "enter";
  go: "left" | "right";
  /** "신갈JC", "용인IC" … */
  name?: string;
  /** Where the branch taken leads: "인천". */
  toward?: string;
}

const GO = "#4fc3f7", OTHER = "#8a8f99";

/**
 * The junction as the car apps draw it: the road coming up from the foot
 * and what it becomes — two branches (a JC), the main road with a ramp off
 * it (an exit), or a ramp joining it (an entrance). The way to take is
 * thick, bright and has its arrowhead and its town; the rest is grey and
 * thin. Coloured as the painted guide lines where those are known.
 */
export function junctionSvg(j: Junction, lines?: LaneCard["lines"]): string {
  const colourOf = (side: "left" | "right" | "main", go: boolean) => {
    const c = side !== "main" && lines?.[side] ? HEX[lines[side]!] : null;
    return c ?? (go ? GO : OTHER);
  };
  const path = (d: string, side: "left" | "right" | "main", go: boolean) =>
    `<path d="${d}" stroke="${colourOf(side, go)}" stroke-width="${go ? 13 : 8}" stroke-linecap="round" fill="none" opacity="${go ? 1 : 0.5}"/>`;
  const head = (x: number, y: number, deg: number, side: "left" | "right" | "main") =>
    `<path d="M-9 6 L0 -6 L9 6" transform="translate(${x} ${y}) rotate(${deg})" stroke="${colourOf(side, true)}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  const label = (x: number, y: number, text: string | undefined, anchor: string) =>
    text ? `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="15" font-weight="800" fill="currentColor">${escape(text)}</text>` : "";
  const L = j.go === "left";
  let body = "";
  if (j.kind === "fork") {
    const left = "M80 104 L80 78 C80 58 54 42 38 16", right = "M80 104 L80 78 C80 58 106 42 122 16";
    body = path(L ? right : left, L ? "right" : "left", false) + path(L ? left : right, j.go, true) +
      (L ? head(38, 16, -35, "left") : head(122, 16, 35, "right")) + label(L ? 30 : 130, 12, j.toward, L ? "end" : "start");
  } else if (j.kind === "exit") {
    const ramp = L ? "M80 104 L80 70 C80 52 58 40 36 22" : "M80 104 L80 70 C80 52 102 40 124 22";
    body = path("M80 104 L80 8", "main", false) + path(ramp, j.go, true) +
      (L ? head(36, 22, -50, "left") : head(124, 22, 50, "right")) + label(L ? 28 : 132, 16, j.toward, L ? "end" : "start");
  } else {
    // An entrance as it is driven: the road the car is on up the middle, the ramp off it to the side taken, joining
    // the motorway that runs up that side. (Drawn before as a ramp merging in from the side, which read as the
    // opposite way at a right-hand entrance.)
    const mx = L ? 36 : 124;
    const ramp = L ? "M80 104 L80 72 C80 54 56 46 36 30" : "M80 104 L80 72 C80 54 104 46 124 30";
    body = path("M80 104 L80 8", "main", false) + path(`M${mx} 104 L${mx} 8`, "main", false) + path(ramp, j.go, true)
      + path(`M${mx} 32 L${mx} 10`, "main", true) + head(mx, 10, 0, "main") + label(L ? mx - 10 : mx + 10, 20, j.toward, L ? "end" : "start");
  }
  // overflow visible: a long name (남구리IC) runs past the drawing's edge into the card's margin rather than being cut.
  return `<svg viewBox="0 0 160 110" width="176" height="121" overflow="visible" aria-hidden="true">${body}</svg>`;
}

export type GuideColour = "pink" | "green" | "blue" | "orange";
const HEX: Record<GuideColour, string> = { pink: "#ff5fa2", green: "#22c55e", blue: "#3b82f6", orange: "#ff9f1c" };
export const COLOUR_WORDS: Record<GuideColour, string> = { pink: "분홍색", green: "녹색", blue: "파란색", orange: "주황색" };

/**
 * The fork as a picture: the road coming up from the foot, parting in two,
 * each branch in its guide line's colour; the one to take thick and with
 * its arrowhead, the other thin and faint — no reading needed at 100 km/h.
 */
export function forkSvg(lines: NonNullable<LaneCard["lines"]>): string {
  const branch = (side: "left" | "right") => {
    const go = lines.go === side;
    const colour = lines[side] ? HEX[lines[side]!] : "#8a8f99";
    const d = side === "left" ? "M60 58 C60 40 34 30 22 10" : "M60 58 C60 40 86 30 98 10";
    const head = side === "left" ? "M14 14 L22 10 L24 19" : "M106 14 L98 10 L96 19";
    return `<path d="${d}" stroke="${colour}" stroke-width="${go ? 11 : 6}" stroke-linecap="round" fill="none" opacity="${go ? 1 : 0.45}"/>` +
      (go ? `<path d="${head}" stroke="${colour}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` : "");
  };
  return `<svg viewBox="0 0 120 70" width="150" height="88" aria-hidden="true">` +
    `<path d="M60 68 L60 56" stroke="#8a8f99" stroke-width="11" stroke-linecap="round"/>` +
    branch(lines.go === "left" ? "right" : "left") + branch(lines.go) + `</svg>`;
}

/** What drawLaneCard touches on the card's element, so a test can hand it a stand-in (cast to HTMLElement). */
export interface CardBox {
  hidden: boolean;
  innerHTML: string;
  textContent: string | null;
  style: { color: string };
  replaceChildren(): void;
  querySelector(selector: string): CardBox | null;
}

/** What was drawn last, so a card redrawn every frame touches the page only when it changes; the distance apart, as it changes every few metres. */
let drawn = "", drawnIn = "";

function cardKey(card: LaneCard | null): string {
  if (!card) return "";
  const l = card.lines ? `${card.lines.left ?? ""}:${card.lines.right ?? ""}:${card.lines.go}` : "";
  const j = card.junction ? `${card.junction.kind}:${card.junction.go}:${card.junction.name ?? ""}:${card.junction.toward ?? ""}` : "";
  let lanesStr = "";
  if (card.lanes?.lanes) {
    for (const lane of card.lanes.lanes) {
      lanesStr += `${lane.turns.join(",")}${lane.best ? "!" : ""}${lane.ok ? "?" : ""};`;
    }
  }
  return `${card.what}\u0001${card.side ?? ""}\u0001${card.note ?? ""}\u0001${card.way ?? ""}\u0001${l}\u0001${j}\u0001${lanesStr}\u0001${card.arrow}`;
}

export function drawLaneCard(el: HTMLElement, card: LaneCard | null) {
  const box = el as unknown as CardBox;
  const inText = card?.inText ?? "";
  const key = cardKey(card);
  if (key === drawn) {
    // Only the distance moved: the number changes, the arrows and lanes stay as they are.
    if (card && inText !== drawnIn) { drawnIn = inText; box.querySelector(".lc-in")!.textContent = inText; }
    return;
  }
  drawn = key;
  drawnIn = inText;
  box.hidden = !card;
  if (!card) { box.replaceChildren(); return; }
  const words = card.lanes ? laneWords(card.lanes.lanes) : null;
  const colour = card.lines ? card.lines[card.lines.go] : undefined;
  box.innerHTML = `<div class="lc-head"><span class="lc-arrow"></span><b class="lc-in"></b><span class="lc-what"></span></div><div class="lc-note"></div><div class="lc-fork"></div><div class="lc-follow"></div><div class="lc-lanes"></div>`;
  const note = box.querySelector(".lc-note")!;
  note.hidden = !card.note;
  note.textContent = card.note ?? "";
  box.querySelector(".lc-arrow")!.innerHTML = card.arrow;
  box.querySelector(".lc-in")!.textContent = inText;
  box.querySelector(".lc-what")!.textContent = [card.what, colour ? null : words ?? card.side].filter(Boolean).join(" · ");
  const fork = box.querySelector(".lc-fork")!, follow = box.querySelector(".lc-follow")!;
  // The junction's picture: from its own kind where it is a motorway junction, else the plain fork of the guide lines.
  fork.hidden = !card.junction && !(card.lines && colour);
  if (card.junction) fork.innerHTML = junctionSvg(card.junction, card.lines);
  else if (card.lines && colour) fork.innerHTML = forkSvg(card.lines);
  follow.hidden = !colour;
  if (colour) {
    follow.textContent = `${COLOUR_WORDS[colour]} 유도선을 따라가세요`;
    follow.style.color = HEX[colour];
  }
  if (card.junction?.name) {
    box.querySelector(".lc-what")!.textContent = [card.junction.name, card.junction.toward && `${card.junction.toward} 방면`, card.what].filter(Boolean).join(" · ");
  }
  const row = box.querySelector(".lc-lanes")!;
  row.hidden = !card.lanes || card.lanes.lanes.length < 2;
  row.innerHTML = (card.lanes?.lanes ?? []).map((lane) => {
    // A lane that cannot go the route's way at the stop line: marked 전용, to be kept out of.
    const only = !!card.way && lane.turns.length > 0 && !lane.turns.includes(card.way);
    return `<div class="lane${lane.best ? " best" : lane.ok ? " ok" : ""}${only ? " only" : ""}"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${laneGlyph(lane.turns)}</svg>${only ? `<i>전용</i>` : ""}</div>`;
  }).join("");
}
