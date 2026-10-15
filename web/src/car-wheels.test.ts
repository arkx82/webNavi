import { test } from "node:test";
import assert from "node:assert/strict";
import { rollWheels, type Wheels } from "./car-wheels";

const wheels = (): Wheels => {
  const w = () => ({ rotation: { x: 0, y: 0, order: "YXZ" } }) as unknown as Wheels["all"][number];
  const all = [w(), w(), w(), w()];
  return { all, front: all.slice(0, 2), spin: 0, steer: 0 };
};

test("the wheels roll forward with the speed, seen no faster than they read as rolling; the front ones steer into the turn", () => {
  // 10 km/h at its true size, a tenth of a second: 2.78 m/s ÷ 0.368 m = 7.5 rad/s, rolling forward (negative about X).
  const slow = wheels();
  rollWheels(slow, 10 / 3.6, 0, 0.1);
  assert.ok(Math.abs(slow.spin - -0.755) < 0.01, `${slow.spin}`);
  // 100 km/h: twelve turns a second for real, two seen.
  const fast = wheels();
  rollWheels(fast, 100 / 3.6, 0, 0.1);
  assert.ok(Math.abs(fast.spin - -1.2) < 1e-9, `${fast.spin}`);
  // Drawn at twice its size the tyres are twice as big: half the turning.
  const big = wheels();
  rollWheels(big, 10 / 3.6, 0, 0.1, 2);
  assert.ok(Math.abs(big.spin - slow.spin / 2) < 1e-9);
  // Turning right at 20°/s at 30 km/h: a little right (negative about up), the rear wheels straight.
  const turn = wheels();
  for (let i = 0; i < 30; i++) rollWheels(turn, 30 / 3.6, (20 * Math.PI) / 180, 0.1);
  assert.ok(turn.all[0].rotation.y < -0.05 && turn.all[0].rotation.y > -0.2, `${turn.all[0].rotation.y}`);
  assert.equal(turn.all[2].rotation.y, 0);
  // Standing: no roll, and the wheels stay as they were turned.
  const before = turn.steer;
  rollWheels(turn, 0, 1, 0.5);
  assert.equal(turn.steer, before);
});
