import { askJson, isMotorwayName, markMotorway, type LonLat, type Route, type RouteProvider, type RouteRequest, type Segment } from "./types.js";

/**
 * Kakao Mobility directions. Roads come as flat `vertexes` [x, y, x, y, …]
 * with a `traffic_state` each: 0 unknown, 1 congested, 2 delayed, 3 slow,
 * 4 free. Guides carry their own x/y.
 */
interface KakaoAnswer {
  routes: {
    result_code: number;
    result_msg: string;
    summary: { distance: number; duration: number };
    sections: {
      roads: { vertexes: number[]; traffic_state: number; name?: string }[];
      guides: { x: number; y: number; name: string; guidance: string; distance: number; type: number }[];
    }[];
  }[];
}

export class Kakao implements RouteProvider {
  readonly name = "kakao" as const;
  constructor(private restKey: () => string | undefined) {}
  get ready() {
    return !!this.restKey();
  }

  async route({ start, goal, heading }: RouteRequest): Promise<Route> {
    const url = new URL("https://apis-navi.kakaomobility.com/v1/directions");
    url.searchParams.set("origin", `${start[0]},${start[1]}${heading != null ? `,angle=${Math.round(heading)}` : ""}`);
    url.searchParams.set("destination", `${goal[0]},${goal[1]}`);
    url.searchParams.set("priority", "RECOMMEND");
    url.searchParams.set("road_details", "true");
    const answer = await askJson<KakaoAnswer>(
      url.toString(),
      { headers: { Authorization: `KakaoAK ${this.restKey()}` } },
      this.name,
    );
    const first = answer.routes[0];
    if (!first || first.result_code !== 0) {
      throw new Error(`kakao: ${first?.result_msg ?? "no route"}`);
    }
    const route: Route = {
      provider: this.name,
      distanceM: first.summary.distance,
      durationS: first.summary.duration,
      path: [], guides: [], segments: [],
    };
    for (const section of first.sections) {
      for (const road of section.roads) {
        const base = route.path.length;
        for (let i = 0; i + 1 < road.vertexes.length; i += 2) {
          route.path.push([road.vertexes[i], road.vertexes[i + 1]] as LonLat);
        }
        route.segments.push({ from: base, to: route.path.length, congestion: kakaoCongestion(road.traffic_state) });
        if (isMotorwayName(road.name)) markMotorway(route, base, route.path.length);
      }
      for (const guide of section.guides) {
        route.guides.push({
          at: [guide.x, guide.y],
          text: guide.guidance || guide.name,
          name: guide.name && guide.name !== guide.guidance ? guide.name : undefined,
          distanceM: guide.distance,
          turnType: guide.type,
        });
      }
    }
    return route;
  }
}

function kakaoCongestion(state: number): Segment["congestion"] {
  switch (state) {
    case 4: return 1;
    case 3: return 2;
    case 1: case 2: return 3;
    default: return 0;
  }
}
