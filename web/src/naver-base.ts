import type maplibregl from "maplibre-gl";

/**
 * NAVER's map as the ground, the same way as TMAP's (tmap-base.ts): under
 * MapLibre's transparent canvas, copying its camera on every move.
 *
 * NAVER's GL mode is mapbox-gl-js inside (its bundle says so), with NAVER's
 * zoom handed to it unchanged, so its camera is MapLibre's camera — the
 * fork's parent: measured 0 px apart at 0–60° of tilt and any bearing.
 * The camera is set on that inner map (getMapbox), which takes fractional
 * zoom, pitch and bearing in one jump; NAVER's own API has setTilt and
 * setRotation only undocumented, so they are the fallback.
 *
 * Needs, on the NCP console: the Maps application with "Dynamic Map"
 * ticked, and this site's address (http://localhost:8088, the NUC's https
 * domain) as a Web 서비스 URL. Otherwise NAVER answers 401 and calls
 * window.navermap_authFailure, and the app goes back to another ground.
 */
interface InnerMap {
  jumpTo(options: { center: [number, number]; zoom: number; bearing: number; pitch: number }): void;
  resize(): void;
}
interface NaverMap {
  getMapbox?(): InnerMap | null;
  _mapModel?: { getMapbox?(): InnerMap | null };
  setCenter(c: unknown): void;
  setZoom(z: number, animate?: boolean): void;
  setTilt?(t: number): void;
  setRotation?(r: number): void;
  destroy(): void;
}
declare global {
  interface Window {
    naver?: { maps?: { Map: new (div: HTMLElement, options: Record<string, unknown>) => NaverMap; LatLng: new (lat: number, lng: number) => unknown } };
    navermap_authFailure?: () => void;
    naverRefused?: boolean;
  }
}

export function naverAvailable(): boolean {
  return typeof window.naver?.maps?.Map === "function" && !window.naverRefused;
}

export class NaverBase {
  private naver: NaverMap;
  private readonly sync = () => this.copy();
  private readonly fit = () => this.inner()?.resize();

  constructor(private box: HTMLElement, private map: maplibregl.Map) {
    box.hidden = false;
    // NAVER sets its own container to position:relative, which would take
    // an absolutely placed box to zero height (and a 160 px map, 420 px off
    // MapLibre's). So it gets a child that fills the box instead.
    const inside = document.createElement("div");
    inside.style.cssText = "width:100%;height:100%";
    box.append(inside);
    const c = map.getCenter();
    const maps = window.naver!.maps!;
    this.naver = new maps.Map(inside, {
      gl: true,
      center: new maps.LatLng(c.lat, c.lng),
      zoom: map.getZoom(),
      // Every gesture is MapLibre's, on top.
      draggable: false, pinchZoom: false, scrollWheel: false, keyboardShortcuts: false, disableDoubleClickZoom: true,
      disableDoubleTapZoom: true, disableTwoFingerTapZoom: true,
      scaleControl: false, mapDataControl: false, zoomControl: false, mapTypeControl: false,
    });
    map.on("move", this.sync);
    map.on("resize", this.fit);
    this.copy();
  }

  private inner(): InnerMap | null {
    return this.naver.getMapbox?.() ?? this.naver._mapModel?.getMapbox?.() ?? null;
  }

  private copy() {
    const c = this.map.getCenter();
    const camera = { center: [c.lng, c.lat] as [number, number], zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
    const inner = this.inner();
    if (inner) return inner.jumpTo(camera);
    // Before the GL map is up, or if NAVER moves it: its own calls.
    this.naver.setCenter(new window.naver!.maps!.LatLng(c.lat, c.lng));
    this.naver.setZoom(camera.zoom, false);
    this.naver.setTilt?.(camera.pitch);
    this.naver.setRotation?.(camera.bearing);
  }

  destroy() {
    this.map.off("move", this.sync);
    this.map.off("resize", this.fit);
    this.naver.destroy();
    this.box.replaceChildren();
    this.box.hidden = true;
  }
}
