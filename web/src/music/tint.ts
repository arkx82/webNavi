/**
 * The colour of a cover, for the player to wear: what fast-average-color
 * does, in a dozen lines — the image drawn small on a canvas and its
 * pixels averaged, the near-black and near-white ones left out so a white
 * border or a black sleeve does not wash the colour away.
 *
 * Needs the image to allow it (CORS); TIDAL's image hosts
 * do. Where one does not, or it will not load, the answer is null and the
 * player keeps its own colour.
 */
const kept = new Map<string, Promise<[number, number, number] | null>>();

export function tintOf(url: string): Promise<[number, number, number] | null> {
  let had = kept.get(url);
  if (!had) {
    had = new Promise((done) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 24;
          const g = c.getContext("2d", { willReadFrequently: true })!;
          g.drawImage(img, 0, 0, 24, 24);
          const px = g.getImageData(0, 0, 24, 24).data;
          let r = 0, gr = 0, b = 0, n = 0;
          for (let i = 0; i < px.length; i += 4) {
            const [pr, pg, pb] = [px[i], px[i + 1], px[i + 2]];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            if (max < 28 || min > 235) continue;
            // Colourful pixels count more than grey ones: the cover's colour, not its average.
            const w = 1 + (max - min) / 40;
            r += pr * w; gr += pg * w; b += pb * w; n += w;
          }
          done(n ? [Math.round(r / n), Math.round(gr / n), Math.round(b / n)] : null);
        } catch {
          done(null); // a tainted canvas: the host did not allow it
        }
      };
      img.onerror = () => done(null);
      img.src = url;
    });
    kept.set(url, had);
  }
  return had;
}

/** A colour lifted towards pastel for the accents, so a dark cover still gives something bright to tap. */
export function pastel([r, g, b]: [number, number, number], lift = 0.45): string {
  const m = (v: number) => Math.round(v + (255 - v) * lift);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/** The same colour darkened, for the top of the background gradient under white text. */
export function deep([r, g, b]: [number, number, number], keep = 0.55): string {
  return `rgb(${Math.round(r * keep)}, ${Math.round(g * keep)}, ${Math.round(b * keep)})`;
}
