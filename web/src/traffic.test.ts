import { test } from "node:test";
import assert from "node:assert/strict";
import { repaint } from "./traffic";
import type { LonLat, Route } from "./types";

const at = (x: number, y: number): LonLat => [127.0276 + x / (111_320 * Math.cos((37.4979 * Math.PI) / 180)), 37.4979 + y / 111_320];
const north = (from: number, to: number, step = 50) => { const p: LonLat[] = []; for (let y = from; y <= to; y += step) p.push(at(0, y)); return p; };

function driven(): Route {
  // 1 km north, all of it jammed when it was asked.
  const path = north(0, 1000);
  return { provider: "tmap", distanceM: 1000, durationS: 600, path, guides: [], segments: [{ from: 0, to: path.length, congestion: 3 }] };
}

test("the stretch ahead takes the fresh traffic; behind the car it stays as it was", () => {
  const cur = driven();
  // Asked again from 400 m: free-flowing to 700 m, still jammed after, its own vertices 2 m to the side.
  const fresh: Route = { provider: "tmap", distanceM: 600, durationS: 200, path: north(400, 1000).map(([x, y]) => [x + 0.00002, y]), guides: [],
    segments: [{ from: 0, to: 6, congestion: 1 }, { from: 6, to: 13, congestion: 3 }] };
  const r = repaint(cur, fresh, 400);
  assert.ok(r.same);
  assert.ok(r.changed > 0);
  const levelAt = (y: number) => { const i = cur.path.findIndex((p) => Math.abs(p[1] - at(0, y)[1]) < 1e-7); return cur.segments.find((s) => i >= s.from && i < s.to)!.congestion; };
  assert.equal(levelAt(100), 3, "behind the car");
  assert.equal(levelAt(500), 1, "ahead, now free");
  assert.equal(levelAt(900), 3, "still jammed further on");
  // Every vertex has a level, the last segment ends at the path's end.
  assert.equal(cur.segments[0].from, 0);
  assert.equal(cur.segments[cur.segments.length - 1].to, cur.path.length);
});

test("a fresh route that goes another way is not painted onto the driven one", () => {
  const cur = driven();
  const east: LonLat[] = []; for (let x = 0; x <= 600; x += 50) east.push(at(x, 400));
  const fresh: Route = { provider: "tmap", distanceM: 600, durationS: 200, path: east, guides: [], segments: [{ from: 0, to: east.length, congestion: 1 }] };
  const r = repaint(cur, fresh, 400);
  assert.equal(r.same, false);
  assert.deepEqual(cur.segments, [{ from: 0, to: cur.path.length, congestion: 3 }]);
});
