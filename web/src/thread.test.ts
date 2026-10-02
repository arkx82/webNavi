import { test } from "node:test";
import assert from "node:assert/strict";
import { applySnap, headingsOf, roundCorners, splice, turnsOf } from "./thread.js";
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

test("a guide's vertex the provider repeats gets one heading for both copies, not the road in and the road out", () => {
  const h = headingsOf([at(0, 0), at(0, 100), at(0, 100), at(100, 100)]);
  assert.ok(Math.abs(h[1] - 45) < 0.5 && Math.abs(h[2] - 45) < 0.5, JSON.stringify(h));
});

test("a snap out of step with its neighbours is passed over, and a snap is only ever sideways", () => {
  const path: LonLat[] = Array.from({ length: 10 }, (_, i) => at(0, i * 20));
  const dx = (moved: LonLat[], i: number) => (moved[i][0] - path[i][0]) * 111_320 * Math.cos((37.4979 * Math.PI) / 180);
  const dy = (moved: LonLat[], i: number) => (moved[i][1] - path[i][1]) * 111_320;
  // Lanes 4 m right for vertices 3–6, but vertex 5 "found" a lane 16 m over (a crossing road's): it goes with its neighbours.
  const snapped: (LonLat | null)[] = path.map((p, i) => (i >= 3 && i <= 6 ? at(i === 5 ? 16 : 4, i * 20) : null));
  const moved = applySnap(path, snapped);
  assert.ok(Math.abs(dx(moved, 5) - 4) < 0.01, `${dx(moved, 5)}`);
  // A lane's nearest point 6 m behind a vertex moves it sideways only.
  const behind: (LonLat | null)[] = path.map((p, i) => (i === 4 ? at(4, 74) : null));
  const slid = applySnap(path, behind);
  assert.ok(Math.abs(dx(slid, 4) - 4) < 0.01 && Math.abs(dy(slid, 4)) < 0.01, `${dx(slid, 4)}, ${dy(slid, 4)}`);
  // Two neighbours out of step with each other: the one further from the line as drawn goes.
  const pair: (LonLat | null)[] = path.map((p, i) => (i === 4 ? at(2, 80) : i === 5 ? at(14, 100) : null));
  const kept = applySnap(path, pair);
  assert.ok(Math.abs(dx(kept, 4) - 2) < 0.01 && Math.abs(dx(kept, 5) - 2 * (1 - 20 / 60)) < 0.01, `${dx(kept, 4)}, ${dx(kept, 5)}`);
});

test("the line slides from the lanes onto a threaded corner, which stays where the lanes put it", () => {
  const path: LonLat[] = Array.from({ length: 10 }, (_, i) => at(0, i * 20));
  const dx = (moved: LonLat[], i: number) => (moved[i][0] - path[i][0]) * 111_320 * Math.cos((37.4979 * Math.PI) / 180);
  const snapped: (LonLat | null)[] = path.map((p, i) => (i === 2 ? at(6, 40) : null));
  const fixed: boolean[] = []; fixed[5] = true; fixed[6] = true;
  const moved = applySnap(path, snapped, fixed);
  assert.ok(Math.abs(dx(moved, 3) - 4) < 0.01 && Math.abs(dx(moved, 4) - 2) < 0.01, `${dx(moved, 3)}, ${dx(moved, 4)}`);
  assert.ok(Math.abs(dx(moved, 5)) < 0.01 && Math.abs(dx(moved, 6)) < 0.01, "the corner as threaded");
});

test("a bend the snapping alone would put into the line is undone", () => {
  const path: LonLat[] = Array.from({ length: 10 }, (_, i) => at(0, i * 20));
  const snapped: (LonLat | null)[] = path.map((p, i) => (i === 5 ? at(40, 100) : null));
  assert.deepEqual(applySnap(path, snapped), path);
});

test("the splice slopes onto the trail and off it, and a trail that rejoins askew or after a long way round is refused", () => {
  const r = corner();
  const trail: LonLat[] = [at(0, 180), at(3, 190), at(8, 197), at(15, 200), at(25, 200), at(60, 200)];
  assert.ok(splice(r, trail));
  const m = (p: LonLat) => [Math.round((p[0] - 127.0276) * 111_320 * Math.cos((37.4979 * Math.PI) / 180)), Math.round((p[1] - 37.4979) * 111_320)];
  // The joins 40 m before the trail and 40 m past where it rejoins, not a step across to it; the arc's range is kept.
  assert.deepEqual(r.path.map(m), [[0, 0], [0, 100], [0, 140], [0, 180], [3, 190], [8, 197], [15, 200], [55, 200], [100, 200], [200, 200]]);
  assert.deepEqual(r.threaded, [[3, 7]]);
  // Rejoining at a right angle: another lane's.
  const askew = corner();
  assert.ok(!splice(askew, [at(0, 180), at(10, 170), at(20, 170), at(20, 200)]));
  assert.equal(askew.threaded, undefined);
  // Round the block and back: not this corner's.
  const around = corner();
  assert.ok(!splice(around, [at(0, 180), at(-40, 180), at(-40, 250), at(60, 250), at(60, 205), at(70, 201), at(80, 200)]));
});

test("a corner the lanes did not thread is rounded: a right turn tight, a left one wide, a fork left as it is", () => {
  const cornerOf = (r: Route) => Math.min(...r.path.map((p) => Math.hypot((p[0] - at(0, 200)[0]) * 111_320 * Math.cos((37.4979 * Math.PI) / 180), (p[1] - at(0, 200)[1]) * 111_320)));
  const right = corner();
  roundCorners(right);
  // The corner's own point is gone; the curve passes inside it, a few metres off (a 10 m radius: about 4 m).
  assert.ok(cornerOf(right) > 2 && cornerOf(right) < 6, `right ${cornerOf(right)}`);
  assert.deepEqual(right.path[right.path.length - 1], at(200, 200));
  assert.equal(right.segments[right.segments.length - 1].to, right.path.length);
  // A left turn sweeps wider (22 m: about 9 m inside the corner).
  const left = corner();
  left.path = [at(0, 0), at(0, 100), at(0, 200), at(-100, 200), at(-200, 200)];
  left.guides = [{ at: at(0, 200), text: "좌회전", distanceM: 200, turnType: 1 }, { at: at(-200, 200), text: "도착", distanceM: 0, turnType: 101 }];
  roundCorners(left);
  assert.ok(cornerOf(left) > 6 && cornerOf(left) < 12, `left ${cornerOf(left)}`);
  // A keep-right is not a corner to round.
  const fork = corner();
  fork.guides = [{ at: at(0, 200), text: "오른쪽 방향", distanceM: 200, turnType: 6 }, fork.guides[1]];
  const was = fork.path.length;
  roundCorners(fork);
  assert.equal(fork.path.length, was);
  // Nor one the lanes threaded.
  const threaded = corner();
  assert.ok(splice(threaded, [at(0, 180), at(3, 190), at(8, 197), at(15, 200), at(25, 200), at(60, 200)]));
  const path = threaded.path.map((p) => [...p]);
  roundCorners(threaded);
  assert.deepEqual(threaded.path, path);
});

test("a right turn into the outer lane, 8 m beside the provider's line all the way on, rejoins it", () => {
  const r = corner();
  // The lane comes round to run 8 m south of the route's eastward line (the far side of a wide road).
  const trail: LonLat[] = [at(0, 170), at(2, 182), at(8, 189), at(18, 192), at(40, 192), at(70, 192), at(100, 192)];
  assert.ok(splice(r, trail));
  assert.ok(r.path.some((p) => Math.abs(p[1] - at(0, 192)[1]) < 1e-7));
});
