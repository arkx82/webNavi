/**
 * The few symbols the screen draws, as inline SVG rather than characters:
 * the car's browser has no glyph for ✕ or ▶ (a box came up in their
 * place), and an SVG in currentColor sits in any button the same.
 */
const svg = (d: string) => `<svg class="gl" viewBox="0 0 20 20" aria-hidden="true"><path d="${d}"/></svg>`;
/** ✕ */
export const X = svg("M4.3 4.3a1 1 0 0 1 1.4 0L10 8.6l4.3-4.3a1 1 0 1 1 1.4 1.4L11.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L8.6 10 4.3 5.7a1 1 0 0 1 0-1.4z");
/** ✓ */
export const CHECK = svg("M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0z");
/** ▶ */
export const PLAY = svg("M6 4.5v11a1 1 0 0 0 1.5.9l9-5.5a1 1 0 0 0 0-1.8l-9-5.5A1 1 0 0 0 6 4.5z");
/** ▴ */
export const UP = svg("M10 6l6 7H4z");
/** ▾ */
export const DOWN = svg("M10 14l6-7H4z");
