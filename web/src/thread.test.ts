import { test } from "node:test";
import assert from "node:assert/strict";
import { applySnap, headingsOf, splice, turnsOf } from "./thread.js";
import type { LonLat, Route } from "./types.js";

/** Metres east/north of 강남역 as lon/lat. */
const at = (x: number, y: number): LonLat => [127.0276 + x / (111_320 * Math.cos((37.4979 * Math.PI) / 180)), 37.4979 + y / 111_320];

function corner(): Route {
  // North 200 m, then a right turn east 200 m: the provider's line cuts the corner at one vertex.
  const path = [at(0, 0), at(0, 100), at(0, 200), at(100, 200), at(200, 200)];
  return {
    provider: "kakao", distanceM: 400, durationS: 60, path,
    guides: [{ at: at(0, 200), text: "우회전", distanceM: 200, turnType: 2 }, { at: at(200, 200), text: "도착", distanceM: 0, turnType: 101 }],
    segments: [{ from: 0, to: 2, congestion: 1 }, { from: 2, to: 5, congestion: 3 }],
    motorways: [[3, 5]],
  };
}

test("a guide where the line bends is a turn to thread, with the way in and the route after it", () => {
  const turns = turnsOf(corner());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].guide, 0);
  assert.ok(Math.abs(turns[0].turn.in - 0) < 2, `${turns[0].turn.in}`);
  assert.equal(turns[0].turn.after.length, 11);
});

test("the painted arc takes the place of the cut corner, and the indices into the path move with it", () => {
  const r = corner();
  // The lane's arc: from the stop line 20 m short of the corner, round to 20 m past it, then on along the route.
  const trail: LonLat[] = [at(0, 180), at(3, 190), at(8, 197), at(15, 200), at(25, 200), at(60, 200)];
  assert.ok(splice(r, trail));
  assert.ok(r.path.length > 5);
  // The corner's vertex is gone; the arc's points are in; the line still ends where it did.
  assert.ok(!r.path.some((p) => p[0] === at(0, 200)[0] && p[1] === at(0, 200)[1]));
  assert.deepEqual(r.path[r.path.length - 1], at(200, 200));
  // The congested part still ends at the path's end, and the motorway still ends there.
  assert.equal(r.segments[r.segments.length - 1].to, r.path.length);
  assert.equal(r.motorways![0][1], r.path.length);
  // A trail that starts nowhere near the route is refused, and the route is left alone.
  const before = r.path.length;
  assert.ok(!splice(r, [at(500, 500), at(520, 500), at(560, 500)]));
  assert.equal(r.path.length, before);
});

test("the line slides onto the lanes where they are and off them without a jog", () => {
  // Ten vertices 20 m apart heading north; lanes 4 m to the right for the middle four.
  const path: LonLat[] = Array.from({ length: 10 }, (_, i) => at(0, i * 20));
  const snapped: (LonLat | null)[] = path.map((p, i) => (i >= 3 && i <= 6 ? at(4, i * 20) : null));
  const moved = applySnap(path, snapped);
  const dx = (i: number) => (moved[i][0] - path[i][0]) * 111_320 * Math.cos((37.4979 * Math.PI) / 180);
  assert.ok(Math.abs(dx(4) - 4) < 0.01, "on the lanes: the full 4 m");
  assert.ok(Math.abs(dx(2) - 4 * (1 - 20 / 60)) < 0.01, "20 m before them: two thirds of the way");
  assert.ok(Math.abs(dx(1) - 4 * (1 - 40 / 60)) < 0.01, "40 m before: a third");
  assert.ok(Math.abs(dx(0)) < 0.01 && Math.abs(dx(9)) < 0.01, "far from them: as drawn");
  assert.equal(headingsOf(path).filter((h) => Math.abs(h) < 0.5).length, 10);
});
