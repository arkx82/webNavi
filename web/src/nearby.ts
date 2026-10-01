import type maplibregl from "maplibre-gl";
import { api } from "./api";
import { CATEGORIES, FUELS, LOOK, icon } from "./categories";
import { Line, metres } from "./geo";
import { fakeNearby } from "./nearby-demo";
import { PinLayer, type Pin } from "./pin-layer";
import type { Category, Fuel, Health, LonLat, Place, Poi, Route } from "./types";

/**
 * The car apps' 주변: buttons that put one kind of place on the map, each
 * as a pin — fuel with its price on it, chargers with how many are free —
 * and a list in the right column, nearest or cheapest first. Several kinds
 * can be on at once. Tapping a pin or a row opens the place; 목적지로
 * routes there.
 *
 * While driving, 경로 위 keeps only what is on the road ahead (within
 * 300 m of the route, not behind), and asks for the stretch in front
 * rather than around the car — the TMAP "경로상 주유소".
 */
export interface NearbyHost {
  map: maplibregl.Map;
  /** The car, or the map's middle before a fix. */
  here(): LonLat;
  following(): boolean;
  route(): Route | null;
  alongM(): number | null;
  demo: boolean;
  log(text: string): void;
  /** Route to it. */
  go(place: Place): void;
  /** Show it: the map leaves the car for it. */
  look(at: LonLat): void;
  /** The sheet opened or closed; the map's right edge moves. */
  sheet(open: boolean): void;
}

type Sort = "distance" | "price";
/** Off the route by more than this, a place is not "on the way". */
const ON_ROUTE_M = 300;
const AHEAD_RADIUS_M = 3000;

interface Shown {
  poi: Poi;
  /** Metres from the car. */
  distanceM: number;
  /** Metres ahead along the route, with 경로 위 on. */
  aheadM?: number;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Nearby {
  readonly active = new Set<Category>();
  sources: Health["nearby"] | undefined;
  private fuel: Fuel = "B027";
  private sort: Sort = "distance";
  private onRoute = false;
  private results = new Map<Category, Poi[]>();
  private asked = new Map<Category, { at: LonLat; r: number; t: number; fuel: Fuel }>();
  private errors = new Map<Category, string>();
  private busy = new Set<Category>();
  private pins: PinLayer;
  /** What the pins on the map are, for a tap on one. */
  private byId = new Map<string, Poi>();
  private selected: Poi | null = null;
  private line: { route: Route; line: Line } | null = null;
  private open = false;

  constructor(private host: NearbyHost) {
    this.pins = new PinLayer(host.map, (id) => {
      const poi = this.byId.get(id);
      if (!poi) return;
      if (!this.open) this.show(true);
      this.pick(poi);
    });
    try {
      const kept = JSON.parse(localStorage.getItem("nav-nearby") ?? "{}");
      if (FUELS.some((f) => f.id === kept.fuel)) this.fuel = kept.fuel;
      if (kept.sort === "price" || kept.sort === "distance") this.sort = kept.sort;
    } catch { /* private window */ }
    this.buildChips(el("nb-cats"));
    this.buildChips(el("quick-cats"));
    this.buildOptions();
    el("nb-close").addEventListener("click", () => this.show(false));
    el("nb-back").addEventListener("click", () => this.pick(null));
    el("nb-go").addEventListener("click", () => {
      const p = this.selected;
      if (!p) return;
      this.clear();
      this.show(false);
      this.host.go({ name: p.name, address: p.address, at: p.at, category: LOOK[p.category].label });
    });
    window.setInterval(() => this.tick(), 2000);
  }

  get isOpen() {
    return this.open;
  }

  /** The trip changed (a route came or went): 경로 위 only makes sense with one. */
  refresh() {
    if (!this.host.route()) this.onRoute = false;
    this.drawOptions();
    this.drawPins();
    this.drawList();
  }

  show(open: boolean) {
    this.open = open;
    el("nearby").hidden = !open;
    if (!open) this.pick(null, false);
    else this.drawList();
    this.host.sheet(open);
  }

  toggle(category: Category) {
    if (this.active.has(category)) {
      this.active.delete(category);
    } else {
      this.active.add(category);
      this.tick();
    }
    this.drawChips();
    this.drawOptions();
    this.drawPins();
    this.drawList();
  }

  /** Every kind off, every pin gone. */
  clear() {
    this.active.clear();
    this.drawChips();
    this.drawOptions();
    this.drawPins();
  }

  // ---- asking --------------------------------------------------------------

  /** Asks again for each kind that is on, when the car or the map has moved far enough. */
  private tick() {
    // A place open on the sheet stays put: the list under it is not asked again.
    if (this.active.size === 0 || this.selected) return;
    const { at, r } = this.area();
    for (const category of this.active) {
      if (this.busy.has(category)) continue;
      const last = this.asked.get(category);
      const stale = !last
        || metres(last.at[0], last.at[1], at[0], at[1]) > last.r * 0.35
        || r > last.r * 1.6 || r < last.r / 2.5
        || (category === "gas" && last.fuel !== this.fuel)
        // Free chargers change by the minute; the rest by the day.
        || Date.now() - last.t > (category === "ev" ? 90_000 : 300_000);
      if (stale) void this.ask(category, at, r);
    }
  }

  private static readonly FAILED_RETRY_MS = 60_000;
  private async ask(category: Category, at: LonLat, r: number) {
    this.busy.add(category);
    const fuel = this.fuel;
    try {
      const found = this.host.demo ? fakeNearby(category, at, r, fuel) : await api.nearby(category, at, r, category === "gas" ? fuel : undefined);
      this.results.set(category, found);
      this.errors.delete(category);
      this.asked.set(category, { at, r, t: Date.now(), fuel });
    } catch (e) {
      this.errors.set(category, (e as Error).message);
      // Not asked again for a minute, or a missing key would be asked every two seconds (the chargers' own
      // staleness is 90 s, so their wait is set from it, not from a fixed age).
      this.asked.set(category, { at, r, t: Date.now() - (category === "ev" ? 90_000 : 300_000) + Nearby.FAILED_RETRY_MS, fuel });
      this.host.log(`주변 ${LOOK[category].label} 실패 ${(e as Error).message}`);
    } finally {
      this.busy.delete(category);
    }
    this.drawPins();
    this.drawList();
  }

  /** Where to ask: the road ahead with 경로 위, else what the screen shows. */
  private area(): { at: LonLat; r: number } {
    const ahead = this.ahead();
    if (ahead) return { at: ahead.line.place(ahead.along + AHEAD_RADIUS_M * 0.6).at, r: AHEAD_RADIUS_M };
    const map = this.host.map;
    const c = map.getCenter();
    const at: LonLat = this.host.following() ? this.host.here() : [c.lng, c.lat];
    const canvas = map.getCanvas();
    const mPerPx = (40_075_016.686 * Math.cos((at[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    // A tilted view sees further up the screen than down it.
    const r = (Math.hypot(canvas.clientWidth, canvas.clientHeight) / 2) * mPerPx * (map.getPitch() > 20 ? 1.4 : 1);
    return { at, r: Math.min(5000, Math.max(600, r)) };
  }

  private ahead(): { line: Line; along: number } | null {
    const route = this.host.route();
    const along = this.host.alongM();
    if (!this.onRoute || !route || along == null || route.path.length < 2) return null;
    if (this.line?.route !== route) this.line = { route, line: new Line(route.path) };
    return { line: this.line.line, along };
  }

  /** What is on, filtered to the road ahead if asked, with distances from the car. */
  private shown(): Shown[] {
    const here = this.host.here();
    const ahead = this.ahead();
    const out: Shown[] = [];
    for (const category of this.active) {
      for (const poi of this.results.get(category) ?? []) {
        const s: Shown = { poi, distanceM: metres(here[0], here[1], poi.at[0], poi.at[1]) };
        if (ahead) {
          const p = ahead.line.project(poi.at, 0, ahead.line.path.length);
          if (p.offM > ON_ROUTE_M || p.alongM < ahead.along - 30) continue;
          s.aheadM = p.alongM - ahead.along;
        }
        out.push(s);
      }
    }
    const by = (s: Shown) => s.aheadM ?? s.distanceM;
    if (this.sort === "price") {
      out.sort((a, b) => (a.poi.price?.won ?? Infinity) - (b.poi.price?.won ?? Infinity) || by(a) - by(b));
    } else {
      out.sort((a, b) => by(a) - by(b));
    }
    return out;
  }

  // ---- the map -------------------------------------------------------------

  private drawPins() {
    const shown = this.shown();
    const cheapest = Math.min(...shown.filter((s) => s.poi.category === "gas" && s.poi.price).map((s) => s.poi.price!.won));
    // The open place keeps its pin even when a newer answer left it out.
    if (this.selected && !shown.some((s) => s.poi.id === this.selected!.id)) shown.push({ poi: this.selected, distanceM: 0 });
    this.byId.clear();
    const pins: Pin[] = [];
    for (const { poi } of shown) {
      this.byId.set(poi.id, poi);
      const label = pinLabel(poi);
      const picked = this.selected?.id === poi.id;
      const none = !!poi.chargers && poi.chargers.fastFree + poi.chargers.slowFree === 0;
      pins.push({
        id: poi.id,
        at: poi.at,
        category: poi.category,
        label: picked ? (label ? `${poi.name} · ${label}` : poi.name) : label,
        tone: picked ? "picked" : poi.price?.won === cheapest ? "low" : none ? "none" : "plain",
      });
    }
    this.pins.set(pins);
  }

  // ---- the sheet -----------------------------------------------------------

  private buildChips(box: HTMLElement) {
    for (const c of CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.cat = c.id;
      b.style.setProperty("--c", c.color);
      b.style.setProperty("--cs", c.color + "40");
      b.innerHTML = `<span class="chip-ic">${icon(c.id, 18)}</span><span>${c.label}</span>`;
      b.addEventListener("click", () => {
        this.toggle(c.id);
        if (!this.open && this.active.has(c.id)) this.show(true);
      });
      box.append(b);
    }
  }

  private drawChips() {
    for (const b of document.querySelectorAll<HTMLElement>(".chip[data-cat]")) {
      b.classList.toggle("on", this.active.has(b.dataset.cat as Category));
    }
  }

  private buildOptions() {
    const fuels = el("nb-fuel");
    for (const f of FUELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.label;
      b.dataset.fuel = f.id;
      b.addEventListener("click", () => {
        this.fuel = f.id;
        this.save();
        this.drawOptions();
        this.tick();
      });
      fuels.append(b);
    }
    for (const b of el("nb-sort").querySelectorAll<HTMLElement>("button")) {
      b.addEventListener("click", () => {
        this.sort = b.dataset.sort as Sort;
        this.save();
        this.drawOptions();
        this.drawList();
      });
    }
    el("nb-route").addEventListener("click", () => {
      this.onRoute = !this.onRoute;
      this.drawOptions();
      this.tick();
      this.drawPins();
      this.drawList();
    });
    this.drawOptions();
  }

  private drawOptions() {
    el("nb-fuel").hidden = !this.active.has("gas");
    for (const b of el("nb-fuel").querySelectorAll<HTMLElement>("button")) b.classList.toggle("on", b.dataset.fuel === this.fuel);
    const priced = this.active.has("gas") || this.active.has("ev");
    el("nb-sort").hidden = !priced;
    if (!priced && this.sort === "price") this.sort = "distance";
    for (const b of el("nb-sort").querySelectorAll<HTMLElement>("button")) b.classList.toggle("on", b.dataset.sort === this.sort);
    el("nb-route").hidden = !this.host.route();
    el("nb-route").classList.toggle("on", this.onRoute);
  }

  private save() {
    try { localStorage.setItem("nav-nearby", JSON.stringify({ fuel: this.fuel, sort: this.sort })); } catch { /* private window */ }
  }

  private drawList() {
    if (!this.open || this.selected) return;
    this.drawOptions();
    const ul = el<HTMLUListElement>("nb-list");
    ul.replaceChildren();
    const msg: string[] = [];
    if (this.active.size === 0) msg.push("위에서 찾을 곳을 고르세요. 여러 개를 함께 켤 수 있습니다.");
    for (const [category, error] of this.errors) {
      if (this.active.has(category)) msg.push(`${LOOK[category].label}: ${/no key/.test(error) ? "서버에 키가 없습니다 (/admin)" : error}`);
    }
    if (this.active.has("gas") && this.sources?.gas === "kakao") msg.push("주유 가격은 오피넷 키가 있어야 나옵니다 (/admin).");
    if (this.active.has("ev") && this.sources?.ev === "kakao") msg.push("빈 충전기 수는 공공데이터포털 키가 있어야 나옵니다 (/admin).");
    const shown = this.shown();
    const cheapest = Math.min(...shown.filter((s) => s.poi.category === "gas" && s.poi.price).map((s) => s.poi.price!.won));
    if (this.active.size && shown.length === 0 && this.busy.size === 0) msg.push(this.onRoute ? "경로 앞 3 km 안에 없습니다." : "이 근처에 없습니다.");
    el("nb-msg").textContent = msg.join(" ");
    for (const s of shown.slice(0, 60)) {
      const li = document.createElement("li");
      li.className = "nb-item";
      const where = s.aheadM != null ? `경로 ${km(s.aheadM)} 앞` : km(s.distanceM);
      li.innerHTML =
        `<span class="nb-ic" style="--c:${LOOK[s.poi.category].color}">${icon(s.poi.category, 18)}</span>` +
        `<div class="nb-main"><div class="nb-name"></div><div class="nb-sub"></div></div>` +
        `<div class="nb-side">${side(s.poi, s.poi.price?.won === cheapest)}</div>`;
      li.querySelector(".nb-name")!.textContent = s.poi.name;
      li.querySelector(".nb-sub")!.textContent = [where, s.poi.detail].filter(Boolean).join(" · ");
      li.addEventListener("click", () => this.pick(s.poi));
      ul.append(li);
    }
  }

  /** One place, in full; null goes back to the list. */
  private pick(poi: Poi | null, draw = true) {
    this.selected = poi;
    el("nb-listview").hidden = !!poi;
    el("nb-detail").hidden = !poi;
    this.drawPins();
    if (!poi) {
      if (draw) this.drawList();
      return;
    }
    this.host.look(poi.at);
    const here = this.host.here();
    const look = LOOK[poi.category];
    el("nb-d-ic").innerHTML = icon(poi.category, 22);
    el("nb-d-ic").style.setProperty("--c", look.color);
    el("nb-d-name").textContent = poi.name;
    el("nb-d-kind").textContent = [look.label, poi.detail].filter(Boolean).join(" · ");
    const rows: [string, string][] = [];
    rows.push(["거리", km(metres(here[0], here[1], poi.at[0], poi.at[1]))]);
    if (poi.address) rows.push(["주소", poi.address]);
    if (poi.phone) rows.push(["전화", poi.phone]);
    const c = poi.chargers;
    if (c) {
      if (c.fastTotal) rows.push(["급속", `${c.fastFree}/${c.fastTotal} 사용 가능 · 최대 ${Math.round(c.maxKw)}kW`]);
      if (c.slowTotal) rows.push(["완속", `${c.slowFree}/${c.slowTotal} 사용 가능`]);
      if (c.operator) rows.push(["운영", c.operator]);
      rows.push(["요금", c.price ? `${c.price.won.toFixed(1)}원/kWh (${c.price.label})` : "정보 없음 — 운영사 회원가는 /admin 에 적어 두면 나옵니다"]);
      if (c.parkingFree != null) rows.push(["주차", c.parkingFree ? "무료" : "유료"]);
      if (c.useTime) rows.push(["이용", c.useTime]);
    }
    this.drawRows(rows);
    const prices = el("nb-d-prices");
    prices.replaceChildren();
    prices.hidden = poi.category !== "gas" || !poi.price;
    if (poi.price && poi.category === "gas") prices.append(priceCell(poi.price.label, poi.price.won, true));
    el("nb-go").textContent = this.host.route() ? "목적지 변경" : "목적지로";
    // The list call carries one fuel; the station's own page has them all.
    if (poi.id.startsWith("opinet:")) {
      void api.gasDetail(poi.id.slice(7)).then((d) => {
        if (this.selected !== poi) return;
        prices.replaceChildren(...d.prices.map((p) => priceCell(p.label, p.won, p.label === poi.price?.label)));
        prices.hidden = d.prices.length === 0;
        const more: [string, string][] = rows.filter(([k]) => k !== "주소" && k !== "전화");
        if (d.address) more.push(["주소", d.address]);
        if (d.phone) more.push(["전화", d.phone]);
        if (d.extras.length) more.push(["시설", d.extras.join(" · ")]);
        this.drawRows(more);
      }).catch((e) => this.host.log(`주유소 상세 실패 ${(e as Error).message}`));
    }
  }

  private drawRows(rows: [string, string][]) {
    const dl = el("nb-d-rows");
    dl.replaceChildren();
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
  }
}

function pinLabel(poi: Poi): string {
  const c = poi.chargers;
  if (c) return c.fastTotal ? `급속 ${c.fastFree}/${c.fastTotal}` : c.slowTotal ? `완속 ${c.slowFree}/${c.slowTotal}` : "";
  if (poi.price) return poi.price.won.toLocaleString("ko-KR");
  return "";
}

/** The right-hand side of a row: the price for fuel, free chargers for a station, else nothing. */
function side(poi: Poi, cheapest: boolean): string {
  const c = poi.chargers;
  if (c) {
    const [free, total, kind] = c.fastTotal ? [c.fastFree, c.fastTotal, "급속"] : [c.slowFree, c.slowTotal, "완속"];
    const won = c.price ? `<small>${Math.round(c.price.won)}원</small>` : "";
    return `<b class="${free ? "free" : "busy"}">${free}/${total}</b><small>${kind}</small>${won}`;
  }
  if (poi.price) return `${cheapest ? `<span class="low-tag">최저</span>` : ""}<b>${poi.price.won.toLocaleString("ko-KR")}</b><small>원</small>`;
  return "";
}

function priceCell(label: string, won: number, on: boolean): HTMLElement {
  const d = document.createElement("div");
  d.className = "price" + (on ? " on" : "");
  d.innerHTML = `<small></small><b>${won.toLocaleString("ko-KR")}</b>`;
  d.querySelector("small")!.textContent = label;
  return d;
}

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
