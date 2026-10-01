import { test } from "node:test";
import assert from "node:assert/strict";
import { CarTrack, HOLD_MS, PARKED_FRESH_MS, type CarSample } from "./car-track";

const T0 = 1_800_000_000_000;

/** A sample arriving 300 ms after the car stamped it. */
const at = (car: CarTrack, s: CarSample) => car.add(s, s.t + 300);

test("the speed is held between samples: a value sent only when it changes", () => {
  const car = new CarTrack();
  car.add({ t: T0, speedMps: 20 }, T0);
  car.add({ t: T0 + 10_000, speedMps: 0 }, T0 + 10_000);
  // 20 m/s for ten seconds, then standing: 200 m, however long it stands.
  const r = car.between(T0, T0 + 12_000)!;
  assert.ok(Math.abs(r.m - 200) < 0.01, `${r.m}`);
  assert.equal(r.through, T0 + 12_000);
});

test("a jam in the tunnel: stopped is stopped, and creeping is creeping", () => {
  const car = new CarTrack();
  at(car, { t: T0, speedMps: 22 });
  at(car, { t: T0 + 5_000, speedMps: 0 });
  // Standing two minutes, the speed resent now and then, then 3 m/s for a minute.
  for (let s = 10; s <= 120; s += 10) at(car, { t: T0 + 5_000 + s * 1000, speedMps: 0 });
  at(car, { t: T0 + 125_000, speedMps: 3 });
  for (let s = 1; s <= 60; s++) at(car, { t: T0 + 125_000 + s * 1000, speedMps: 3 });
  const r = car.between(T0, T0 + 185_000)!;
  assert.ok(Math.abs(r.m - (22 * 5 + 3 * 60)) < 0.5, `${r.m}`);
});

test("past the last sample the speed is held a few seconds, then the answer stops there", () => {
  const car = new CarTrack();
  at(car, { t: T0, speedMps: 10 });
  const r = car.between(T0, T0 + 60_000)!;
  assert.equal(r.through, T0 + HOLD_MS);
  assert.ok(Math.abs(r.m - 10 * HOLD_MS / 1000) < 0.01);
  // A moment long after the link went quiet is not the car's to answer.
  assert.equal(car.between(T0 + 30_000, T0 + 40_000), null);
});

test("nothing from the car: no answer, so the tracker keeps its own way", () => {
  assert.equal(new CarTrack().between(T0, T0 + 1000), null);
});

test("a fine odometer is read in metres; a late sample in between corrects the distance", () => {
  const car = new CarTrack();
  // The speed says 10 m/s throughout, but the odometer says the car did 12.
  for (let s = 0; s <= 20; s++) at(car, { t: T0 + s * 1000, speedMps: 10, odoM: 50_000 + 12 * s, odoResM: 1.6 });
  assert.ok(car.odoFine);
  const r = car.between(T0 + 2_000, T0 + 12_000)!;
  assert.ok(Math.abs(r.m - 120) < 0.01, `${r.m}`);
});

test("a coarse odometer (0.1 mile) is not read; the speed is", () => {
  const car = new CarTrack();
  for (let s = 0; s <= 60; s++) at(car, { t: T0 + s * 1000, speedMps: 20, odoM: 160.9 * Math.floor((20 * s) / 160.9) + 1_000_000, odoResM: 160.9 });
  assert.equal(car.odoFine, false);
  const r = car.between(T0, T0 + 30_000)!;
  assert.ok(Math.abs(r.m - 600) < 0.01, `${r.m}`);
});

test("out of order and repeated samples (a buffer sent on reconnecting) fall into place", () => {
  const car = new CarTrack();
  at(car, { t: T0, speedMps: 10 });
  at(car, { t: T0 + 20_000, speedMps: 10 });
  at(car, { t: T0 + 10_000, speedMps: 0 });
  at(car, { t: T0 + 10_000, speedMps: 0 });
  at(car, { t: T0 + 15_000, speedMps: 10 });
  // 10 s at 10, 5 s standing, 5 s at 10.
  const r = car.between(T0, T0 + 20_000)!;
  assert.ok(Math.abs(r.m - 150) < 0.01, `${r.m}`);
});

test("a car clock minutes off ours is put right by the samples' arrival", () => {
  const car = new CarTrack();
  const skew = 180_000; // the car's clock three minutes behind
  for (let s = 0; s <= 20; s++) car.add({ t: T0 + s * 1000 - skew, speedMps: s < 10 ? 10 : 0 }, T0 + s * 1000 + 300);
  const r = car.between(T0, T0 + 20_000)!;
  assert.ok(Math.abs(r.m - 100) < 5, `${r.m}`);
});

// ---- off the road: which way, as well as how far ----

const LAT = 37.5, LON = 127.0, M = 111_320;
const east = (m: number) => LON + m / (M * Math.cos((LAT * Math.PI) / 180));

test("off the road, the car's own estimate moving with it: its change is the way the car went", () => {
  const car = new CarTrack();
  // 10 m/s due east, the car's estimate keeping up.
  for (let s = 0; s <= 20; s++) at(car, { t: T0 + s * 1000, speedMps: 10, est: { lon: east(10 * s), lat: LAT, heading: 90 } });
  const p = car.freePath(T0 + 5_000, T0 + 15_000)!;
  assert.equal(p.by, "est");
  assert.ok(Math.abs(p.dE - 100) < 1 && Math.abs(p.dN) < 1, `${p.dE},${p.dN}`);
});

test("the estimate frozen with the GPS but the heading turning: the speed summed along the heading", () => {
  const car = new CarTrack();
  // Round a quarter circle at 5 m/s, 90° in 20 s; the place it says stays put.
  for (let s = 0; s <= 20; s++) at(car, { t: T0 + s * 1000, speedMps: 5, est: { lon: LON, lat: LAT, heading: (90 * s) / 20 } });
  const p = car.freePath(T0, T0 + 20_000)!;
  assert.equal(p.by, "heading");
  // A quarter of a circle of 100 m round (r = 63.7 m): 63.7 east and 63.7 north.
  assert.ok(Math.abs(p.dE - 63.7) < 4 && Math.abs(p.dN - 63.7) < 4, `${p.dE},${p.dN}`);
  assert.equal(p.heading, 90);
});

test("estimate and heading both frozen: not trusted, the car is held", () => {
  const car = new CarTrack();
  for (let s = 0; s <= 20; s++) at(car, { t: T0 + s * 1000, speedMps: 8, est: { lon: LON, lat: LAT, heading: 45 } });
  assert.equal(car.freePath(T0 + 2_000, T0 + 18_000), null);
});

test("standing: nowhere, whatever the rest", () => {
  const car = new CarTrack();
  for (let s = 0; s <= 10; s++) at(car, { t: T0 + s * 1000, speedMps: 0, est: { lon: LON, lat: LAT, heading: 10 } });
  const p = car.freePath(T0, T0 + 10_000)!;
  assert.equal(p.dE, 0);
  assert.equal(p.dN, 0);
});

test("parked: P, or the gear blank with no speed; not once it goes, nor when the car has long been silent", () => {
  const car = new CarTrack();
  assert.equal(car.parked(0), false);
  car.add({ t: 0, speedMps: null, gear: "P" }, 300);
  assert.equal(car.parked(1000), true);
  car.add({ t: 3000, speedMps: null, gear: null }, 3300);
  assert.equal(car.parked(4000), true);
  // Stale: the link may be gone, and the car with it.
  assert.equal(car.parked(3000 + PARKED_FRESH_MS + 1), false);
  // A sample late, from before: does not undo what is newer.
  car.add({ t: 6000, speedMps: 0, gear: "D" }, 6300);
  car.add({ t: 5000, speedMps: null, gear: "P" }, 6400);
  assert.equal(car.parked(7000), false);
  // Fleet Telemetry: the gear only when it changes; a speed alone after P says it goes.
  car.add({ t: 8000, gear: "P" }, 8300);
  car.add({ t: 9000, odoM: 1 }, 9300);
  assert.equal(car.parked(9500), true);
  car.add({ t: 10_000, speedMps: 3 }, 10_300);
  assert.equal(car.parked(10_500), false);
});
