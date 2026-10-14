#!/usr/bin/env python3
"""
정밀도로지도 in three dimensions, for the junction view (web/src/junction-view.ts):

  j3d.db   lane links, lane lines and road markings with their heights, an R-tree over them:
           f(id, kind 0 link · 1 line · 2 mark, yr survey year, t type, k kind, xyz JSON [[lon, lat, h], …])

Heights are the survey's ellipsoidal heights (타원체고), every section the same: a section's other
choice (정표고, above the geoid) sits some 25 m lower in Korea, and two sections of one junction taken
from different folders would meet with a step. 4,168 of the 4,169 sections have a 타원체고 folder; the
one without is left out.

The zips are read in place (GDAL /vsizip/), as build.py does; the output is written as j3d.db.new and
moved into place whole.

  python3 tools/hdmap/build3d.py /mnt/data/hdmap /mnt/data/webnavi/hdmap [--only 서울외곽,송파]
"""
import argparse, json, os, re, sqlite3, subprocess, sys, zipfile, shutil
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("src", help="the folder of 정밀도로지도 zips")
ap.add_argument("out", help="where j3d.db goes (the server's WORK_DIR/hdmap)")
ap.add_argument("--only", metavar="이름,이름", help="only the zips whose names contain one of these")
ARGS = ap.parse_args()
SRC, OUT = ARGS.src, ARGS.out
ONLY = [o for o in ARGS.only.split(",") if o] if ARGS.only else None
GDAL = "ghcr.io/osgeo/gdal:alpine-small-latest"
# The ellipsoidal folders, UTM-K first (the more common).
FOLDERS = ["HDMap_UTMK_타원체고", "HDMap_UTM-K_타원체고", "HDMap_UTM52N_타원체고"]
# kind → the source layers (2019, 2024) and the columns read: ID, and type and kind where there are.
LAYERS = {
    0: [("A2_LINK", {"id": ["ID"]}), ("NT2_LINK", {"id": ["ID"]})],
    1: [("B2_SURFACELINEMARK", {"id": ["ID"], "t": ["Type"], "k": ["Kind"]}), ("RM1_LANELINE", {"id": ["ID"], "t": ["LineType"], "k": ["LineKind"]})],
    2: [("B3_SURFACEMARK", {"id": ["ID"], "t": ["Type"], "k": ["Kind"]}), ("RM2_ROADMARKING", {"id": ["ID"], "t": ["MarkType"], "k": ["MarkKind"]})],
}
USED = {shp for choices in LAYERS.values() for shp, _ in choices}
LON = (124.0, 132.0)
LAT = (33.0, 39.0)

def srs_of(folder):
    return "EPSG:32652" if "UTM52N" in folder else "EPSG:5179"

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

def sections():
    """(zip, {layer: inner path}) for each section that has an ellipsoidal folder."""
    skipped = 0
    for name in sorted(os.listdir(SRC)):
        if not name.endswith(".zip") or (ONLY and not any(o in name for o in ONLY)):
            continue
        try:
            z = zipfile.ZipFile(os.path.join(SRC, name))
        except (zipfile.BadZipFile, OSError) as e:
            print(f"건너뜀 {name}: {e}", flush=True)
            continue
        by = {}
        for i in z.infolist():
            m = re.match(r"(.*?)/?(HDMap_[^/]+)/([^/]+)\.shp$", i.filename)
            if m and m.group(3) in USED:
                by.setdefault(m.group(1), {}).setdefault(m.group(2), {})[m.group(3)] = i.filename
        for sec, folders in by.items():
            folder = next((f for f in FOLDERS if f in folders), None)
            if not folder:
                skipped += 1
                continue
            yield name, folders[folder], folder
    if skipped:
        print(f"타원체고 없는 단면 {skipped}개 뺌", flush=True)

def year(fid):
    if not fid:
        return 0
    yy = fid[3:5] if fid.startswith("NT") else fid[2:4]
    return int(yy) if yy.isdigit() else 0

def main():
    stage = os.path.join(OUT, "stage3d")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage, exist_ok=True)
    found = list(sections())
    run(["docker", "rm", "-f", "hdmap-gdal3d"])
    r = run(["docker", "run", "-d", "--name", "hdmap-gdal3d", "-v", f"{SRC}:/src:ro", "-v", f"{OUT}:/out", GDAL, "sleep", "infinity"])
    if r.returncode:
        sys.exit(r.stderr)
    jobs = []
    for n, (zname, files, folder) in enumerate(found):
        for kind, choices in LAYERS.items():
            for shp, cols in choices:
                inner = files.get(shp)
                if inner:
                    jobs.append((f"/vsizip//src/{zname}/{inner}", shp, cols, f"/out/stage3d/{kind}-{n:05d}.geojsons", srs_of(folder)))
    print(f"단면 {len(found)}개, 변환 {len(jobs)}건", flush=True)
    done = [0]

    def convert(job):
        path, shp, cols, out, srs = job
        info = run(["docker", "exec", "hdmap-gdal3d", "ogrinfo", "-ro", "-so", "-al", path])
        have = {m.group(1).lower(): m.group(1) for m in re.finditer(r"^(\w+): (?:String|Integer|Integer64|Real)", info.stdout, re.M)}
        picked = [f"{have[src.lower()]} AS {dst}" for dst, srcs in cols.items() for src in srcs[:1] if src.lower() in have]
        if picked:
            r = run(["docker", "exec", "hdmap-gdal3d", "ogr2ogr", "-f", "GeoJSONSeq", "-s_srs", srs, "-t_srs", "EPSG:4326", "-dim", "XYZ",
                     "-lco", "RS=NO", "-lco", "COORDINATE_PRECISION=7", "-sql", f"SELECT {', '.join(picked)} FROM \"{shp}\"", out, path])
            if r.returncode:
                print(f"  실패 {path}: {r.stderr.strip()[:200]}", flush=True)
        done[0] += 1
        if done[0] % 500 == 0:
            print(f"  {done[0]}/{len(jobs)}", flush=True)

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(convert, jobs))
    run(["docker", "rm", "-f", "hdmap-gdal3d"])

    tmp = os.path.join(OUT, "j3d.db.new")
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute("PRAGMA journal_mode = OFF")
    db.execute("PRAGMA synchronous = OFF")
    db.execute("CREATE TABLE f (id INTEGER PRIMARY KEY, kind INTEGER, yr INTEGER, t TEXT, k TEXT, xyz TEXT)")
    db.execute("CREATE VIRTUAL TABLE box USING rtree(id, minx, maxx, miny, maxy)")
    counts = {0: 0, 1: 0, 2: 0}
    rows, boxes, nid = [], [], 0

    def flush():
        db.executemany("INSERT INTO f VALUES (?, ?, ?, ?, ?, ?)", rows)
        db.executemany("INSERT INTO box VALUES (?, ?, ?, ?, ?)", boxes)
        rows.clear()
        boxes.clear()

    def parts(geom):
        """A geometry's lines (a line's points; a polygon's outer ring), each [[lon, lat, h], …]."""
        g, c = geom.get("type"), geom.get("coordinates")
        if g == "LineString": return [c]
        if g == "MultiLineString": return c
        if g == "Polygon": return [c[0]]
        if g == "MultiPolygon": return [p[0] for p in c]
        return []

    for fn in sorted(os.listdir(stage)):
        kind = int(fn.split("-")[0])
        with open(os.path.join(stage, fn), encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.replace("\0", "").strip()
                if not line:
                    continue
                try:
                    feat = json.loads(line)
                except ValueError:
                    continue
                props = feat.get("properties") or {}
                for pts in parts(feat.get("geometry") or {}):
                    pts = [p for p in pts if len(p) >= 3 and LON[0] <= p[0] <= LON[1] and LAT[0] <= p[1] <= LAT[1]]
                    if len(pts) < 2:
                        continue
                    nid += 1
                    xyz = json.dumps([[round(p[0], 7), round(p[1], 7), round(p[2], 2)] for p in pts], separators=(",", ":"))
                    rows.append((nid, kind, year(props.get("id")), str(props.get("t") or ""), str(props.get("k") or ""), xyz))
                    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                    boxes.append((nid, min(xs), max(xs), min(ys), max(ys)))
                    counts[kind] += 1
                    if len(rows) >= 20000:
                        flush()
    flush()
    db.commit()
    db.close()
    os.replace(tmp, os.path.join(OUT, "j3d.db"))
    shutil.rmtree(stage, ignore_errors=True)
    print(f"j3d.db: 링크 {counts[0]} · 차선 {counts[1]} · 노면표시 {counts[2]}, {os.path.getsize(os.path.join(OUT, 'j3d.db')) / 1e6:.0f} MB", flush=True)

main()
