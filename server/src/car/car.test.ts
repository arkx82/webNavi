import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { COLUMNS, parseFrame } from "./owner.js";
import { NAMESPACE, parseTelemetry } from "./fleet.js";
import { RedisSubscriber, parseResp } from "./redis.js";
import { CarHub, type CarSource, type LinkedCar } from "./hub.js";
import { MILE_M, MPH_MPS, OdoResolution, type CarSample } from "./sample.js";

test("an owner streaming frame: mph and miles into metres, the car's own place kept", () => {
  assert.equal(COLUMNS[0], "speed");
  // time,speed,odometer,soc,elevation,est_heading,est_lat,est_lng,power,shift_state,range,est_range,heading
  const s = parseFrame("1790000000123,45,12345.678,80,35,182,37.5012,127.0391,12,D,250,230,181")!;
  assert.equal(s.soc, 80);
  assert.equal(s.powerKw, 12);
  assert.equal(s.t, 1790000000123);
  assert.ok(Math.abs(s.speedMps! - 45 * MPH_MPS) < 1e-9);
  assert.ok(Math.abs(s.odoM! - 12345.678 * MILE_M) < 1e-6);
  assert.ok(Math.abs(s.odoResM! - MILE_M / 1000) < 1e-9);
  assert.deepEqual(s.est, { lon: 127.0391, lat: 37.5012, heading: 182 });
  assert.equal(s.gear, "D");
});

test("parked, the speed is empty: standing, not unknown", () => {
  const s = parseFrame("1790000000123,,12345.6,80,35,,,,0,P,250,230,")!;
  assert.equal(s.speedMps, null);
  assert.equal(s.est, null);
  assert.equal(s.gear, "P");
  // Blank, as it often is parked: no gear said, and standing.
  const blank = parseFrame("1790000000123,,12345.6,80,35,,,,0,,250,230,")!;
  assert.equal(blank.gear, null);
  assert.equal(blank.speedMps, null);
  // In gear with no speed figure: 0.
  assert.equal(parseFrame("1790000000123,,12345.6,80,35,,,,0,D,250,230,")!.speedMps, 0);
  assert.equal(parseFrame("garbage"), null);
});

test("the odometer's fineness is the most decimals of late, not the last figure's", () => {
  const odo = new OdoResolution();
  assert.ok(Math.abs(odo.feed("12345.6")! - MILE_M / 10) < 1e-9);
  assert.ok(Math.abs(odo.feed("12345.612")! - MILE_M / 1000) < 1e-9);
  // A figure that happens to end in zeros does not make it coarse again.
  assert.ok(Math.abs(odo.feed("12345.7")! - MILE_M / 1000) < 1e-9);
});

test("a Fleet Telemetry record, typed or as strings", () => {
  const typed = parseTelemetry(JSON.stringify({
    data: [
      { key: "VehicleSpeed", value: { doubleValue: 30 } },
      { key: "Odometer", value: { doubleValue: 2000.125 } },
      { key: "Location", value: { locationValue: { latitude: 37.5, longitude: 127.03 } } },
      { key: "GpsHeading", value: { doubleValue: 90 } },
    ],
    createdAt: "2026-10-01T12:00:00.250Z",
    vin: "5YJ3E7EB0LF000001",
    isResend: false,
  }))!;
  assert.equal(typed.vin, "5YJ3E7EB0LF000001");
  assert.equal(typed.sample.t, Date.parse("2026-10-01T12:00:00.250Z"));
  assert.ok(Math.abs(typed.sample.speedMps! - 30 * MPH_MPS) < 1e-9);
  assert.ok(Math.abs(typed.sample.odoM! - 2000.125 * MILE_M) < 1e-6);
  assert.ok(Math.abs(typed.sample.odoResM! - MILE_M / 1000) < 1e-9);
  assert.deepEqual(typed.sample.est, { lon: 127.03, lat: 37.5, heading: 90 });
  // Only what the record carries: no speed key, no speed in the sample (the page holds the last).
  const strings = parseTelemetry(JSON.stringify({ data: [{ key: "Odometer", value: { stringValue: "2000.2" } }], createdAt: "2026-10-01T12:00:01Z", vin: "V" }))!;
  assert.equal("speedMps" in strings.sample, false);
  assert.ok(Math.abs(strings.sample.odoM! - 2000.2 * MILE_M) < 1e-6);
  // Parked.
  const parked = parseTelemetry(JSON.stringify({ data: [{ key: "Gear", value: { shiftStateValue: "ShiftStateP" } }], createdAt: "2026-10-01T12:00:02Z", vin: "V" }))!;
  assert.equal(parked.sample.speedMps, null);
  assert.equal(parked.sample.gear, "P");
  const driving = parseTelemetry(JSON.stringify({ data: [{ key: "Gear", value: { shiftStateValue: "ShiftStateD" } }], createdAt: "2026-10-01T12:00:03Z", vin: "V" }))!;
  assert.equal(driving.sample.gear, "D");
  assert.equal("speedMps" in driving.sample, false);
  assert.equal(parseTelemetry("{"), null);
  assert.equal(parseTelemetry(JSON.stringify({ data: [], vin: "V" })), null);
});

test("redis replies are read whole, however the bytes are split", () => {
  const wire = Buffer.from("*4\r\n$8\r\npmessage\r\n$3\r\na_*\r\n$5\r\na_{V}\r\n$12\r\n{\"x\":\"a\r\nb\"}\r\n");
  const whole = parseResp(wire)!;
  assert.equal(whole[1], wire.length);
  const items = whole[0] as Buffer[];
  assert.equal(items[3].toString(), "{\"x\":\"a\r\nb\"}");
  for (let cut = 1; cut < wire.length; cut++) assert.equal(parseResp(wire.subarray(0, cut)), null, `cut at ${cut}`);
});

test("the subscriber hears Fleet Telemetry's channels, and comes back when the socket drops", async () => {
  const got: string[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.on("data", (d) => {
      if (!d.toString().includes("PSUBSCRIBE")) return;
      socket.write(`*3\r\n$10\r\npsubscribe\r\n$${NAMESPACE.length + 2}\r\n${NAMESPACE}_*\r\n:1\r\n`);
      const ch = `${NAMESPACE}_V_{VIN${connections}}`, body = `{"n":${connections}}`;
      // Split mid-reply, as TCP may.
      const msg = Buffer.from(`*4\r\n$8\r\npmessage\r\n$${NAMESPACE.length + 2}\r\n${NAMESPACE}_*\r\n$${ch.length}\r\n${ch}\r\n$${body.length}\r\n${body}\r\n`);
      socket.write(msg.subarray(0, 20));
      setTimeout(() => { socket.write(msg.subarray(20)); if (connections === 1) setTimeout(() => socket.destroy(), 20); }, 20);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const sub = new RedisSubscriber("127.0.0.1", port, `${NAMESPACE}_*`, (ch, p) => got.push(`${ch} ${p}`));
  sub.start();
  for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
  sub.stop();
  server.close();
  assert.deepEqual(got, [`${NAMESPACE}_V_{VIN1} {"n":1}`, `${NAMESPACE}_V_{VIN2} {"n":2}`]);
});

test("the hub opens a car's stream for the first page, shares it, and lets it go a while after the last", async () => {
  const car: LinkedCar = { vin: "V1", id: "1", vehicleId: 7, name: "모델 3", user: "driver" };
  const made: { started: number; stopped: number; emit: (s: CarSample) => void }[] = [];
  const hub = new CarHub(() => [car], (_c, emit) => {
    const m = { started: 0, stopped: 0, emit };
    made.push(m);
    const src: CarSource = { start: () => { m.started++; }, stop: () => { m.stopped++; }, state: "streaming", lastError: null, lastSampleAt: 0 };
    return src;
  });
  assert.deepEqual(hub.carsFor("DRIVER").map((c) => c.vin), ["V1"]);
  assert.deepEqual(hub.carsFor("sim1"), []);
  const a: CarSample[] = [], b: CarSample[] = [];
  const offA = hub.listen("V1", { sample: (s) => a.push(s), state: () => {} });
  const offB = hub.listen("V1", { sample: (s) => b.push(s), state: () => {} });
  assert.equal(made.length, 1);
  assert.equal(made[0].started, 1);
  made[0].emit({ t: 1, speedMps: 3 });
  assert.equal(a.length + b.length, 2);
  offA();
  offB();
  // Lingering: a page back within the minute finds the same stream.
  const offC = hub.listen("V1", { sample: () => {}, state: () => {} });
  assert.equal(made.length, 1);
  assert.equal(made[0].stopped, 0);
  offC();
  hub.reset();
  assert.equal(made[0].stopped, 1);
});

test("the owner login: the console's \"Failed to launch\" line pasted whole gives the code, sent with the tesla:// redirect", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Settings } = await import("../settings.js");
  const { OwnerAuth, OWNER_REDIRECT } = await import("./owner.js");
  const settings = new Settings(mkdtempSync(join(tmpdir(), "owner-")), {});
  const sent: string[] = [];
  const auth = new OwnerAuth(settings, async (_url, body) => {
    sent.push(body);
    return { status: 200, text: JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 28800 }) };
  });
  const url = new URL(auth.begin());
  assert.equal(url.searchParams.get("redirect_uri"), "tesla://auth/callback");
  const state = url.searchParams.get("state")!;
  await auth.finish(`Failed to launch '${OWNER_REDIRECT}?code=abc123&state=${state}&issuer=https%3A%2F%2Fauth.tesla.com%2Foauth2%2Fv3' because the scheme does not have a registered handler.`);
  const body = new URLSearchParams(sent[0]);
  assert.equal(body.get("code"), "abc123");
  assert.equal(body.get("redirect_uri"), "tesla://auth/callback");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.ok(body.get("code_verifier"));
  assert.equal(settings.get("teslaRefresh"), "R");
});
