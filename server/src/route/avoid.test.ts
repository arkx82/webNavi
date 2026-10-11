import { test } from "node:test";
import assert from "node:assert/strict";
import { Kakao } from "./kakao.js";
import { Naver } from "./naver.js";
import { Tmap } from "./tmap.js";
import { Osrm } from "./osrm.js";
import { routeAvoiding, type Avoid } from "./types.js";

/** Each provider asked with [avoid] against a stub: what it sent, and the route it made of the stub's answer. */
async function asked(make: () => { route: (r: never) => Promise<unknown> }, answer: unknown, avoid: Avoid[]) {
  const real = globalThis.fetch;
  const sent: { url: string; body?: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body as string | undefined });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const route = await routeAvoiding(make() as never, { start: [127, 37.5], goal: [127.1, 37.4], avoid } as never);
    return { sent: sent[0], route };
  } finally {
    globalThis.fetch = real;
  }
}

const tmapAnswer = { features: [
  { geometry: { type: "Point", coordinates: [127, 37.5] }, properties: { totalDistance: 1000, totalTime: 120, totalFare: 0, description: "출발", turnType: 200 } },
  { geometry: { type: "LineString", coordinates: [[127, 37.5], [127.1, 37.4]] }, properties: {} },
] };
const kakaoAnswer = { routes: [{ result_code: 0, result_msg: "길찾기 성공", summary: { distance: 1000, duration: 120, fare: { toll: 1900 } }, sections: [] }] };
const naverRoute = [{ summary: { distance: 1000, duration: 120000, tollFare: 0 }, path: [[127, 37.5], [127.1, 37.4]], guide: [], section: [] }];

test("TMAP: 무료 우선 is searchOption 1, school zones 19; both asked, the school zones are kept off and the tolls said not to be", async () => {
  const body = async (avoid: Avoid[]) => JSON.parse((await asked(() => new Tmap(() => "k"), tmapAnswer, avoid)).sent.body!);
  assert.equal((await body([])).searchOption, "0");
  assert.equal((await body(["toll"])).searchOption, "1");
  assert.equal((await body(["school"])).searchOption, "19");
  assert.equal((await body(["toll", "school"])).searchOption, "19");
  const one = await asked(() => new Tmap(() => "k"), tmapAnswer, ["toll"]) as { route: { tollWon?: number; ignored?: Avoid[] } };
  assert.equal(one.route.tollWon, 0);
  assert.equal(one.route.ignored, undefined);
  const both = await asked(() => new Tmap(() => "k"), tmapAnswer, ["toll", "school"]) as { route: { ignored?: Avoid[] } };
  assert.deepEqual(both.route.ignored, ["toll"]);
});

test("Kakao: avoid=toll|schoolzone, nothing asked nothing sent; the toll fare kept", async () => {
  const url = async (avoid: Avoid[]) => new URL((await asked(() => new Kakao(() => "k"), kakaoAnswer, avoid)).sent.url);
  assert.equal((await url([])).searchParams.get("avoid"), null);
  assert.equal((await url(["toll"])).searchParams.get("avoid"), "toll");
  assert.equal((await url(["school"])).searchParams.get("avoid"), "schoolzone");
  assert.equal((await url(["toll", "school"])).searchParams.get("avoid"), "toll|schoolzone");
  const { route } = await asked(() => new Kakao(() => "k"), kakaoAnswer, ["toll"]) as { route: { tollWon?: number } };
  assert.equal(route.tollWon, 1900);
});

test("NAVER: 무료 우선 is option traavoidtoll, read back under that key; school zones it cannot keep off, and says so", async () => {
  const { sent, route } = await asked(() => new Naver(() => "i", () => "s"), { code: 0, message: "ok", route: { traavoidtoll: naverRoute } }, ["toll", "school"]) as
    { sent: { url: string }; route: { durationS: number; tollWon?: number; ignored?: Avoid[] } };
  assert.equal(new URL(sent.url).searchParams.get("option"), "traavoidtoll");
  assert.equal(route.durationS, 120);
  assert.equal(route.tollWon, 0);
  assert.deepEqual(route.ignored, ["school"]);
  const plain = await asked(() => new Naver(() => "i", () => "s"), { code: 0, message: "ok", route: { traoptimal: naverRoute } }, []) as { sent: { url: string }; route: { ignored?: Avoid[] } };
  assert.equal(new URL(plain.sent.url).searchParams.get("option"), "traoptimal");
  assert.equal(plain.route.ignored, undefined);
});

test("OSRM knows neither tolls nor school zones: both asked are marked as not kept off", async () => {
  const osrmAnswer = { code: "Ok", routes: [{ distance: 1000, duration: 120, geometry: { coordinates: [[127, 37.5], [127.1, 37.4]] }, legs: [{ steps: [] }] }] };
  const { route } = await asked(() => new Osrm(), osrmAnswer, ["toll", "school"]) as { route: { ignored?: Avoid[] } };
  assert.deepEqual(route.ignored, ["toll", "school"]);
});
