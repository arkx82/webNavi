import { test } from "node:test";
import assert from "node:assert/strict";
import { Kalman } from "./kalman";
import { metres, offset } from "./geo";

const start: [number, number] = [127.0276, 37.4979];
// A fixed pseudo-random wander, so the test says the same every run.
let seed = 7;
const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };

test("driving straight at 15 m/s with 6 m of wander: the filtered track is nearer the truth, its speed right", () => {
  const k = new Kalman();
  let rawErr = 0, kErr = 0, last = { speed: 0, course: null as number | null };
  for (let i = 0; i < 60; i++) {
    const truth = offset(start, 45, i * 15);
    const measured = offset(offset(truth, 0, noise() * 6), 90, noise() * 6);
    const f = k.step(measured, 6, i * 1000);
    if (i >= 10) { rawErr += metres(measured[0], measured[1], truth[0], truth[1]); kErr += metres(f.at[0], f.at[1], truth[0], truth[1]); }
    last = f;
  }
  assert.ok(kErr < rawErr * 0.75, `filtered ${kErr.toFixed(0)} against raw ${rawErr.toFixed(0)}`);
  assert.ok(Math.abs(last.speed - 15) < 2, `${last.speed}`);
  assert.ok(Math.abs(((last.course ?? 0) - 45 + 540) % 360 - 180) < 15, `${last.course}`);
});

test("standing still with the fixes wandering: the estimate stays put, its speed near nothing and no heading", () => {
  const k = new Kalman();
  let f = k.step(start, 8, 0);
  for (let i = 1; i < 60; i++) f = k.step(offset(offset(start, 0, noise() * 8), 90, noise() * 8), 8, i * 1000);
  assert.ok(metres(f.at[0], f.at[1], start[0], start[1]) < 4, "held near where it is");
  assert.ok(f.speed < 1.5, `${f.speed}`);
  assert.equal(f.course, null);
});

test("a jump of a kilometre (out of a tunnel, a replay starting) starts afresh rather than dragging", () => {
  const k = new Kalman();
  for (let i = 0; i < 10; i++) k.step(offset(start, 0, i * 10), 5, i * 1000);
  const far = offset(start, 90, 1000);
  const f = k.step(far, 5, 11_000);
  assert.ok(metres(f.at[0], f.at[1], far[0], far[1]) < 1);
});

test("a fix with Infinity accuracy (the browser not knowing) neither poisons the state nor stops the filter resetting", () => {
  const k = new Kalman();
  for (let i = 0; i < 5; i++) k.step(offset(start, 0, i * 15), 5, i * 1000);
  const bad = k.step(offset(start, 0, 75), Infinity, 5000);
  assert.ok(bad.at.every(Number.isFinite) && Number.isFinite(bad.speed), `${bad.at} ${bad.speed}`);
  let f = bad;
  for (let i = 6; i < 20; i++) f = k.step(offset(start, 0, i * 15), 5, i * 1000);
  const truth = offset(start, 0, 19 * 15);
  assert.ok(metres(f.at[0], f.at[1], truth[0], truth[1]) < 10, "recovered onto the track");
  assert.ok(Math.abs(f.speed - 15) < 3, `${f.speed}`);
  // NaN coordinates are skipped: the last estimate stands, finite.
  const nan = k.step([NaN, NaN], 5, 20_000);
  assert.ok(nan.at.every(Number.isFinite));
  assert.ok(metres(nan.at[0], nan.at[1], f.at[0], f.at[1]) < 0.01);
  // And a jump after it still starts afresh: the reset test is not a NaN comparison.
  const far = offset(start, 90, 1000);
  const again = k.step(far, 5, 21_000);
  assert.ok(metres(again.at[0], again.at[1], far[0], far[1]) < 1);
});

test("a filter that begins on an Infinity accuracy is still finite, and takes the good fixes after it", () => {
  const k = new Kalman();
  const first = k.step(start, Infinity, 0);
  assert.ok(first.at.every(Number.isFinite));
  let f = first;
  for (let i = 1; i < 15; i++) f = k.step(offset(start, 0, i * 15), 5, i * 1000);
  const truth = offset(start, 0, 14 * 15);
  assert.ok(metres(f.at[0], f.at[1], truth[0], truth[1]) < 10, `${metres(f.at[0], f.at[1], truth[0], truth[1])}`);
  assert.ok(Number.isFinite(f.speed) && f.course != null);
});
