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
// end is the front). The wheels — the tyres, rims and their trim, all four in one mesh a material in the download —
// are cut into four nodes wheelFL, wheelFR, wheelRL, wheelRR (front −Z, right +X), each about its own axle (the
// tyre's middle there), for the page to roll them and turn the front ones (car-model.ts). [wheelParts] names the
// materials, the tyre's first.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMaterialsClearcoat, KHRMaterialsTransmission } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplifyPrimitive, flatten, join, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
const [inFile, outFile, targetArg, paintArg, wheelArg] = process.argv.slice(2);
// Material_2125780326 is the wheel's grey face (its spokes, the cover), black_base and black_refl its dark spokes behind;
// their triangles elsewhere on the car stay. The red callipers (red_plastic) stand still, as on the car.
const wheelParts = (wheelArg ?? "Rubber_Rough,Iron_Clean_Distorted,black.001,black.002,black222,Material_2125780326,black_base,black_refl").split(",");
const paintName = paintArg ?? "Material_2125780493";
/** A wheel part's triangle is the wheel's this close to its axle across the car (and within its tyre); see splitWheels. */
const WHEEL_SIDE_M = 0.3;
/**
 * Of these parts, shared with the body, only what is within the rim (RIM_M of the axle): black_base is the wheel arch's
 * lining too, and taken to the tyre's radius a piece of it turned with the wheel and showed below it.
 */
const RIM_PARTS = ["Material_2125780326", "black_base", "black_refl"];
const RIM_M = 0.3;
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
// Cut after the simplifying: a quarter simplified alone keeps more of itself (meshoptimizer's error is a share of the
// mesh's size) — the tyres came out 36k, not 15k.
splitWheels();
await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }), quantize());
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(outFile, doc);
const b = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
console.log("bounds X(across) Y(up) Z(along, front -):", mn.map((v, k) => k).map((k) => (k === 0 ? [mn[1] - cy, mx[1] - cy] : k === 1 ? [0, mx[2] - z0] : [mn[0] - cx, mx[0] - cx]).map((v) => v.toFixed(2)).join("..")).join(" | "));

/**
 * The wheels' parts (one primitive a material after join, all four wheels in each) cut by quadrant into four wheels:
 * each a node at its axle — the middle of its tyre — holding a node a part, the parts' vertices moved to be about it.
 * Of a part whose material is used elsewhere on the car too, only the triangles within a wheel (WHEEL_SIDE_M of its
 * axle across, within its tyre) go; the rest stay where they were. The wheel's face was left on the body, and the
 * tyre turned round a face that stood still (the user, 2026-10-29: "휠커버 쪽은 안돌아가는").
 */
function splitWheels() {
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const parts = root.listMeshes().flatMap((m) => m.listPrimitives().map((p) => ({ m, p }))).filter(({ p }) => wheelParts.includes(p.getMaterial()?.getName()));
  const tyre = parts.find(({ p }) => p.getMaterial().getName() === wheelParts[0]);
  if (!tyre) { console.log("no tyre material", wheelParts[0], "— wheels left whole"); return; }
  const quadOf = (x, z) => (z < 0 ? "F" : "R") + (x < 0 ? "L" : "R");
  // Each wheel's axle: the middle of its tyre's vertices' box.
  const box = {};
  const tp = tyre.p.getAttribute("POSITION");
  for (let i = 0; i < tp.getCount(); i++) {
    const [x, y, z] = tp.getElement(i, []);
    const q = quadOf(x, z), b = (box[q] ??= [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
    for (const [k, v] of [x, y, z].entries()) { b[0][k] = Math.min(b[0][k], v); b[1][k] = Math.max(b[1][k], v); }
  }
  const axle = Object.fromEntries(Object.entries(box).map(([q, b]) => [q, b[0].map((v, k) => (v + b[1][k]) / 2)]));
  const wheels = {};
  for (const q of Object.keys(axle)) {
    wheels[q] = doc.createNode(`wheel${q}`).setTranslation(axle[q]);
    scene.addChild(wheels[q]);
    console.log(`wheel${q} axle`, axle[q].map((v) => v.toFixed(3)).join(", "), "tyre radius", ((box[q][1][1] - box[q][0][1]) / 2).toFixed(3));
  }
  const radius = Object.fromEntries(Object.entries(box).map(([q, b]) => [q, (b[1][1] - b[0][1]) / 2]));
  for (const { m, p } of parts) {
    const pos = p.getAttribute("POSITION"), nor = p.getAttribute("NORMAL"), idx = p.getIndices();
    const tri = idx.getArray();
    const byQuad = {}, stay = [];
    for (let t = 0; t < tri.length; t += 3) {
      const vs = [0, 1, 2].map((k) => pos.getElement(tri[t + k], []));
      const q = quadOf((vs[0][0] + vs[1][0] + vs[2][0]) / 3, (vs[0][2] + vs[1][2] + vs[2][2]) / 3), at = axle[q];
      const reach = RIM_PARTS.includes(p.getMaterial().getName()) ? RIM_M : radius[q];
      // All three corners: a long triangle of the arch's lining with its middle near the hub turned out past the tyre.
      const inside = p === tyre.p || (at && vs.every((v) => Math.abs(v[0] - at[0]) < WHEEL_SIDE_M && Math.hypot(v[1] - at[1], v[2] - at[2]) < reach));
      if (inside) (byQuad[q] ??= []).push(tri[t], tri[t + 1], tri[t + 2]);
      else stay.push(tri[t], tri[t + 1], tri[t + 2]);
    }
    for (const [q, list] of Object.entries(byQuad)) {
      const at = axle[q];
      if (!at) continue;
      // The vertices this wheel's triangles use, about its axle.
      const remap = new Map(), P = [], N = [];
      const out = list.map((v) => {
        if (!remap.has(v)) {
          remap.set(v, remap.size);
          const e = pos.getElement(v, []);
          P.push(e[0] - at[0], e[1] - at[1], e[2] - at[2]);
          if (nor) N.push(...nor.getElement(v, []));
        }
        return remap.get(v);
      });
      const buffer = root.listBuffers()[0];
      const prim = doc.createPrimitive().setMaterial(p.getMaterial())
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(out)).setBuffer(buffer));
      if (nor) prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(N)).setBuffer(buffer));
      const mesh = doc.createMesh(`${p.getMaterial().getName()}-${q}`).addPrimitive(prim);
      wheels[q].addChild(doc.createNode(`${p.getMaterial().getName()}-${q}`).setMesh(mesh));
    }
    if (stay.length) {
      idx.setArray(new Uint32Array(stay));
      console.log(`${p.getMaterial().getName()}: ${stay.length / 3} triangles not in a wheel, left on the car`);
      continue;
    }
    m.removePrimitive(p);
    p.dispose();
    if (m.listPrimitives().length === 0) { for (const n of m.listParents()) if (n.propertyType === "Node") n.setMesh(null); m.dispose(); }
  }
}
