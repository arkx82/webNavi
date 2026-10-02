import { askJson, isMotorwayName, markMotorway, type LonLat, type Route, type RouteProvider, type RouteRequest, type Segment } from "./types.js";

/**
 * TMAP car route (SK open API). The answer is a GeoJSON FeatureCollection:
 * Point features are turn guides, LineString features are the road between
 * them. With trafficInfo=Y each LineString's *geometry* (not its
 * properties) carries `traffic`: rows of [fromIndex, toIndex, congestion,
 * speed], congestion 0..4 (0 unknown, 1 free, 2 slow, 3 delayed —
 * deprecated, 4 congested).
 */
interface TmapFeature {
  geometry: { type: "Point"; coordinates: LonLat } | { type: "LineString"; coordinates: LonLat[]; traffic?: number[][] };
  properties: {
    totalDistance?: number;
    totalTime?: number;
    description?: string;
    turnType?: number;
    distance?: number;
    traffic?: number[][];
    /** The road's name, and its class: 0 고속국도, 1 도시고속화도로, 2 국도 … */
    name?: string;
    roadType?: number;
  };
}

export class Tmap implements RouteProvider {
  readonly name = "tmap" as const;
  constructor(private appKey: () => string | undefined) {}
  get ready() {
    return !!this.appKey();
  }

  async route({ start, goal, heading, speedKmh }: RouteRequest): Promise<Route> {
    const answer = await askJson<{ features: TmapFeature[] }>(
      "https://apis.openapi.sk.com/tmap/routes?version=1",
      {
        method: "POST",
        headers: { appKey: this.appKey()!, "Content-Type": "application/json" },
        body: JSON.stringify({
          startX: start[0], startY: start[1], endX: goal[0], endY: goal[1],
          reqCoordType: "WGS84GEO", resCoordType: "WGS84GEO",
          searchOption: "0", trafficInfo: "Y",
          ...(heading != null ? { angle: Math.round(heading), speed: Math.round(speedKmh ?? 0) } : {}),
        }),
      },
      this.name,
    );
    const route: Route = { provider: this.name, distanceM: 0, durationS: 0, path: [], guides: [], segments: [] };
    for (const feature of answer.features) {
      const p = feature.properties;
      if (p.totalDistance != null) route.distanceM = p.totalDistance;
      if (p.totalTime != null) route.durationS = p.totalTime;
      if (feature.geometry.type === "Point") {
        route.guides.push({
          at: feature.geometry.coordinates,
          text: facilityText(p.description ?? "", p.turnType ?? 0),
          distanceM: p.distance ?? 0,
          turnType: p.turnType ?? 0,
        });
      } else {
        const base = route.path.length;
        route.path.push(...feature.geometry.coordinates);
        if (p.roadType === 0 || p.roadType === 1 || isMotorwayName(p.name)) markMotorway(route, base, route.path.length);
        const rows = feature.geometry.traffic ?? p.traffic ?? [];
        if (rows.length === 0) {
          route.segments.push({ from: base, to: route.path.length, congestion: 0 });
        }
        for (const [from, to, level] of rows) {
          route.segments.push({ from: base + from, to: base + to + 1, congestion: tmapCongestion(level) });
        }
      }
    }
    return route;
  }
}

function tmapCongestion(level: number): Segment["congestion"] {
  switch (level) {
    case 1: return 1;
    case 2: return 2;
    case 3: case 4: return 3;
    default: return 0;
  }
}

/** TMAP's 지하차도, 고가도로, 터널, 교량 and the side roads (turnType 119–124), as the action the words leave out. */
const FACILITY_ACTION: Record<number, string> = { 119: "지하차도 진입", 120: "고가차도 진입", 121: "터널 진입", 122: "교량 진입", 123: "지하차도 옆길", 124: "고가차도 옆길" };

/**
 * TMAP names the thing where a verb belongs ("미사 지하차도에서 광주,양평
 * 방면으로 지하차도 후 …", "터널에서 터널 후 …"): the action put right,
 * and a place that only repeats it dropped ("터널 진입 후 …").
 */
export function facilityText(text: string, turnType: number): string {
  const action = FACILITY_ACTION[turnType];
  if (!action) return text;
  const tail = text.match(/\s+후\s+.*$/)?.[0] ?? "";
  let head = text.slice(0, text.length - tail.length).replace(/\s*(지하차도|고가도로|고가차도|터널|교량)\s*옆?\s*$/, "").trim();
  // "터널에서" with nothing more: the place is the thing itself.
  head = head.replace(/^(지하차도|고가도로|고가차도|터널|교량)에서$/, "");
  return `${head ? `${head} ` : ""}${action}${tail}`;
}
