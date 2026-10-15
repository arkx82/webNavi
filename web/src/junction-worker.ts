/**
 * 3D 분기점's triangles made off the page's thread (junction-view.ts junctionArrays): asked with a junction's scene
 * and the route on it, answered with each material's arrays, handed over not copied. Made on the page's own thread
 * they held the map up a tenth of a second at a big junction (상일IC, 2026-10-15).
 */
import * as THREE from "three";
import { junctionArrays, type P3, type Scene } from "./junction-view";

self.onmessage = (e: MessageEvent<{ id: number; scene: Scene; route: P3[] }>) => {
  const { id, scene, route } = e.data;
  try {
    const arrays = junctionArrays(scene, route, THREE);
    const moved: Transferable[] = [];
    for (const a of Object.values(arrays.parts)) {
      moved.push(a.pos.buffer, a.idx.buffer);
      if (a.normal) moved.push(a.normal.buffer);
    }
    (self as unknown as Worker).postMessage({ id, arrays }, moved);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
