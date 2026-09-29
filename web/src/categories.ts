import type { Category, Fuel } from "./types";

/**
 * The 주변 buttons, in the order the car apps put them: the two with a
 * price first, then parking, then the stops a drive makes. Colours are the
 * ones a Korean driver already reads for these (주유 orange, 충전 green,
 * 주차 blue, 병원 red); the icons are drawn here rather than taken from an
 * emoji font, which the car's Linux browser may not have.
 */
export interface CategoryLook {
  id: Category;
  label: string;
  color: string;
  /** Inner SVG on a 24×24 grid, stroked in currentColor. */
  path: string;
}

export const CATEGORIES: CategoryLook[] = [
  { id: "gas", label: "주유소", color: "#f5821f", path: `<rect x="4" y="3" width="10" height="18" rx="1.5"/><path d="M4 10h10M14 7.5l3 2v7.5a1.5 1.5 0 0 0 3 0V8.5l-3-3"/>` },
  { id: "ev", label: "충전소", color: "#12b76a", path: `<path d="M13.5 2 5 13.5h6.2L10.5 22 19 10.5h-6.2z" fill="currentColor" stroke="none"/>` },
  { id: "parking", label: "주차장", color: "#3478f6", path: `<path d="M8 20V4h5.2a4.6 4.6 0 0 1 0 9.2H8" stroke-width="2.8"/>` },
  { id: "food", label: "음식점", color: "#ef5a3c", path: `<path d="M7 3v18M4.5 3v5.5a2.5 2.5 0 0 0 5 0V3M17 21V3c-2.2 1.2-3.5 4-3.5 7.5 0 2.5 1.2 3.8 3.5 3.8"/>` },
  { id: "cafe", label: "카페", color: "#9a6a4b", path: `<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v3M12 3.5v3"/>` },
  { id: "cvs", label: "편의점", color: "#7c5cff", path: `<path d="M3.5 9 5 4h14l1.5 5M4.5 9v11h15V9M3.5 9h17M10 20v-6h4v6"/>` },
  { id: "hospital", label: "병원", color: "#e5484d", path: `<path d="M12 4.5v15M4.5 12h15" stroke-width="3.4"/>` },
  { id: "pharmacy", label: "약국", color: "#0fa38d", path: `<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/>` },
  { id: "bank", label: "은행", color: "#3b6fb6", path: `<path d="M3 9.5 12 4l9 5.5M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3 20.5h18"/>` },
  { id: "rest", label: "휴게소", color: "#c98a0b", path: `<path d="M3 11.5 12 4l9 7.5M6 10v10h12V10M10 20v-5h4v5"/>` },
];

export const LOOK = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<Category, CategoryLook>;

export function icon(category: Category, size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LOOK[category].path}</svg>`;
}

export const FUELS: { id: Fuel; label: string }[] = [
  { id: "B027", label: "휘발유" },
  { id: "D047", label: "경유" },
  { id: "B034", label: "고급" },
  { id: "K015", label: "LPG" },
];
