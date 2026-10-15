import { test } from "node:test";
import assert from "node:assert/strict";
import { junctionGeometry, type P3, type Scene } from "./junction-view";

test("3D 분기점's triangles: piers only under a deck standing high, and a big junction made in well under a frame", () => {
  // A road on the ground east–west, and a ramp crossing it 9 m up north–south; points every 2 m.
  const road: P3[] = Array.from({ length: 200 }, (_, i) => [i * 2 - 200, 0, 0]);
  const ramp: P3[] = Array.from({ length: 200 }, (_, i) => [0, 9, i * 2 - 200]);
  const scene: Scene = { centre: [127, 37.5], links: [road, ramp], lines: [{ t: "112", pts: road }], marks: [], route: ramp, matched: 200 };
  const g = junctionGeometry(scene, ramp, () => []);
  assert.ok(g.piers.size > 0, "the ramp stands on piers");
  const flat = junctionGeometry({ ...scene, links: [road] }, road, () => []);
  assert.equal(flat.piers.size, 0, "a road on the ground has none");
  // A junction of 상일IC's size (twelve thousand lane points): the pier heights were a tenth of a second alone.
  const links: P3[][] = Array.from({ length: 340 }, (_, k) => Array.from({ length: 35 }, (_, i) => [k * 2 - 340, (k % 7) * 2, i * 10 - 175] as P3));
  const t = performance.now();
  junctionGeometry({ ...scene, links, lines: [], route: links[0] }, links[0], () => []);
  assert.ok(performance.now() - t < 100, `${Math.round(performance.now() - t)} ms`);
});
