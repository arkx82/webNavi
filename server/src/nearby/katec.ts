import proj4 from "proj4";
import type { LonLat } from "../route/types.js";

/**
 * KATEC, the Transverse Mercator on the Bessel ellipsoid that Opinet takes
 * and answers in. The datum shift is the seven-parameter one the Opinet
 * client libraries use; it lands within about ten metres of what Opinet
 * itself reports, which is closer than a pump island.
 */
const KATEC =
  "+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +units=m " +
  "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +no_defs";
const WGS84 = "EPSG:4326";
const convert = proj4(WGS84, KATEC);

export function toKatec(at: LonLat): [number, number] {
  return convert.forward(at) as [number, number];
}

export function fromKatec(xy: [number, number]): LonLat {
  return convert.inverse(xy) as LonLat;
}
