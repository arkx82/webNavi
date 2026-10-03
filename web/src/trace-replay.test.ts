import { test } from "node:test";
import assert from "node:assert/strict";
import { offset } from "./geo";
import { parseTrace, replayTrace } from "./trace-replay";
import type { LonLat } from "./types";

const start: LonLat = [127.0276, 37.4979];
const north = Array.from({ length: 21 }, (_, i) => offset(start, 0, i * 100));
const route = (path: LonLat[], provider = "kakao") => `r,{T},${JSON.stringify({ provider, durationS: 200, distanceM: 2000, path, guides: [], segments: [] })}`;

/**
 * A drive north at 15 m/s, a fix a second, the car's samples twice a second; at 100 s (1500 m on) a re-route to the
 * east comes between two fixes, five seconds without one — what had the marker leap 1583 m on the road on 2026-10-03.
 */
function drive(): string {
  const T0 = 1_790_000_000_000;
  const lines: string[] = [route(north).replace("{T}", String(T0))];
  const here = offset(start, 0, 1500);
  const east = Array.from({ length: 21 }, (_, i) => offset(here, 90, i * 100));
  for (let ms = 0; ms <= 130_000; ms += 500) {
    const t = T0 + ms;
    lines.push(`c,${t + 200},${t},15.00,${(50_000 + ms * 0.015).toFixed(1)},1.6,,,,D`);
    if (ms % 1000) continue;
    if (ms > 100_000 && ms < 105_000) continue; // the browser silent
    const at = ms <= 100_000 ? offset(start, 0, ms * 0.015) : offset(here, 90, (ms - 100_000) * 0.015);
    lines.push(`f,${t + 50},${t},${at[0].toFixed(6)},${at[1].toFixed(6)},8,15,${ms <= 100_000 ? 0 : 90}`);
  }
  lines.push(route(east, "korea").replace("{T}", String(T0 + 100_500)));
  return lines.join("\n");
}

test("a trace is read back: its fixes, the car's samples, the routes", () => {
  const rows = parseTrace(drive());
  assert.equal(rows.filter((r) => r.kind === "r").length, 2);
  assert.equal(rows.filter((r) => r.kind === "f").length, 127);
  const c = rows.find((r) => r.kind === "c")!;
  assert.ok(c.kind === "c" && c.sample.speedMps === 15 && c.sample.gear === "D" && c.sample.est === undefined);
});

test("played again: a route changed between two fixes leaves the marker where the car is, nothing far off nor leaping", () => {
  const report = replayTrace(parseTrace(drive()));
  assert.equal(report.fixes, 127);
  assert.equal(report.gaps.max, 5);
  const bad = report.events.filter((e) => e.kind === "far" || e.kind === "leap" || e.kind === "reckon");
  assert.deepEqual(bad.map((e) => e.text), []);
  assert.equal(report.events.filter((e) => e.kind === "route").length, 2);
});
