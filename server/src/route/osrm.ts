import { askJson, type LonLat, type Route, type RouteProvider, type RouteRequest } from "./types.js";

/**
 * OSRM's public demo server: OpenStreetMap roads, no key, no traffic. Not
 * a way to drive by — the demo server promises nothing — but a real road
 * under the car before any key exists, so matching, guides and warnings
 * can be tried. Guide text is made here from the manoeuvre, in Korean.
 */
interface OsrmAnswer {
  code: string;
  message?: string;
  routes: {
    distance: number;
    duration: number;
    geometry: { coordinates: LonLat[] };
    legs: {
      steps: {
        maneuver: { location: LonLat; type: string; modifier?: string; exit?: number };
        name: string;
        distance: number;
      }[];
    }[];
  }[];
}

export class Osrm implements RouteProvider {
  /**
   * [name] "osrm": the public demo server, always offered, the provider of
   * last resort. "korea": the same engine on this host over 표준노드링크
   * (KOREA_OSRM_URL, docker compose's osrm service), offered when that is set.
   */
  constructor(private base = "https://router.project-osrm.org", readonly name: "osrm" | "korea" = "osrm", private readonly on = true) {}
  get ready() {
    return this.on;
  }

  async route({ start, goal }: RouteRequest): Promise<Route> {
    const url = `${this.base}/route/v1/driving/${start[0]},${start[1]};${goal[0]},${goal[1]}?overview=full&geometries=geojson&steps=true`;
    const answer = await askJson<OsrmAnswer>(url, { headers: { "User-Agent": "WebNavi (personal)" } }, this.name);
    const first = answer.routes?.[0];
    if (answer.code !== "Ok" || !first) throw new Error(`osrm: ${answer.message ?? answer.code}`);
    const guides = first.legs.flatMap((leg) =>
      leg.steps
        .filter((s) => s.maneuver.type !== "depart")
        .map((s) => ({
          at: s.maneuver.location,
          text: korean(s.maneuver.type, s.maneuver.modifier, s.maneuver.exit, s.name),
          distanceM: s.distance,
          turnType: `${s.maneuver.type}/${s.maneuver.modifier ?? ""}`,
        })),
    );
    return {
      provider: this.name,
      distanceM: first.distance,
      durationS: first.duration,
      path: first.geometry.coordinates,
      guides,
      segments: [{ from: 0, to: first.geometry.coordinates.length, congestion: 0 }],
    };
  }
}

/** The manoeuvre as a Korean phrase, the way the car apps say it. */
export function korean(type: string, modifier?: string, exit?: number, road?: string): string {
  const onto = road ? `${road} 방면 ` : "";
  const turn = (m?: string) => {
    switch (m) {
      case "left": return "좌회전";
      case "right": return "우회전";
      case "slight left": return "왼쪽 방향";
      case "slight right": return "오른쪽 방향";
      case "sharp left": return "급좌회전";
      case "sharp right": return "급우회전";
      case "uturn": return "유턴";
      case "straight": return "직진";
      default: return "직진";
    }
  };
  switch (type) {
    case "arrive": return "목적지 도착";
    case "roundabout": case "rotary": return `회전교차로에서 ${exit ?? ""}번째 출구`;
    case "merge": return `${onto}합류`;
    case "on ramp": return `${onto}진입`;
    case "off ramp": return `${onto}${modifier?.includes("left") ? "왼쪽" : "오른쪽"} 출구`;
    case "fork": return `${onto}${modifier?.includes("left") ? "왼쪽" : "오른쪽"} 길`;
    case "end of road": return `길 끝에서 ${turn(modifier)}`;
    case "continue": case "new name": return `${onto}직진`;
    default: return `${onto}${turn(modifier)}`;
  }
}
