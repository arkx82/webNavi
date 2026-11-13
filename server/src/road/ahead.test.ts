import { test } from "node:test";
import assert from "node:assert/strict";
import { bearing, metres, osrmDeg, roadAhead } from "./ahead.js";
import type { LonLat } from "./limits.js";

/**
 * A fake OSRM over a road running north from [0] and ending at a T-junction at [endM]: a way asked for runs straight
 * up the road to the point asked (or the junction); past the junction, only a right turn onto the cross street.
 */
const at0: LonLat = [127.0, 37.5];
const north = (m: number): LonLat => [at0[0], at0[1] + m / 111_195];
function osrm(endM: number) {
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    const [a, b] = /driving\/([^?]+)/.exec(url)![1].split(";").map((p) => p.split(",").map(Number) as LonLat);
    const fromM = metres(at0, a), toM = metres(at0, [at0[0], b[1]]);
    const along = Math.min(toM, endM);
    const turn = toM > endM + 20;
    const coords: LonLat[] = [north(fromM), north(along), ...(turn ? [[north(endM)[0] + 0.001, north(endM)[1]] as LonLat] : [])];
    const steps = [{ distance: along - fromM, maneuver: { type: "depart" } }, ...(turn ? [{ distance: 90, maneuver: { type: "end of road", modifier: "right" } }] : [])];
    const distance = along - fromM + (turn ? 90 : 0);
    return { status: 200, json: async () => ({ code: "Ok", routes: [{ distance, geometry: { coordinates: coords }, legs: [{ steps }] }] }) };
  };
  return { fetchJson, asked };
}

test("the road ahead runs on straight to the length asked", async () => {
  const { fetchJson } = osrm(100_000);
  const r = await roadAhead("http://osrm", at0, 0, 2000, fetchJson);
  assert.ok(r && r.lengthM >= 2000 && r.lengthM < 2300, `${r?.lengthM}`);
  assert.ok(Math.abs(bearing(r!.path[0], r!.path[r!.path.length - 1])) < 1);
});

test("the road ahead stops at a junction it ends at, not turning either way", async () => {
  const { fetchJson } = osrm(700);
  const r = await roadAhead("http://osrm", at0, 0, 2000, fetchJson);
  assert.ok(r, "a road up to the junction");
  const end = r!.path[r!.path.length - 1];
  assert.ok(Math.abs(metres(at0, end) - 700) < 30, `${metres(at0, end)}`);
  assert.ok(r!.path.every((p) => p[0] === at0[0]), "never onto the cross street");
});

test("every bearing asked of OSRM is 0..359: heading north, the bends 45° and 90° to the left are asked too (review, 2026-11-13)", async () => {
  assert.deepEqual([osrmDeg(-35), osrmDeg(-80), osrmDeg(395), osrmDeg(359.6), osrmDeg(0)], [325, 280, 35, 0, 0]);
  // A T-junction 300 m on: no way straight on, so the bends either side are asked.
  for (const deg of [0, 10, 355]) {
    const { fetchJson, asked } = osrm(300);
    await roadAhead("http://osrm", at0, deg, 2000, fetchJson);
    const bearings = asked.flatMap((u) => /bearings=([^&]+)/.exec(u)![1].split(";").map((b) => Number(b.split(",")[0])));
    assert.ok(asked.length > 1, "the bends were asked");
    assert.ok(bearings.every((b) => b >= 0 && b < 360), `${deg}°: ${bearings.join(" ")}`);
  }
});
