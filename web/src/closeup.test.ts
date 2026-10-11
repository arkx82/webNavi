import { test } from "node:test";
import assert from "node:assert/strict";
import { SEE_ZOOM_MAX, SEE_ZOOM_MIN, closeupFrom, isTricky, zoomToSee } from "./closeup";
import { zoomForSpeed } from "./autozoom";

const g = (text: string, name?: string) => ({ text, name });

test("a fork on a motorway, or a junction whose words say so, is shown close up; a plain crossing is not", () => {
  assert.ok(isTricky(g("신갈JC에서 원주 방면으로 왼쪽 방향"), "slight-left", true));
  assert.ok(isTricky(g("오른쪽 방향"), "slight-right", true));
  assert.ok(isTricky(g("용인IC에서 용인 방면으로 오른쪽 고속도로 출구"), "ramp-right", false));
  assert.ok(isTricky(g("양재 지하차도에서 서초IC 방면으로 지하차도"), "other", false));
  assert.ok(!isTricky(g("강남역에서 우회전"), "right", false));
  assert.ok(!isTricky(g("직진"), "straight", true));
  assert.ok(!isTricky(g("목적지"), "arrive", true));
  assert.equal(closeupFrom(true), 500);
  assert.equal(closeupFrom(false), 250);
});

test("the camera draws back as the junction is further, within bounds", () => {
  const far = zoomToSee(500, 37.5, 600), near = zoomToSee(100, 37.5, 600);
  assert.ok(far < near, `${far} < ${near}`);
  assert.ok(far >= SEE_ZOOM_MIN && near <= SEE_ZOOM_MAX);
});

test("140 m before a fork at a crawl the close-up is no further out than a level below the plain view", () => {
  // The PC's 1430 px high map and the car's 640: the fork and 60 m past it at the foot's 72 %.
  for (const h of [1430, 640]) assert.ok(zoomToSee(140, 37.6, h * 0.72) > zoomForSpeed(30) - 1.2, `${h}: ${zoomToSee(140, 37.6, h * 0.72)}`);
});

test("a re-route drops the junction held from the old route: its metres were measured along another line", async () => {
  const { CloseupHold } = await import("./closeup");
  const g1 = { at: [127, 37] as [number, number], text: "신갈JC에서 원주 방면으로 왼쪽 방향", distanceM: 0, turnType: 17 };
  const judge = { motorway: () => true, maneuver: () => "slight-left" as const, label: () => "분기점 · 신갈JC" };
  const hold = new CloseupHold(judge);
  // Shown from 400 m out at 10 km along; still held 20 m past it.
  assert.equal(hold.frame(10_000, { guide: g1, inM: 400 })?.label, "분기점 · 신갈JC");
  const held = hold.frame(10_420, undefined);
  assert.ok(held && Math.abs(held.inM + 20) < 0.01, `${held?.inM}`);
  // A new route is measured from its own start: without a reset the old junction reads as 10 km still to go, and holds.
  const stale = new CloseupHold(judge);
  stale.frame(10_000, { guide: g1, inM: 400 });
  assert.ok(stale.frame(0, undefined), "the bug: held over onto the new route");
  hold.reset();
  assert.equal(hold.frame(0, undefined), null);
  assert.equal(hold.frame(0, { guide: { ...g1, text: "우회전" }, inM: 3000 }), null);
});
