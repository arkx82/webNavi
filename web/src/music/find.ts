/**
 * Finding a playlist by what the driver types: plain text anywhere in the
 * name, or its initial consonants — "ㄷㄹㅇㅂ" for 드라이브 — the way Korean
 * music apps let one search with a few taps. (Fuse.js does fuzzier things;
 * a few dozen playlist names need no more than this.)
 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** Each Hangul syllable as its first consonant; anything else as it is. */
export function chosung(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}

export function matches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const n = name.toLowerCase().replace(/\s+/g, "");
  return n.includes(q) || chosung(n).includes(q);
}

/** A call held back until typing stops for [ms]: the list is not refiltered on every key. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 250): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
