import { type LonLat, type Route, type RouteProvider, type RouteRequest, type Segment, askJson, coverPath, isMotorwayName, markMotorway } from "./types.js";

/**
 * Naver Cloud Directions 5. One `path` of [lon, lat]; guides and sections
 * point into it by index. Section congestion: 0 unknown, 1 free, 2 slow,
 * 3 congested — already our scale.
 */
interface NaverAnswer {
  code: number;
  message: string;
  route?: {
    traoptimal: {
      summary: { distance: number; duration: number };
      path: LonLat[];
      guide: { pointIndex: number; type: number; instructions: string; distance: number }[];
      /** The main roads on the way, each named. */
      section: { pointIndex: number; pointCount: number; congestion: number; name?: string }[];
    }[];
  };
}

export class Naver implements RouteProvider {
  readonly name = "naver" as const;
  constructor(private clientId: () => string | undefined, private clientSecret: () => string | undefined) {}
  get ready() {
    return !!this.clientId() && !!this.clientSecret();
  }

  async route({ start, goal }: RouteRequest): Promise<Route> {
    const url = new URL("https://maps.apigw.ntruss.com/map-direction/v1/driving");
    url.searchParams.set("start", `${start[0]},${start[1]}`);
    url.searchParams.set("goal", `${goal[0]},${goal[1]}`);
    url.searchParams.set("option", "traoptimal");
    const answer = await askJson<NaverAnswer>(
      url.toString(),
      {
        headers: {
          "x-ncp-apigw-api-key-id": this.clientId()!,
          "x-ncp-apigw-api-key": this.clientSecret()!,
        },
      },
      this.name,
    );
    const first = answer.route?.traoptimal?.[0];
    if (answer.code !== 0 || !first) throw new Error(`naver: ${answer.message}`);
    const route: Route = {
      provider: this.name,
      distanceM: first.summary.distance,
      // Naver's duration is milliseconds.
      durationS: Math.round(first.summary.duration / 1000),
      path: first.path,
      guides: first.guide.map((g) => ({
        at: first.path[g.pointIndex],
        text: g.instructions,
        distanceM: g.distance,
        turnType: g.type,
      })),
      // The sections name the main roads only; the rest of the path is drawn as unknown, not left out.
      segments: coverPath(first.section.map((s) => ({
        from: s.pointIndex,
        to: s.pointIndex + s.pointCount,
        congestion: Math.min(3, Math.max(0, s.congestion)) as Segment["congestion"],
      })), first.path.length),
    };
    // The named sections and the stretches between a guide's "고속도로 진입" and its exit, joined in order.
    const stretches: [number, number][] = [
      ...first.section.filter((s) => isMotorwayName(s.name)).map((s): [number, number] => [s.pointIndex, s.pointIndex + s.pointCount]),
      ...motorwaysByGuides(first.guide, first.path.length),
    ].sort((a, b) => a[0] - b[0]);
    for (const [from, to] of stretches) markMotorway(route, from, to);
    return route;
  }
}

const ENTER = /(고속도로|고속화도로|도시고속도로|자동차전용도로)\s*(진입|입구)/;
const EXIT = /출구|진출/;
const TOWN = /좌회전|우회전|유턴|사거리|삼거리|오거리|교차로/;

/**
 * The stretches on a motorway by the guides: from "고속도로 진입" to the
 * next exit, or to the next guide only a town road has (a 좌회전, a
 * 사거리). Naver's sections name only the main roads of a long trip:
 * 서울역 → 해운대 had none for its first 82 km, 경부 and 영동 included,
 * and every motorway rule (rest areas, junction pictures, no school zones)
 * missed them.
 */
export function motorwaysByGuides(guides: { pointIndex: number; instructions: string }[], pathLength: number): [number, number][] {
  const out: [number, number][] = [];
  let from: number | null = null;
  for (const g of guides) {
    // The action, not the names it points to: "'만덕센텀고속화도로, 해운대, 교대교차로' 방면으로 왼쪽 방향" is no 교차로.
    const said = g.instructions.replace(/'[^']*'/g, "");
    if (from == null) {
      if (ENTER.test(said)) from = g.pointIndex;
    } else if (EXIT.test(said) || TOWN.test(said)) {
      out.push([from, g.pointIndex]);
      from = null;
    }
  }
  if (from != null) out.push([from, pathLength - 1]);
  return out;
}
