// The car for the map's 3D look (web/src/car-model.ts), made from a downloaded glTF/GLB of the car:
//
//   mkdir /tmp/carmodel && cd /tmp/carmodel && npm i @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4 meshoptimizer
//   node /path/to/tools/car-model/process.mjs in.glb car-model.glb [ratio=0.08] [paintMaterial=Material_2125780493]
//   cp car-model.glb $CONFIG_DIR/car-model.glb      (served at /api/car-model; never in the repository)
//
// Re-based on the raw mesh's own axes (this one, BloxBloger's 2026 Model Y Performance from Sketchfab, has x along the
// car with its front at −x, y across, z up, under a node that turns it): up +Y, front −Z, the footprint's middle on the
// ground at the origin. Simplified with meshoptimizer to [ratio] of its triangles (346k → 50k) but for the body and
// the small parts that show, the paint's material
// renamed "paint" for the page to colour, clearcoat/transmission and the rim's texture dropped, meshopt-compressed
// (11.5 MB → 0.3 MB). Another model may have other axes and another paint material: check them first (the headlights'
// end is the front).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMaterialsClearcoat, KHRMaterialsTransmission } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplifyPrimitive, flatten, join, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
const [inFile, outFile, targetArg, paintArg] = process.argv.slice(2);
const paintName = paintArg ?? "Material_2125780493";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const doc = await io.read(inFile);
const root = doc.getRoot();
// The raw mesh: x along the car (front at -3.4), y across, z up — under a node that turns it. Re-based on the raw axes.
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) {
  const a = p.getAttribute("POSITION");
  for (let i = 0; i < a.getCount(); i++) { const v = a.getElement(i, []); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); } }
}
const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, z0 = mn[2];
const seen = new Set();
for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) {
  for (const [sem, isPos] of [["POSITION", true], ["NORMAL", false]]) {
    const a = p.getAttribute(sem); if (!a || seen.has(a)) continue; seen.add(a);
    const arr = a.getArray(), out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      // X = y (across), Y = z (up), Z = x (along, front negative): a proper turn, not a mirror.
      out[i] = isPos ? y - cy : y; out[i + 1] = isPos ? z - z0 : z; out[i + 2] = isPos ? x - cx : x;
    }
    a.setArray(out);
  }
}
for (const n of root.listNodes()) { n.setRotation([0, 0, 0, 1]); n.setTranslation([0, 0, 0]); n.setScale([1, 1, 1]); }
// Materials: the paint named; clearcoat and transmission dropped (glass kept as plain blend).
for (const m of root.listMaterials()) {
  if (m.getName() === paintName) m.setName("paint");
  m.setExtension("KHR_materials_clearcoat", null); m.setExtension("KHR_materials_transmission", null);
}
for (const e of root.listExtensionsUsed()) if (e instanceof KHRMaterialsClearcoat || e instanceof KHRMaterialsTransmission) e.dispose();
// The one texture (a rim's metal) goes: a flat colour at this size.
for (const m of root.listMaterials()) if (m.getBaseColorTexture()) { m.setBaseColorTexture(null); m.setBaseColorFactor([0.55, 0.55, 0.57, 1]); }
for (const t of root.listTextures()) t.dispose();
for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) { p.setAttribute("TEXCOORD_0", null); }
await doc.transform(flatten(), dedup(), join(), weld({ tolerance: 0.0005 }));
// Tyres and the dark under-parts down hard; the rest to the target.
const target = Number(targetArg ?? 0.08);
const tris = () => root.listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log("triangles before", tris());
// The body is kept whole: its panels are few large triangles already (8k of the 346k), and taken to the target they
// came out dented down the doors and rear quarters, plain to see in the 3D 분기점 panel. So are the small parts that
// show (glass, lights, mirrors, badges). The many triangles go where no one looks: the tyres alone are 125k.
const KEEP_UNDER = 3000;
for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) {
  const n = (p.getIndices()?.getCount() ?? 0) / 3;
  if (p.getMaterial()?.getName() === "paint" || n < KEEP_UNDER) continue;
  simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: target, error: 0.0015, lockBorder: false });
}
console.log("triangles after", tris());
await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }), quantize());
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(outFile, doc);
const b = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
console.log("bounds X(across) Y(up) Z(along, front -):", mn.map((v, k) => k).map((k) => (k === 0 ? [mn[1] - cy, mx[1] - cy] : k === 1 ? [0, mx[2] - z0] : [mn[0] - cx, mx[0] - cx]).map((v) => v.toFixed(2)).join("..")).join(" | "));
