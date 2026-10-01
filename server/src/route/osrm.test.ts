import { test } from "node:test";
import assert from "node:assert/strict";
import { Osrm, korean } from "./osrm.js";

test("OSRM manoeuvres come out as the phrases car apps say", () => {
  assert.equal(korean("turn", "right", undefined, "테헤란로"), "테헤란로 방면 우회전");
  assert.equal(korean("turn", "left"), "좌회전");
  assert.equal(korean("roundabout", "right", 2), "회전교차로에서 두 번째 출구");
  assert.equal(korean("off ramp", "slight right", undefined, "올림픽대로"), "올림픽대로 방면 오른쪽 출구");
  assert.equal(korean("end of road", "left"), "길 끝에서 좌회전");
  assert.equal(korean("arrive"), "목적지 도착");
});

test("the same engine over 표준노드링크 is the korea provider, offered only when its address is set", () => {
  assert.equal(new Osrm("http://osrm:5000", "korea", true).name, "korea");
  assert.equal(new Osrm("http://osrm:5000", "korea", true).ready, true);
  assert.equal(new Osrm("http://osrm:5000", "korea", false).ready, false);
  assert.equal(new Osrm().name, "osrm");
  assert.equal(new Osrm().ready, true);
});

test("the korea route's motorway stretches come from the profile's classes and the road names, as index ranges along the path", async () => {
  const { motorwayRanges } = await import("./osrm.js");
  const line = (n: number) => ({ coordinates: Array.from({ length: n }, (_, i) => [127 + i * 0.001, 37] as [number, number]) });
  const steps = [
    { maneuver: { location: [127, 37] as [number, number], type: "depart" }, name: "강남대로", distance: 500, geometry: line(4), intersections: [{ classes: [] }] },
    { maneuver: { location: [127, 37] as [number, number], type: "on ramp", modifier: "right" }, name: "", distance: 300, geometry: line(3), intersections: [{ classes: ["motorway"] }] },
    { maneuver: { location: [127, 37] as [number, number], type: "merge" }, name: "경부고속도로", distance: 30000, geometry: line(10), intersections: [{ classes: ["motorway"] }] },
    { maneuver: { location: [127, 37] as [number, number], type: "off ramp", modifier: "right" }, name: "올림픽대로", distance: 5000, geometry: line(5), intersections: [{ classes: [] }] },
    { maneuver: { location: [127, 37] as [number, number], type: "turn", modifier: "left" }, name: "테헤란로", distance: 800, geometry: line(4), intersections: [{ classes: [] }] },
    { maneuver: { location: [127, 37] as [number, number], type: "arrive" }, name: "테헤란로", distance: 0, geometry: line(1), intersections: [] },
  ];
  // 4 + 3 + 10 + 5 + 4 + 1 points, each step's first the last of the one before: 22 in the path.
  assert.deepEqual(motorwayRanges(steps, 22), [[3, 19]]);
});

test("calibrateDuration adds realistic signal delays and turn penalties on city roads", async () => {
  const { calibrateDuration } = await import("./osrm.js");
  const rawRoute = {
    distance: 5000,
    duration: 360, // 6 minutes (50km/h free flow for 5km)
    geometry: { coordinates: [] },
    legs: [
      {
        steps: [
          {
            maneuver: { location: [127, 37] as [number, number], type: "depart" },
            name: "테헤란로",
            distance: 2500,
            duration: 180,
            intersections: [{ classes: [] }, { classes: [] }, { classes: [] }],
          },
          {
            maneuver: { location: [127, 37] as [number, number], type: "turn", modifier: "left" },
            name: "언주로",
            distance: 2500,
            duration: 180,
            intersections: [{ classes: [] }, { classes: [] }, { classes: [] }],
          },
        ],
      },
    ],
  };
  const calibrated = calibrateDuration(rawRoute);
  assert.ok(calibrated > rawRoute.duration * 1.5, `Calibrated duration ${calibrated}s should be significantly higher than raw ${rawRoute.duration}s`);
});

test("the korea route's time is calibrated only where no live speed is on it; a live street is left as ITS measured it", async () => {
  const { calibrateDuration } = await import("./osrm.js");
  const line = (n: number) => ({ coordinates: Array.from({ length: n }, (_, i) => [127 + i * 0.001, 37] as [number, number]) });
  const street = (dur: number, geom: number) => ({ maneuver: { location: [127, 37] as [number, number], type: "turn", modifier: "straight" }, name: "테헤란로", distance: 800, duration: dur, geometry: line(geom), intersections: [{ classes: [] }, { classes: [] }] });
  // Two 800 m streets of 60 s each, five segments apiece; the first wholly live, the second blind.
  const route = { distance: 1600, duration: 120, geometry: line(11), legs: [{ steps: [street(60, 6), street(60, 6)], annotation: { nodes: [], speed: [], datasources: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0] } }] };
  const calibrated = calibrateDuration(route as never);
  // Live step: 60 s as it is. Blind step: 60 × 1.2 + 800 / 400 × 12 = 96 s. Together 156.
  assert.equal(calibrated, 156);
  // No annotation at all: both steps blind, 192 s.
  const blind = { ...route, legs: [{ steps: [street(60, 6), street(60, 6)] }] };
  assert.equal(calibrateDuration(blind as never), 192);
});
