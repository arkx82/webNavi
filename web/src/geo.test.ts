import { test } from "node:test";
import assert from "node:assert/strict";
import { Line } from "./geo";
import type { LonLat } from "./types";

test("a projection over the whole line, blocks passed over, is the plain scan's: the nearest, the first of equally near", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 20; run++) {
    // A winding line, now and then back over itself (a U-turn: equally near segments), and repeated vertices.
    const path: LonLat[] = [];
    let x = 127, y = 37.5;
    for (let i = 0; i < 400; i++) {
      if (i % 97 === 50) { for (let k = path.length - 1; k > path.length - 30 && k > 0; k--) path.push(path[k]); continue; }
      x += (rnd() - 0.5) * 0.002; y += rnd() * 0.001;
      path.push([x, y]);
      if (i % 31 === 0) path.push([x, y]);
    }
    const line = new Line(path);
    for (let q = 0; q < 50; q++) {
      const p: LonLat = [127 + (rnd() - 0.5) * 0.05, 37.5 + rnd() * 0.25];
      const got = line.project(p, 0, path.length);
      // The plain scan: every segment, the first nearest kept.
      // As Line has it, to the last bit.
      const kx = 111_320 * Math.cos((path[0][1] * Math.PI) / 180);
      const px = (p[0] - path[0][0]) * kx, py = (p[1] - path[0][1]) * 111_320;
      let bestD = Infinity, bestI = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const ax = line.xs[i], ay = line.ys[i], dx = line.xs[i + 1] - ax, dy = line.ys[i + 1] - ay, len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d < bestD) { bestD = d; bestI = i; }
      }
      assert.ok(Math.abs(got.offM - bestD) < 1e-6, `run ${run}: ${got.offM} vs ${bestD}`);
      assert.equal(got.segment, bestI, `run ${run} query ${q}: got ${got.segment} (${got.offM}) want ${bestI} (${bestD}); n ${path.length}`);
    }
  }
});
