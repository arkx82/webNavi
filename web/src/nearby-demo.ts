import type { Category, Fuel, LonLat, Poi } from "./types";

/**
 * Made-up places for ?demo, so the 주변 buttons can be judged at a desk
 * with no keys: the same corner always gives the same places, prices move
 * with the fuel, and chargers are sometimes all busy. None of it is real.
 */
const AREAS = ["테헤란", "역삼", "선릉", "대치", "삼성", "도곡", "논현", "개포", "한티", "봉은"];
const NAMES: Record<Category, (area: string, i: number) => string> = {
  gas: (a, i) => `${["SK", "GS칼텍스", "HD현대오일뱅크", "S-OIL", "알뜰"][i % 5]} ${a}주유소`,
  ev: (a, i) => `${a}${["공영주차장", "빌딩", "역", "타워"][i % 4]} 충전소`,
  parking: (a, i) => `${a}${["공영주차장", "제2공영주차장", "빌딩 주차장"][i % 3]}`,
  food: (a, i) => `${["한우명가", "칼국수", "스시", "김밥천국", "쌀국수", "돈까스", "순대국", "평양냉면"][i % 8]} ${a}점`,
  cafe: (a, i) => `${["스타벅스", "투썸플레이스", "블루보틀", "이디야커피", "메가MGC커피"][i % 5]} ${a}점`,
  cvs: (a, i) => `${["GS25", "CU", "세븐일레븐", "이마트24"][i % 4]} ${a}점`,
  hospital: (a, i) => `${a}${["내과의원", "정형외과", "소아청소년과", "이비인후과", "치과"][i % 5]}`,
  pharmacy: (a) => `${a}약국`,
  bank: (a, i) => `${["KB국민은행", "신한은행", "우리은행", "하나은행"][i % 4]} ${a}지점`,
  rest: (a) => `${a}휴게소`,
};
const DETAIL: Partial<Record<Category, (i: number) => string>> = {
  gas: (i) => ["SK에너지", "GS칼텍스", "HD현대오일뱅크", "S-OIL", "자영알뜰"][i % 5],
  food: (i) => ["한식 · 육류,고기", "한식 · 국수", "일식 · 초밥,롤", "분식", "아시아음식 · 베트남음식", "일식 · 돈까스", "한식 · 해장국", "한식 · 냉면"][i % 8],
  hospital: (i) => ["내과", "정형외과", "소아청소년과", "이비인후과", "치과"][i % 5],
};
const FUEL_BASE: Record<Fuel, number> = { B027: 1689, D047: 1579, B034: 1949, K015: 1049 };
const OPERATORS = ["환경부", "한국전력공사", "GS차지비", "에버온", "SK일렉링크", "채비"];

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function fakeNearby(category: Category, at: LonLat, radiusM: number, fuel: Fuel): Poi[] {
  // A 500 m grid cell names the corner, so panning a little keeps the places put.
  const cell = [Math.round(at[0] / 0.005), Math.round(at[1] / 0.005)];
  const rand = seeded(cell[0] * 73856093 ^ cell[1] * 19349663 ^ category.length * 83492791);
  const count = 8 + Math.floor(rand() * 8);
  const kx = 111_320 * Math.cos((at[1] * Math.PI) / 180);
  const out: Poi[] = [];
  for (let i = 0; i < count; i++) {
    const d = Math.sqrt(rand()) * radiusM * 0.9;
    const a = rand() * 2 * Math.PI;
    const p: LonLat = [at[0] + (Math.sin(a) * d) / kx, at[1] + (Math.cos(a) * d) / 111_320];
    const area = AREAS[Math.floor(rand() * AREAS.length)];
    const poi: Poi = {
      id: `demo:${category}:${cell.join(",")}:${i}`,
      category,
      name: NAMES[category](area, i),
      address: `서울 강남구 ${area}로 ${10 + Math.floor(rand() * 400)}`,
      at: p,
      distanceM: d,
      detail: DETAIL[category]?.(i),
      phone: `02-${500 + Math.floor(rand() * 400)}-${1000 + Math.floor(rand() * 9000)}`,
    };
    if (category === "gas") {
      poi.price = { won: FUEL_BASE[fuel] + Math.round((rand() - 0.4) * 160), unit: "L", label: ["휘발유", "경유", "고급휘발유", "LPG"][["B027", "D047", "B034", "K015"].indexOf(fuel)] };
    }
    if (category === "ev") {
      const fastTotal = Math.floor(rand() * 5);
      const slowTotal = fastTotal ? Math.floor(rand() * 3) : 2 + Math.floor(rand() * 5);
      const operator = OPERATORS[i % OPERATORS.length];
      const maxKw = fastTotal ? [50, 100, 200, 350][Math.floor(rand() * 4)] : 7;
      const won = operator === "환경부" ? [295.0, 307.2, 325.6, 348.4, 393.1][[30, 50, 100, 200, Infinity].findIndex((b) => maxKw < b)] : undefined;
      poi.chargers = {
        fastTotal, fastFree: Math.floor(rand() * (fastTotal + 1)),
        slowTotal, slowFree: Math.floor(rand() * (slowTotal + 1)),
        maxKw, operator, parkingFree: rand() < 0.4, useTime: "24시간",
        price: won ? { won, unit: "kWh", label: `${fastTotal ? "급속" : "완속"} ${maxKw}kW` } : undefined,
      };
      poi.price = poi.chargers.price;
      poi.detail = operator;
    }
    out.push(poi);
  }
  return out.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
}
