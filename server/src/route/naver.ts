import { askJson, type LonLat, type Route, type RouteProvider, type RouteRequest, type Segment } from "./types.js";

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
      section: { pointIndex: number; pointCount: number; congestion: number }[];
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
    return {
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
      segments: first.section.map((s) => ({
        from: s.pointIndex,
        to: s.pointIndex + s.pointCount,
        congestion: Math.min(3, Math.max(0, s.congestion)) as Segment["congestion"],
      })),
    };
  }
}
