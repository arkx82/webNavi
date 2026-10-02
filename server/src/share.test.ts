import { test } from "node:test";
import assert from "node:assert/strict";
import { coordsOf, kakaoPlaceId, kakaoPlaceOf, readShare, resolveShare } from "./share.js";
import type { Place } from "./search.js";

test("a share text is read for the place's name, its address and its link, whichever app wrote it", () => {
  assert.deepEqual(readShare("[네이버지도]\n스타벅스 강남역점\n서울 강남구 강남대로 390\nhttps://naver.me/5abcDEF"),
    { name: "스타벅스 강남역점", address: "서울 강남구 강남대로 390", urls: ["https://naver.me/5abcDEF"] });
  assert.deepEqual(readShare("[카카오맵] 스타벅스 강남역점 서울 강남구 강남대로 390 1층 https://kko.to/AbC12"),
    { name: "스타벅스 강남역점", address: "서울 강남구 강남대로 390 1층", urls: ["https://kko.to/AbC12"] });
  assert.deepEqual(readShare("[TMAP] 코엑스\n서울특별시 강남구 영동대로 513\nhttps://tmap.life/xyz"),
    { name: "코엑스", address: "서울특별시 강남구 영동대로 513", urls: ["https://tmap.life/xyz"] });
  assert.deepEqual(readShare("경기 성남시 분당구 판교역로 166"), { name: null, address: "경기 성남시 분당구 판교역로 166", urls: [] });
});

test("a link's own coordinates are taken only when they are plainly lon/lat in Korea", () => {
  assert.deepEqual(coordsOf("https://map.kakao.com/link/to/x?lng=127.0276&lat=37.4979"), [127.0276, 37.4979]);
  assert.equal(coordsOf("https://map.naver.com/p?c=14141414.0,4512345.0,15,0,0,0,dh"), null);
  assert.equal(coordsOf("not a url"), null);
});

test("the place is Kakao's answer for the name that agrees with the address, else the address itself", async () => {
  const shops: Place[] = [
    { name: "스타벅스 강남역점", address: "서울 강남구 테헤란로 101", at: [127.03, 37.5] },
    { name: "스타벅스 강남역점", address: "서울 강남구 강남대로 390", at: [127.028, 37.497] },
  ];
  const search = { find: async () => shops, findAddress: async () => [127.1, 37.4] as [number, number] };
  const p = await resolveShare("[네이버지도]\n스타벅스 강남역점\n서울 강남구 강남대로 390", search);
  assert.deepEqual(p?.at, [127.028, 37.497]);
  // Nothing found by the name: the address.
  const none = { find: async () => [] as Place[], findAddress: async () => [127.1, 37.4] as [number, number] };
  const q = await resolveShare("우리집\n경기 성남시 분당구 판교역로 166", none);
  assert.deepEqual(q, { name: "우리집", address: "경기 성남시 분당구 판교역로 166", at: [127.1, 37.4] });
});

test("a 카카오맵 link's place: its id through the redirects, and its page's preview tags", () => {
  assert.equal(kakaoPlaceId("https://applink.map.kakao.com/place?id=1180483021&t_src=share&t_ch=via_another_app"), "1180483021");
  assert.equal(kakaoPlaceId("https://place.map.kakao.com/27531028"), "27531028");
  assert.equal(kakaoPlaceId("https://naver.me/abc"), null);
  const html = `<meta property="og:title" content="애드라인 터프팅 스튜디오"><meta property="og:description" content="경기 수원시 팔달구 세지로234번길 5 1층">
    <meta name="twitter:image" content="http://staticmap.kakao.com/staticmap/og?type=place&srs=wgs84&size=400x200&service=placeweb&m=127.0244437216419%2C37.27206263694749">`;
  assert.deepEqual(kakaoPlaceOf(html), { name: "애드라인 터프팅 스튜디오", address: "경기 수원시 팔달구 세지로234번길 5 1층", at: [127.0244437216419, 37.27206263694749] });
  // The app's own page (no place in it): none.
  assert.equal(kakaoPlaceOf(`<meta property="og:title" content="카카오맵">`), null);
});
