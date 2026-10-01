#!/usr/bin/env python3
"""
정밀도로지도 (국토지리정보원 HD map) into what webNavi serves:

  lines.geojsons   lane lines (B2_SURFACELINEMARK / RM1_LANELINE): t = colour·single/double·solid/dashed, k = kind
  marks.geojsons   road markings (B3_SURFACEMARK / RM2_ROADMARKING): arrows (k 537x–539x), crosswalks …
  links.geojsons   lane-level links (A2_LINK / NT2_LINK), for the lane guidance: lane no., type, turn, from/to/left/right
  lights.geojsons  traffic lights (C1_TRAFFICLIGHT / SF3_TRAFFICLIGHT): t = type (2019: 1–9 a car's, 11 a walker's; 2024: 1xx a car's)
  bumps.geojsons   speed bumps (C4_SPEEDBUMP / SF5_SPEEDBUMP) as polygons; the server takes their middle
  hdmap.mbtiles    lines + marks as vector tiles, zoom 15–18 (tippecanoe), served by the server

The zips are read in place (GDAL /vsizip/): of their 360 GB only the vector
layers, about 2 GB, are touched. Each section comes in three coordinate
systems; one is taken (UTM52N first). Both schemas are read: the 2019 one
(A1_ … C6_) and the 2024 one (NT … SF), named alike in the output.

Every output is written beside itself as <name>.new and moved into place
whole: the server reads these files by their time and must never see a
half of one. A zip that does not open (a download cut short) or whose
vector layers fail their CRC is skipped, named at the end, and makes the
exit code 1; the rest still builds.

  python3 tools/hdmap/build.py /mnt/data/hdmap /mnt/data/webnavi/hdmap [--only 여의도,동작] [--tiles-only]
"""
import argparse, json, os, re, subprocess, sys, zipfile, shutil
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("src", help="the folder of 정밀도로지도 zips")
ap.add_argument("out", help="where the layers and tiles go (the server's WORK_DIR/hdmap)")
ap.add_argument("--only", metavar="이름,이름", help="only the zips whose names contain one of these (--only=… works too)")
# The layer files are there already: only clean them and make the tiles again.
ap.add_argument("--tiles-only", action="store_true", help="the layer files are there: clean them and make the tiles again")
ap.add_argument("--layers", metavar="lights,bumps", help="only these layers (the others' files are left as they are; no tiles unless lines or marks are among them)")
ARGS = ap.parse_args()
SRC, OUT = ARGS.src, ARGS.out
ONLY = [o for o in ARGS.only.split(",") if o] if ARGS.only else None
TILES_ONLY = ARGS.tiles_only
ONLY_LAYERS = [l for l in ARGS.layers.split(",") if l] if ARGS.layers else None
GDAL = "ghcr.io/osgeo/gdal:alpine-small-latest"
TIPPE = "klokantech/tippecanoe:latest"
FOLDERS = ["HDMap_UTM52N_타원체고", "HDMap_UTMK_정표고", "HDMap_UTM-K_정표고", "HDMap_UTMK_타원체고", "HDMap_UTM-K_타원체고"]
# Output layer → the source layers (2019, 2024), and each output field's source names: the
# sections are not all alike (a field missing, ToNodeId or ToNodeID), so what is there is taken.
LAYERS = {
    "lines": [("B2_SURFACELINEMARK", {"t": ["Type"], "k": ["Kind"]}), ("RM1_LANELINE", {"t": ["LineType"], "k": ["LineKind"]})],
    "marks": [("B3_SURFACEMARK", {"t": ["Type"], "k": ["Kind"]}), ("RM2_ROADMARKING", {"t": ["MarkType"], "k": ["MarkKind"]})],
    "links": [(layer, {"id": ["ID"], "lane": ["LaneNo"], "type": ["LinkType"], "turn": ["Turn"], "v": ["MaxSpeed"],
                       "a": ["FromNodeID"], "b": ["ToNodeID"], "l": ["L_LinkID"], "r": ["R_LinkID"]})
              for layer in ("A2_LINK", "NT2_LINK")],
    "lights": [("C1_TRAFFICLIGHT", {"id": ["ID"], "t": ["Type"], "link": ["LinkID"]}), ("SF3_TRAFFICLIGHT", {"id": ["ID"], "t": ["LightType"]})],
    "bumps": [("C4_SPEEDBUMP", {"id": ["ID"], "link": ["LinkID"]}), ("SF5_SPEEDBUMP", {"id": ["ID"]})],
}
if ONLY_LAYERS:
    unknown = [l for l in ONLY_LAYERS if l not in LAYERS]
    if unknown: sys.exit(f"모르는 레이어: {unknown} (있는 것: {list(LAYERS)})")
    LAYERS = {k: v for k, v in LAYERS.items() if k in ONLY_LAYERS}
USED = {shp_layer for choices in LAYERS.values() for shp_layer, _ in choices}
# Korea, with room: a feature outside it (one sits at 73.7 N) would stretch the tiles' bounds over nothing.
LON = (124.0, 132.0)
LAT = (33.0, 39.0)
# The zips skipped, (name, why): told at the end, and the exit code says so.
BAD = []

# The coordinate system by the folder's name, for a section whose .prj is missing.
def srs_of(folder):
    return "EPSG:32652" if "UTM52N" in folder else "EPSG:5179"

def damaged(z, members):
    """The first of [members] whose bytes do not match their CRC, or None; what testzip() does, for these only."""
    for info in members:
        try:
            with z.open(info) as f:
                while f.read(1 << 20):
                    pass
        # A bad CRC is BadZipFile; a header smashed reads as anything (zlib.error, UnicodeDecodeError …).
        except Exception:
            return info.filename
    return None

def sections():
    """(zip, section folder, {layer name: inner path}) for each section, one coordinate system each.

    Each zip is checked before anything is converted: one that does not open (a download cut short
    has no central directory) or whose vector layers fail their CRC goes into BAD and is skipped whole.
    """
    for name in sorted(os.listdir(SRC)):
        if not name.endswith(".zip") or (ONLY and not any(o in name for o in ONLY)):
            continue
        path = os.path.join(SRC, name)
        try:
            if not zipfile.is_zipfile(path):
                raise zipfile.BadZipFile("zip이 아니거나 끝이 잘림")
            z = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as e:
            BAD.append((name, str(e)))
            print(f"건너뜀 {name}: {e}", flush=True)
            continue
        by = {}
        for i in z.infolist():
            m = re.match(r"(.*?)/?(HDMap_[^/]+)/([^/]+)\.shp$", i.filename)
            if m:
                by.setdefault(m.group(1), {}).setdefault(m.group(2), {})[m.group(3)] = i.filename
        found = []
        for sec, folders in by.items():
            folder = next((f for f in FOLDERS if f in folders), next(iter(folders)))
            found.append((sec, folders[folder]))
        # Only the members ogr2ogr will read (the layers' .shp/.shx/.dbf/.prj …): a full testzip()
        # would read all 360 GB for the 2 GB that matter.
        stems = {inner[:-4] for _, files in found for layer, inner in files.items() if layer in USED}
        bad = damaged(z, [i for i in z.infolist() if i.filename.rsplit(".", 1)[0] in stems])
        if bad:
            BAD.append((name, f"CRC 불일치: {bad}"))
            print(f"건너뜀 {name}: CRC 불일치 {bad}", flush=True)
            continue
        for sec, files in found:
            yield name, sec, files

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def in_korea(coords):
    """Whether every coordinate of a geometry's coordinates (however deep) lies within LON × LAT."""
    if not isinstance(coords, list):
        return False
    if coords and isinstance(coords[0], (int, float)):
        return len(coords) >= 2 and LON[0] <= coords[0] <= LON[1] and LAT[0] <= coords[1] <= LAT[1]
    return all(in_korea(c) for c in coords)

def clean_join(parts, out_path):
    """The parts into one file, a feature a line; anything else (a half-written part, NUL bytes, a
    feature off the map) is left out. Written as <out>.new and moved into place whole, so the server
    never reads a half of it. Returns (kept, bad lines dropped, features outside Korea dropped)."""
    kept = dropped = far = 0
    tmp = out_path + ".new"
    with open(tmp, "w", encoding="utf-8") as out:
        for part in parts:
            with open(part, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.replace("\0", "").strip()
                    if not line:
                        continue
                    try:
                        feature = json.loads(line)
                        if feature.get("type") != "Feature" or not feature.get("geometry"):
                            raise ValueError
                    except ValueError:
                        dropped += 1
                        continue
                    if not in_korea(feature["geometry"].get("coordinates")):
                        far += 1
                        continue
                    out.write(line + "\n")
                    kept += 1
    os.replace(tmp, out_path)
    return kept, dropped, far

def tiles():
    # Lines and markings as tiles: every feature kept (a lane line dropped is a lie), simplified only a little.
    tmp = os.path.join(OUT, "hdmap.mbtiles.new")
    if os.path.exists(tmp): os.remove(tmp)
    r = run(["docker", "run", "--rm", "-v", f"{OUT}:/out", TIPPE, "tippecanoe", "-o", "/out/hdmap.mbtiles.new", "-Z15", "-z18",
             "--no-feature-limit", "--no-tile-size-limit", "--simplification=2", "--force", "-q", "-n", "정밀도로지도",
             "-A", "© 국토지리정보원 정밀도로지도 (공공누리 1유형)",
             "-L", "lines:/out/lines.geojsons", "-L", "marks:/out/marks.geojsons"])
    # tippecanoe stops reading at a bad line and still exits 0: its complaints are failures here.
    if r.returncode or re.search(r"unexpected|error", r.stderr, re.I):
        report_bad()
        sys.exit(r.stderr[-2000:])
    os.replace(tmp, os.path.join(OUT, "hdmap.mbtiles"))
    print(f"hdmap.mbtiles: {os.path.getsize(os.path.join(OUT, 'hdmap.mbtiles')) / 1e6:.0f} MB", flush=True)

def report_bad():
    """The zips skipped, named, so a download cut short is not lost among the output."""
    if not BAD:
        return
    print(f"건너뛴 zip {len(BAD)}개 (다시 받을 것):", flush=True)
    for name, why in BAD:
        print(f"  {name}: {why}", flush=True)

def finish():
    """The zips skipped, named; the exit code says a download was cut short."""
    report_bad()
    if BAD:
        sys.exit(1)

def main():
    if TILES_ONLY:
        for layer in LAYERS:
            path = os.path.join(OUT, f"{layer}.geojsons")
            kept, dropped, far = clean_join([path], path)
            print(f"{layer}: {kept} features, {dropped} bad lines dropped, {far} outside Korea dropped", flush=True)
        return tiles()
    stage = os.path.join(OUT, "stage")
    shutil.rmtree(stage, ignore_errors=True)
    for layer in LAYERS: os.makedirs(os.path.join(stage, layer), exist_ok=True)
    # The zips looked over first (a bad one is skipped whole), before the container comes up.
    found = list(sections())
    # One GDAL container for all the conversions, the zips mounted read-only.
    run(["docker", "rm", "-f", "hdmap-gdal"])
    r = run(["docker", "run", "-d", "--name", "hdmap-gdal", "-v", f"{SRC}:/src:ro", "-v", f"{OUT}:/out", GDAL, "sleep", "infinity"])
    if r.returncode: sys.exit(r.stderr)
    jobs = []
    for n, (zname, sec, files) in enumerate(found):
        for layer, choices in LAYERS.items():
            for shp_layer, cols in choices:
                inner = files.get(shp_layer)
                if inner:
                    folder = inner.split("/")[-2]
                    jobs.append((f"/vsizip//src/{zname}/{inner}", shp_layer, cols, f"/out/stage/{layer}/{n:05d}.geojsons", srs_of(folder)))
    print(f"변환 {len(jobs)}건", flush=True)
    done = [0]
    def convert(job):
        path, shp_layer, cols, out, srs = job
        info = run(["docker", "exec", "hdmap-gdal", "ogrinfo", "-ro", "-so", "-al", path])
        have = {m.group(1).lower(): m.group(1) for m in re.finditer(r"^(\w+): (?:String|Integer|Integer64|Real)", info.stdout, re.M)}
        picked = [f"{have[src.lower()]} AS {dst}" for dst, srcs in cols.items() for src in srcs[:1] if src.lower() in have]
        if not picked:
            done[0] += 1
            return
        r = run(["docker", "exec", "hdmap-gdal", "ogr2ogr", "-f", "GeoJSONSeq", "-s_srs", srs, "-t_srs", "EPSG:4326", "-dim", "2",
                 "-lco", "RS=NO", "-lco", "COORDINATE_PRECISION=7", "-sql", f"SELECT {', '.join(picked)} FROM \"{shp_layer}\"", out, path])
        done[0] += 1
        if done[0] % 200 == 0: print(f"  {done[0]}/{len(jobs)}", flush=True)
        if r.returncode: print(f"  실패 {path}: {r.stderr.strip()[:200]}", flush=True)
    with ThreadPoolExecutor(6) as pool: list(pool.map(convert, jobs))
    run(["docker", "rm", "-f", "hdmap-gdal"])
    # One file a layer, a whole feature a line.
    for layer in LAYERS:
        parts = [os.path.join(stage, layer, f) for f in sorted(os.listdir(os.path.join(stage, layer)))]
        kept, dropped, far = clean_join(parts, os.path.join(OUT, f"{layer}.geojsons"))
        print(f"{layer}: {kept} features ({dropped} bad lines, {far} outside Korea dropped), {os.path.getsize(os.path.join(OUT, f'{layer}.geojsons')) / 1e6:.0f} MB", flush=True)
    shutil.rmtree(stage, ignore_errors=True)
    if "lines" in LAYERS or "marks" in LAYERS: tiles()

main()
finish()
