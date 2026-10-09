/**
 * "You" on the map at the car's own size: a Model Y L seen from above
 * (4,976 × 1,920 mm, the mirrors 110 mm out each side), or the arrow of
 * before, laid on the road and sized as the car. A fixed 44 px arrow was
 * as wide as two lanes in town (zoom 18 is about 0.24 m a pixel), where
 * the lane lines are drawn now.
 *
 * Drawn here, not a picture of Tesla's: the body in the paint chosen, the
 * glass roof, the light bars front and back.
 */

export type CarIcon = "tesla" | "arrow";

/** Model Y L, metres. */
export const CAR_LENGTH_M = 4.976;
export const CAR_WIDTH_M = 1.92;
/** The SVG's box, in centimetres: the body 192 × 498, the mirrors and a little room round it. */
const BOX = { x: -14, y: -4, w: 220, h: 506 };
/** Below this the car would be a speck (zoom 16 at 100 km/h is about 0.9 m a pixel): never drawn shorter, in px. */
export const MIN_LENGTH_PX = 28;

/** Paints offered in 안내 설정, as Tesla names them for this car. */
export const PAINTS: [value: string, label: string][] = [
  ["#eceef0", "펄 화이트"],
  ["#4f5459", "스텔스 그레이"],
  ["#1d1e20", "다이아몬드 블랙"],
  ["#9fa4a9", "퀵실버"],
  ["#1d3a6b", "글레이셔 블루"],
  ["#9a1622", "울트라 레드"],
];

export function carSvg(icon: CarIcon, paint: string): string {
  return icon === "arrow" ? arrowSvg() : teslaSvg(paint);
}

/** The element's size in px for the car drawn [pxPerM] pixels a metre: the body's length kept at MIN_LENGTH_PX or more. */
export function carBoxPx(pxPerM: number): { w: number; h: number } {
  const scale = Math.max(pxPerM, MIN_LENGTH_PX / CAR_LENGTH_M);
  return { w: (BOX.w / 100) * scale, h: (BOX.h / 100) * scale };
}

function arrowSvg(): string {
  // The arrow of before, its point at the car's nose and its tail at the bumper.
  return `<svg viewBox="${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}" width="100%" height="100%" preserveAspectRatio="none">`
    + `<path d="M96 6 186 486 96 400 6 486z" fill="#1a73e8" stroke="#fff" stroke-width="16" stroke-linejoin="round"/></svg>`;
}

function teslaSvg(paint: string): string {
  const dark = luminance(paint) < 0.25;
  const edge = mix(paint, "#000000", dark ? 0.1 : 0.32);
  const shine = mix(paint, "#ffffff", dark ? 0.22 : 0.5);
  // A dark paint is outlined light, or it is lost on the night map.
  const outline = dark ? "rgba(255,255,255,.6)" : "rgba(0,0,0,.45)";
  const id = `p${paint.replace(/[^0-9a-f]/gi, "")}`;
  return `<svg viewBox="${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}" width="100%" height="100%" preserveAspectRatio="none">
<defs>
<linearGradient id="${id}b" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${edge}"/><stop offset=".22" stop-color="${paint}"/><stop offset=".5" stop-color="${shine}"/><stop offset=".78" stop-color="${paint}"/><stop offset="1" stop-color="${edge}"/></linearGradient>
<linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3b4a5a"/><stop offset=".35" stop-color="#16202b"/><stop offset="1" stop-color="#0b1118"/></linearGradient>
</defs>
<path d="M-1 130-11 125C-15 129-15 143-11 147L-1 146ZM193 130 203 125C207 129 207 143 203 147L193 146Z" fill="${paint}" stroke="${outline}" stroke-width="2"/>
<path d="M96 1C134 1 170 5 181 18C188 27 190 45 190 62L191 140C192 200 192 330 191 380C190 430 188 462 180 480C170 494 132 497 96 497C60 497 22 494 12 480C4 462 2 430 1 380C0 330 0 200 1 140L2 62C2 45 4 27 11 18C22 5 58 1 96 1Z" fill="url(#${id}b)" stroke="${outline}" stroke-width="2.5"/>
<path d="M52 24C50 60 52 92 58 112M140 24C142 60 140 92 134 112" fill="none" stroke="${edge}" stroke-width="2" opacity=".5"/>
<path d="M38 126C66 117 126 117 154 126C160 150 163 180 164 210L163 398C162 422 158 440 150 452C126 459 66 459 42 452C34 440 30 422 29 398L28 210C29 180 32 150 38 126Z" fill="url(#${id}g)"/>
<path d="M29 206C72 198 120 198 163 206M30 408C72 416 120 416 162 408" fill="none" stroke="#45525f" stroke-width="3"/>
<path d="M50 134C46 150 44 170 44 192" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".28"/>
<path d="M22 10C60 3 132 3 170 10" fill="none" stroke="#eaf6ff" stroke-width="4" stroke-linecap="round"/>
<path d="M10 22C14 15 22 11 34 9M182 22C178 15 170 11 158 9" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
<path d="M18 486C60 494 132 494 174 486" fill="none" stroke="#ff2b2b" stroke-width="5" stroke-linecap="round"/>
</svg>`;
}

/**
 * Pixels a metre on the ground where [at] is drawn, across the screen (the
 * way that is not foreshortened when the map is tilted): a tilted map is
 * larger at the screen's foot, where the car sits, than at its middle.
 */
export function groundPxPerM(project: (p: [number, number]) => { x: number; y: number }, at: [number, number], bearingDeg: number): number {
  const across = ((bearingDeg + 90) * Math.PI) / 180;
  const dLon = (10 * Math.sin(across)) / (111_320 * Math.cos((at[1] * Math.PI) / 180));
  const dLat = (10 * Math.cos(across)) / 110_540;
  const a = project(at), b = project([at[0] + dLon, at[1] + dLat]);
  return Math.hypot(b.x - a.x, b.y - a.y) / 10;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
