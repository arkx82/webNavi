import { test } from "node:test";
import assert from "node:assert/strict";
import { rollWheels, type Wheels } from "./car-wheels";

const wheels = (): Wheels => {
  const w = () => ({ rotation: { x: 0, y: 0, order: "YXZ" } }) as unknown as Wheels["all"][number];
  const all = [w(), w(), w(), w()];
  return { all, front: all.slice(0, 2), spin: 0, steer: 0, blurs: [{ opacity: 0 }] };
};
/** How far the wheels turn in one frame [dt] at [kmh]. */
const step = (kmh: number, dt: number, scale = 1) => { const w = wheels(); rollWheels(w, kmh / 3.6, 0, dt, scale); return -w.spin; };
const DEG15 = (15 * Math.PI) / 180;

test("the wheels roll forward faster as the car does, near their true turning slow and never past 15° a frame; a blur comes up at speed", () => {
  // 10 km/h at sixty frames: 2.78 m/s ÷ 0.368 m ÷ 60 = 0.126 rad, seen within a tenth of that.
  assert.ok(step(10, 1 / 60) > 0.11 && step(10, 1 / 60) < 0.126, `${step(10, 1 / 60)}`);
  // Faster and faster, short of 15° a frame — at thirty frames too, where 100 km/h is 53° a frame for real.
  for (const dt of [1 / 60, 1 / 30]) {
    let last = 0;
    for (const kmh of [5, 20, 40, 60, 100, 150]) {
      const s = step(kmh, dt);
      assert.ok(s > last && s < DEG15 + 1e-9, `${kmh} km/h at ${Math.round(1 / dt)} fps: ${s}`);
      last = s;
    }
  }
  // Drawn at twice its size the tyres are twice as big: about half the turning at a crawl.
  assert.ok(Math.abs(step(5, 1 / 60, 2) - step(5, 1 / 60) / 2) < 0.005);
  // The blur: none at 30 km/h, all of it at 100.
  const at = (kmh: number) => { const w = wheels(); rollWheels(w, kmh / 3.6, 0, 1 / 30); return w.blurs[0].opacity; };
  assert.equal(at(30), 0);
  assert.ok(at(60) > 0.3 && at(60) < 0.6);
  assert.equal(at(100), 0.85);
});

test("the front wheels steer into the turn, and stay as they were when the car stands", () => {
  // Turning right at 20°/s at 30 km/h: a little right (negative about up), the rear wheels straight.
  const turn = wheels();
  for (let i = 0; i < 30; i++) rollWheels(turn, 30 / 3.6, (20 * Math.PI) / 180, 0.1);
  assert.ok(turn.all[0].rotation.y < -0.05 && turn.all[0].rotation.y > -0.2, `${turn.all[0].rotation.y}`);
  assert.equal(turn.all[2].rotation.y, 0);
  const before = turn.steer;
  rollWheels(turn, 0, 1, 0.5);
  assert.equal(turn.steer, before);
});
