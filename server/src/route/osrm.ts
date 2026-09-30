import { askJson, type Congestion, type LonLat, type Route, type RouteProvider, type RouteRequest, type Segment } from "./types.js";
import type { LinkBook } from "../road/traffic.js";
import { koreanNumbers } from "../phrases.js";

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
      /** Per segment of the leg's geometry (annotations=nodes,speed,datasources): the node ids, m/s, and 0 for the profile's speed or 1+ for a speed file's. */
      annotation?: { nodes: number[]; speed: number[]; datasources: number[] };
    }[];
  }[];
}

/** 표준노드링크 node ids are ten digits; a link's inner vertices are numbered above. */
const MOCT_NODE_MAX = 1e10;

/**
 * The route's congestion from OSRM's per-segment annotation: where a
 * segment's speed came from the live speed file, it is set against the
 * link's limit (the link found from the 표준노드링크 nodes at its ends);
 * where it came from the profile, nothing is known. Runs of the same
 * value become one segment.
 */
export function congestionOf(nodes: number[], speed: number[], datasources: number[], limitOf: (f: number, t: number) => number | null): Segment[] {
  const out: Segment[] = [];
  let limit: number | null = null, linkEnd = -1;
  for (let i = 0; i < speed.length; i++) {
    if (i > linkEnd) {
      // The link this segment is on: from the 표준노드링크 node here to the next one along.
      limit = null;
      linkEnd = i;
      if (nodes[i] < MOCT_NODE_MAX) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (nodes[j] < MOCT_NODE_MAX) { limit = limitOf(nodes[i], nodes[j]); linkEnd = j - 1; break; }
        }
      }
    }
    let c: Congestion = 0;
    if (datasources[i] > 0 && limit) {
      const ratio = (speed[i] * 3.6) / limit;
      c = ratio < 0.3 ? 3 : ratio < 0.6 ? 2 : 1;
    }
    const last = out[out.length - 1];
    if (last && last.congestion === c && last.to === i) last.to = i + 1;
    else out.push({ from: i, to: i + 1, congestion: c });
  }
  return out;
}

export class Osrm implements RouteProvider {
  /**
   * [name] "osrm": the public demo server, always offered, the provider of
   * last resort. "korea": the same engine on this host over 표준노드링크
   * (KOREA_OSRM_URL, docker compose's osrm service), offered when that is set.
   */
  constructor(private base = "https://router.project-osrm.org", readonly name: "osrm" | "korea" = "osrm", private readonly on = true, private readonly links: LinkBook | null = null) {}
  get ready() {
    return this.on;
  }

  async route({ start, goal }: RouteRequest): Promise<Route> {
    const annotate = this.links ? "&annotations=nodes,speed,datasources" : "";
    const url = `${this.base}/route/v1/driving/${start[0]},${start[1]};${goal[0]},${goal[1]}?overview=full&geometries=geojson&steps=true${annotate}`;
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
      segments: this.segmentsOf(first),
    };
  }

  /** Live congestion where the graph carries it (korea, with links.db); else one unknown segment. */
  private segmentsOf(route: OsrmAnswer["routes"][number]): Segment[] {
    const a = route.legs[0]?.annotation;
    const n = route.geometry.coordinates.length;
    if (this.links && a && a.nodes.length === n && a.speed.length === n - 1 && a.datasources.length === n - 1) {
      return congestionOf(a.nodes, a.speed, a.datasources, (f, t) => this.links!.between(f, t)?.maxspd ?? null);
    }
    return [{ from: 0, to: n, congestion: 0 }];
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
    case "roundabout": case "rotary": return exit ? `회전교차로에서 ${koreanNumbers(`${exit}번째`)} 출구` : "회전교차로 출구";
    case "merge": return `${onto}합류`;
    case "on ramp": return `${onto}진입`;
    case "off ramp": return `${onto}${modifier?.includes("left") ? "왼쪽" : "오른쪽"} 출구`;
    case "fork": return `${onto}${modifier?.includes("left") ? "왼쪽" : "오른쪽"} 길`;
    case "end of road": return `길 끝에서 ${turn(modifier)}`;
    case "continue": case "new name": return `${onto}직진`;
    default: return `${onto}${turn(modifier)}`;
  }
}
