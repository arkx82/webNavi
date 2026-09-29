import { EvChargers } from "./ev.js";
import { KakaoPlaces } from "./kakao.js";
import { Opinet } from "./opinet.js";
import { TmapRegions } from "./tmap-regions.js";
import type { NearbyQuery, Poi } from "./types.js";

export { CATEGORIES, FUELS } from "./types.js";
export type { Category, Fuel, Poi } from "./types.js";

/**
 * Around a point, by kind: fuel and chargers from the sources that carry
 * a price or a free count, the rest from Kakao. Where a priced source has
 * no key, Kakao still finds the places, without the price — a list that
 * is there beats one that is not.
 */
export class Nearby {
  readonly kakao: KakaoPlaces;
  readonly opinet: Opinet;
  readonly ev: EvChargers;

  constructor(keys: { kakao: () => string | undefined; tmap: () => string | undefined; opinet: () => string | undefined; dataGoKr: () => string | undefined; evTariffs: () => string | undefined }) {
    this.kakao = new KakaoPlaces(keys.kakao);
    this.opinet = new Opinet(keys.opinet);
    this.ev = new EvChargers(keys.dataGoKr, this.kakao, new TmapRegions(keys.tmap), keys.evTariffs);
  }

  /** Which source answers each priced kind, for the page to say so. */
  sources() {
    return {
      gas: this.opinet.ready ? "opinet" : this.kakao.ready ? "kakao" : null,
      ev: this.ev.ready ? "env" : this.kakao.ready ? "kakao" : null,
      places: this.kakao.ready,
    };
  }

  async find(q: NearbyQuery): Promise<Poi[]> {
    if (q.category === "gas" && this.opinet.ready) return this.opinet.near(q.at, q.radiusM, q.fuel ?? "B027");
    if (q.category === "ev" && this.ev.ready) return this.ev.near(q.at, q.radiusM);
    if (!this.kakao.ready) throw new Error("kakao: no key on this server");
    return this.kakao.near(q.category, q.at, q.radiusM);
  }
}
