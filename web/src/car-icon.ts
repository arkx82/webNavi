import type maplibregl from "maplibre-gl";
import type { LonLat } from "./types";

/**
 * "You" on the map at the car's own size: a Model Y L seen from above
 * (4,976 × 1,920 mm, the mirrors 110 mm out each side), the arrow of
 * before sized as the car, or a picture of one's own (the server's
 * CONFIG_DIR/car-icon.png, kept out of the repository).
 *
 * Drawn by the map itself, as an image laid on the ground by its four
 * corners in metres (CarLayer): the same scale as the road under it at
 * every zoom, tilt and place on the screen. An HTML marker is only turned
 * flat (CSS rotateX, no perspective) and sized in screen pixels — lower on
 * a tilted screen the road is larger than that, and a car turned across
 * the screen came out the wrong shape.
 */

export type CarIcon = "tesla" | "arrow" | "photo";

/** Model Y L, metres. */
export const CAR_LENGTH_M = 4.976;
export const CAR_WIDTH_M = 1.92;
/** The SVG's box, in centimetres: the body 192 × 498 centred in it, the mirrors and a little room round it. */
const BOX = { x: -14, y: -4, w: 220, h: 506 };
/** Room round the drawing for its shadow, cm. */
const PAD_CM = 24;
/** Pixels a centimetre the drawing is made at: 0.06 m a screen pixel (zoom 20) still sharp. */
const PX_PER_CM = 1.25;

/** A degree of the map's own sphere (MapLibre's earth radius, 6,371,008.8 m): the road under the car is measured so. */
const MAP_M_PER_DEG = (2 * Math.PI * 6_371_008.8) / 360;

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

/**
 * The four corners (front left, front right, back right, back left: the image's top left round to its bottom left) of a
 * box [widthM] × [lengthM] centred on [at], its front toward [headingDeg] (clockwise from north).
 */
export function carCorners(at: LonLat, headingDeg: number, widthM: number, lengthM: number): [LonLat, LonLat, LonLat, LonLat] {
  const h = (headingDeg * Math.PI) / 180;
  const fE = Math.sin(h), fN = Math.cos(h), rE = Math.cos(h), rN = -Math.sin(h);
  const mLon = 1 / (MAP_M_PER_DEG * Math.cos((at[1] * Math.PI) / 180)), mLat = 1 / MAP_M_PER_DEG;
  const p = (f: number, r: number): LonLat => [at[0] + (fE * f + rE * r) * mLon, at[1] + (fN * f + rN * r) * mLat];
  const l = lengthM / 2, w = widthM / 2;
  return [p(l, -w), p(l, w), p(-l, w), p(-l, -w)];
}

/** The picture to lay down and its size on the ground: a drawing with its shadow round it, or the photo as the body. */
interface Picture { url: string; widthM: number; lengthM: number }

/** A drawing made a PNG, its shadow under it (the image source takes no CSS filter). */
function rasterize(svg: string): Promise<Picture> {
  const w = Math.round((BOX.w + 2 * PAD_CM) * PX_PER_CM), h = Math.round((BOX.h + 2 * PAD_CM) * PX_PER_CM);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d")!;
      g.shadowColor = "rgba(0,0,0,.45)";
      g.shadowBlur = 14 * PX_PER_CM;
      g.shadowOffsetY = 4 * PX_PER_CM;
      g.drawImage(img, PAD_CM * PX_PER_CM, PAD_CM * PX_PER_CM, BOX.w * PX_PER_CM, BOX.h * PX_PER_CM);
      resolve({ url: canvas.toDataURL("image/png"), widthM: (BOX.w + 2 * PAD_CM) / 100, lengthM: (BOX.h + 2 * PAD_CM) / 100 });
    };
    img.onerror = () => reject(new Error("car drawing"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" `).replace('width="100%" height="100%"', `width="${BOX.w}" height="${BOX.h}"`))}`;
  });
}

/**
 * The car as an image source on the map, its corners moved with it each frame. Kept the top layer (a layer added
 * later — the route, the cameras — would draw over it), and put back on a new style.
 */
export class CarLayer {
  private picture: Picture | null = null;
  private at: LonLat | null = null;
  private heading = 0;
  private shown = false;
  private installed = false;
  private asked = "";

  constructor(private map: maplibregl.Map) {
    map.on("style.load", () => { this.installed = false; this.install(); });
    map.on("idle", () => this.install());
    map.on("styledata", () => this.keepOnTop());
  }

  /** The look: drawn in [paint], the arrow, or the server's photo (falling back to the drawing where there is none). */
  set(icon: CarIcon, paint: string) {
    const key = `${icon}:${paint}`;
    if (key === this.asked) return;
    this.asked = key;
    const made = icon === "photo"
      ? Promise.resolve<Picture>({ url: "/api/car-icon", widthM: CAR_WIDTH_M, lengthM: CAR_LENGTH_M })
      : rasterize(carSvg(icon, paint));
    void made.then((p) => {
      if (key !== this.asked) return;
      this.picture = p;
      const source = this.source();
      if (source && this.at) source.updateImage({ url: p.url, coordinates: carCorners(this.at, this.heading, p.widthM, p.lengthM) });
      else this.install();
    }, () => {});
  }

  /** Where the car is and the way it faces: the corners moved, nothing else. */
  place(at: LonLat, headingDeg = this.heading) {
    this.at = at;
    this.heading = headingDeg;
    const source = this.source();
    if (source && this.picture) source.setCoordinates(carCorners(at, headingDeg, this.picture.widthM, this.picture.lengthM));
    else this.install();
  }

  show(on = true) {
    this.shown = on;
    if (this.installed) this.map.setLayoutProperty("car", "visibility", on ? "visible" : "none");
  }

  private source(): maplibregl.ImageSource | null {
    return this.installed ? (this.map.getSource("car") as maplibregl.ImageSource | undefined) ?? null : null;
  }

  private install() {
    if (this.installed || !this.picture || !this.at) return;
    try {
      if (!this.map.getSource("car")) this.map.addSource("car", { type: "image", url: this.picture.url, coordinates: carCorners(this.at, this.heading, this.picture.widthM, this.picture.lengthM) });
      if (!this.map.getLayer("car")) {
        this.map.addLayer({
          id: "car", type: "raster", source: "car",
          layout: { visibility: this.shown ? "visible" : "none" },
          paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
        });
      }
      this.installed = true;
    } catch { /* the style not in yet: idle tries again */ }
  }

  private keepOnTop() {
    if (!this.installed) return;
    try {
      const order = this.map.getLayersOrder();
      if (order[order.length - 1] !== "car" && order.includes("car")) this.map.moveLayer("car");
    } catch { /* between styles */ }
  }
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
