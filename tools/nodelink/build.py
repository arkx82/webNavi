#!/usr/bin/env python3
"""
표준노드링크 (its.go.kr 전국표준노드링크) into a road graph OSRM routes on:

  korea.osm      OSM XML made from it — every link a one-way way with its class, limit,
                 lanes and name; every 회전제한 a restriction relation (from, via node, to)
  korea.osrm.*   OSRM's MLD graph: osrm-extract (the car profile), osrm-partition,
                 osrm-customize, run in the osrm/osrm-backend image. docker compose's
                 osrm service serves it (serve.sh); the nav server asks it as the "korea" provider.
  links.db       SQLite: each link's OSM node sequence and limit, for the live speeds the nav
                 server writes (speeds.csv, from ITS 소통정보 — the same link ids) and for
                 reading a route's links back from OSRM's node annotation.

The zip's shapefiles are read with GDAL in its container (the coordinates come as
ITRF2000 TM, EPSG:5186, and go out as lon/lat). Links carry their direction (F_NODE →
T_NODE); a link's line drawn the other way round is turned to match its nodes.

Codes, from the 표준노드링크 구축기준 (국토해양부고시 제2008-26호):
  ROAD_RANK 101 고속국도 102 도시고속국도 103 일반국도 104 특별·광역시도 105 국가지원지방도 106 지방도 107 시·군도 108 기타
  ROAD_TYPE 000 일반 001 고가차도 002 지하차도 003 교량 004 터널
  CONNECT   000 아님, else a ramp of that rank
  ROAD_USE  0 사용 1 미사용
  TURN_TYPE 001 비보호회전 002 버스만회전 003 회전금지 011 유턴 012 P턴 101 좌회전금지 102 직진금지 103 우회전금지
            (the 고시's table reads ambiguously; these are what the links' geometry says: 011 turns back 96 % of
            the time, 101 goes left 87 %, 102 straight 83 %, 103 right 91 %). 011 and 012 say where a U-turn is
            allowed — kept aside for the U-turn rule (not yet applied); the rest are prohibitions.
  TURN_OPER 0 전일제 1 시간제

Every output is written as <name>.new and moved into place whole.

  python3 tools/nodelink/build.py /mnt/data/nodelink/2026-09-14 /mnt/data/webnavi/nodelink [--osm-only] [--graph-only]
"""
import argparse, csv, json, math, os, sqlite3, subprocess, sys, time
from xml.sax.saxutils import quoteattr

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("src", help="the unzipped NODELINKDATA folder (MOCT_LINK.shp, MOCT_NODE.shp, TURNINFO.dbf)")
ap.add_argument("out", help="where korea.osm and the OSRM graph go (the osrm service's /data)")
ap.add_argument("--osm-only", action="store_true", help="write korea.osm and stop")
ap.add_argument("--graph-only", action="store_true", help="korea.osm is there: only run OSRM's three steps")
ap.add_argument("--max-via", type=int, default=4, help="restrictions crossing more inner links than this are left out (to try the engine)")
ARGS = ap.parse_args()
SRC, OUT = os.path.abspath(ARGS.src), os.path.abspath(ARGS.out)
GDAL = "ghcr.io/osgeo/gdal:alpine-small-latest"
# 6.0: 5.26 (Docker Hub's "latest") dies in osrm-customize on a restriction via several ways, which a
# junction drawn as a ring of inner links makes of most left turns.
OSRM = "ghcr.io/project-osrm/osrm-backend:v6.0.0"

HIGHWAY = {"101": "motorway", "102": "trunk", "103": "primary", "104": "secondary", "105": "secondary", "106": "tertiary", "107": "unclassified", "108": "unclassified"}
# A ramp's class: OSRM's car profile drives a *_link a little slower and turns onto it more freely.
LINK_OF = {"motorway": "motorway_link", "trunk": "trunk_link", "primary": "primary_link", "secondary": "secondary_link", "tertiary": "tertiary_link"}
# What is prohibited, as OSRM's restriction kinds (for a via-node or via-way restriction the kind itself is
# not used, only that it is a "no_"). 002 버스만회전: not for a car either.
RESTRICTION = {"002": "no_left_turn", "003": "no_u_turn", "101": "no_left_turn", "102": "no_straight_on", "103": "no_right_turn"}
# Vertices inside a link get ids above every MOCT node id (10 digits).
VERTEX_BASE = 10 ** 11
# A junction's inner links are a few tens of metres; a turn's via path is at most a ring's worth of them.
INNER_M = 80
INNER_HOPS = 4
# A ring of inner links has this many at most (four at a crossroads, five at a five-way junction).
RING_MAX = 5
# A way back is one leaving within this many degrees of straight against the way in.
UTURN_DEG = 35

def bearing(a, b):
    dx = (b[0] - a[0]) * math.cos(math.radians(a[1]))
    return math.degrees(math.atan2(dx, b[1] - a[1])) % 360

def rings(inner, ends, out_links):
    """Every simple cycle of inner links (as a tuple of link ids, in driving order), each once."""
    found = set()
    for start in inner:
        a, b = ends[start]
        stack = [(b, [start])]
        while stack:
            node, path = stack.pop()
            for lid, to in out_links.get(node, []):
                if lid not in inner or lid in path:
                    continue
                if to == a:
                    cycle = path + [lid]
                    i = cycle.index(min(cycle))
                    found.add(tuple(cycle[i:] + cycle[:i]))
                elif len(path) + 1 < RING_MAX:
                    stack.append((to, path + [lid]))
    return sorted(found)

def length_m(line):
    m = 0.0
    for (x1, y1), (x2, y2) in zip(line, line[1:]):
        m += math.hypot((x2 - x1) * 111320 * math.cos(math.radians(y1)), (y2 - y1) * 111320)
    return m

def inner_path(start, goal, out_links, inner):
    """The inner links from node [start] to node [goal] (fewest hops), [] when they are one node, None when there is no short way."""
    if start == goal:
        return []
    frontier = [(start, [])]
    seen = {start}
    for _ in range(INNER_HOPS):
        nxt = []
        for node, path in frontier:
            for lid, to in out_links.get(node, []):
                if lid not in inner:
                    continue
                if to == goal:
                    return path + [lid]
                if to not in seen:
                    seen.add(to)
                    nxt.append((to, path + [lid]))
        frontier = nxt
    return None

def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        sys.exit(f"{' '.join(cmd[:4])} …: {r.stderr[-2000:]}")
    return r

def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def stage():
    """The shapefiles as GeoJSONSeq in lon/lat (links, nodes) and CSV (turns), under OUT/stage."""
    st = os.path.join(OUT, "stage")
    os.makedirs(st, exist_ok=True)
    conv = ["docker", "run", "--rm", "-v", f"{SRC}:/src:ro", "-v", f"{st}:/st", GDAL]
    say("links → lon/lat")
    run(conv + ["ogr2ogr", "-f", "GeoJSONSeq", "/st/links.geojsons", "/src/MOCT_LINK.shp", "-t_srs", "EPSG:4326", "--config", "SHAPE_ENCODING", "CP949",
                "-select", "LINK_ID,F_NODE,T_NODE,LANES,ROAD_RANK,ROAD_TYPE,ROAD_NO,ROAD_NAME,ROAD_USE,CONNECT,MAX_SPD", "-lco", "COORDINATE_PRECISION=7"])
    say("nodes → lon/lat")
    run(conv + ["ogr2ogr", "-f", "GeoJSONSeq", "/st/nodes.geojsons", "/src/MOCT_NODE.shp", "-t_srs", "EPSG:4326", "--config", "SHAPE_ENCODING", "CP949",
                "-select", "NODE_ID,NODE_TYPE,NODE_NAME", "-lco", "COORDINATE_PRECISION=7"])
    say("turns → csv")
    run(conv + ["ogr2ogr", "-f", "CSV", "/st/turns.csv", "/src/TURNINFO.dbf"])
    return st

def features(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)

def tag(k, v):
    return f'<tag k="{k}" v={quoteattr(str(v))}/>'

def write_osm(st):
    """korea.osm: nodes (MOCT's, then the links' inner vertices), ways, restriction relations — in that order, as OSM readers expect."""
    say("reading nodes")
    nodes = {}
    for f in features(os.path.join(st, "nodes.geojsons")):
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        nodes[p["NODE_ID"]] = (lon, lat, p.get("NODE_NAME") or "")
    say(f"{len(nodes)} nodes")
    tmp = os.path.join(OUT, "korea.osm.new")
    ways = {}          # LINK_ID → (node ids, tags)
    ends = {}          # LINK_ID → (F_NODE, T_NODE), for the restrictions
    out_links = {}     # node → [(LINK_ID, T_NODE)], the links leaving it
    in_links = {}      # node → [LINK_ID], the links arriving at it
    inner = set()      # the short links a junction is drawn with (a turn's via path runs over these)
    heading = {}       # LINK_ID → (bearing leaving F_NODE, bearing arriving at T_NODE)
    limits = {}        # LINK_ID → MAX_SPD, for links.db
    unused = flipped = missing = 0
    vertex = VERTEX_BASE
    with open(tmp, "w", encoding="utf-8", buffering=1 << 20) as out:
        out.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="webnavi nodelink">\n')
        for nid, (lon, lat, _) in nodes.items():
            out.write(f'<node id="{int(nid)}" lat="{lat}" lon="{lon}" version="1"/>\n')
        say("links")
        n = 0
        for f in features(os.path.join(st, "links.geojsons")):
            p = f["properties"]
            n += 1
            if n % 200000 == 0:
                say(f"  {n} links")
            if p.get("ROAD_USE") == "1":
                unused += 1
                continue
            a, b = p["F_NODE"], p["T_NODE"]
            if a not in nodes or b not in nodes:
                missing += 1
                continue
            g = f["geometry"]
            line = g["coordinates"][0] if g["type"] == "MultiLineString" else g["coordinates"]
            if len(line) < 2:
                missing += 1
                continue
            # The line runs F → T; one drawn the other way is turned (judged by which end is nearer F).
            fa, ta = nodes[a], nodes[b]
            d_head = abs(line[0][0] - fa[0]) + abs(line[0][1] - fa[1])
            d_tail = abs(line[-1][0] - fa[0]) + abs(line[-1][1] - fa[1])
            if d_tail < d_head:
                line = line[::-1]
                flipped += 1
            ids = [int(a)]
            for lon, lat in (c[:2] for c in line[1:-1]):
                vertex += 1
                out.write(f'<node id="{vertex}" lat="{lat}" lon="{lon}" version="1"/>\n')
                ids.append(vertex)
            ids.append(int(b))
            rank = p.get("ROAD_RANK") or "108"
            highway = HIGHWAY.get(rank, "unclassified")
            if (p.get("CONNECT") or "0").strip("0"):
                highway = LINK_OF.get(highway, highway)
            tags = [tag("highway", highway), tag("oneway", "yes")]
            spd = p.get("MAX_SPD")
            if spd and int(spd) > 0:
                tags.append(tag("maxspeed", int(spd)))
                limits[p["LINK_ID"]] = int(spd)
            lanes = p.get("LANES")
            if lanes and int(lanes) > 0:
                tags.append(tag("lanes", int(lanes)))
            name = (p.get("ROAD_NAME") or "").strip()
            if name and name != "-":
                tags.append(tag("name", name))
            no = (p.get("ROAD_NO") or "").strip()
            if no and no != "-":
                tags.append(tag("ref", no))
            rt = p.get("ROAD_TYPE") or "000"
            if rt in ("001", "003"):
                tags.append(tag("bridge", "yes"))
            elif rt in ("002", "004"):
                tags.append(tag("tunnel", "yes"))
            tags.append(tag("nodelink:rank", rank))
            ways[p["LINK_ID"]] = (ids, tags)
            ends[p["LINK_ID"]] = (a, b)
            out_links.setdefault(a, []).append((p["LINK_ID"], b))
            in_links.setdefault(b, []).append(p["LINK_ID"])
            heading[p["LINK_ID"]] = (bearing(line[0], line[1]), bearing(line[-2], line[-1]))
            if length_m(line) <= INNER_M:
                inner.add(p["LINK_ID"])
        say(f"{len(ways)} ways ({unused} unused links left out, {missing} without both nodes, {flipped} turned round)")
        for lid, (ids, tags) in ways.items():
            out.write(f'<way id="{int(lid)}" version="1">')
            out.write("".join(f'<nd ref="{i}"/>' for i in ids))
            out.write("".join(tags))
            out.write("</way>\n")
        # 회전제한: from the link into the node, to the link out of it. A big junction is drawn as a
        # ring of short inner links between several nodes (…101 → …104 → …103 → …102 → …101), so the
        # turn from the link that ends at one node to the link that leaves another is a path over
        # those inner links: a restriction "via" those ways, in order (OSRM takes several). A turn whose
        # links are not there, or that no short path joins, is counted and left out.
        rid = kept = skipped = timed = 0
        via_hops = {}
        def relation(from_link, path, to_link, kind):
            nonlocal rid
            rid += 1
            via = f'<member type="node" ref="{int(ends[from_link][1])}" role="via"/>' if not path else "".join(f'<member type="way" ref="{int(w)}" role="via"/>' for w in path)
            out.write(f'<relation id="{rid}" version="1"><member type="way" ref="{int(from_link)}" role="from"/>{via}'
                      f'<member type="way" ref="{int(to_link)}" role="to"/>{tag("type", "restriction")}{tag("restriction", kind)}</relation>\n')
        allowed_back = set()
        with open(os.path.join(st, "turns.csv"), encoding="utf-8") as f:
            for t in csv.DictReader(f):
                if t["TURN_TYPE"] in ("011", "012"):
                    allowed_back.add((t["ST_LINK"], t["ED_LINK"]))
                kind = RESTRICTION.get(t["TURN_TYPE"])
                if not kind:
                    continue
                st_link, ed_link = t["ST_LINK"], t["ED_LINK"]
                if st_link not in ends or ed_link not in ends:
                    skipped += 1
                    continue
                path = inner_path(ends[st_link][1], ends[ed_link][0], out_links, inner)
                if path is None or len(path) > ARGS.max_via:
                    skipped += 1
                    continue
                kept += 1
                via_hops[len(path)] = via_hops.get(len(path), 0) + 1
                if t.get("TURN_OPER") == "1":
                    timed += 1
                relation(st_link, path, ed_link, kind)
        say(f"restrictions by inner links crossed: {dict(sorted(via_hops.items()))}")
        # A junction drawn as a ring can be driven round and round, which no road allows and which
        # takes any restriction away (round once more and the "from" link is another). So: no going
        # the whole way round (each ring link to the one before it, via the rest), and no turning back
        # through the ring — in at one link, round, out on the way back — unless 표준노드링크 says a
        # U-turn (011) or P-turn (012) is allowed there.
        circles = 0
        for ring in rings(inner, ends, out_links):
            n = len(ring)
            for i in range(n):
                seq = ring[i:] + ring[:i]
                relation(seq[0], list(seq[1:-1]), seq[-1], "no_u_turn")
                circles += 1
        say(f"{circles} ring restrictions (no driving the whole way round)")
        backs = 0
        for ring in rings(inner, ends, out_links):
            n = len(ring)
            nodes_in_order = [ends[l][0] for l in ring]  # ring[i] leaves nodes_in_order[i]
            for i, node in enumerate(nodes_in_order):
                # The way back leaves the node before this one; the path there is the ring bar its last link.
                prev = nodes_in_order[i - 1]
                path = list((ring[i:] + ring[:i])[:n - 1])
                for arriving in in_links.get(node, []):
                    if arriving in inner:
                        continue
                    for leaving, _to in out_links.get(prev, []):
                        if leaving in inner or (arriving, leaving) in allowed_back:
                            continue
                        against = abs((heading[leaving][0] - heading[arriving][1] + 180) % 360 - 180)
                        if against >= 180 - UTURN_DEG:
                            relation(arriving, path, leaving, "no_u_turn")
                            backs += 1
        say(f"{backs} U-turns through a ring forbidden ({len(allowed_back)} allowed by 표준노드링크 left open)")
        out.write("</osm>\n")
    os.replace(tmp, os.path.join(OUT, "korea.osm"))
    write_links_db(ways, ends, limits)
    say(f"korea.osm: {os.path.getsize(os.path.join(OUT, 'korea.osm')) / 1e9:.2f} GB, {kept} restrictions ({skipped} not on their links, {timed} part-time ones kept as full-time)")

def write_links_db(ways, ends, limits):
    """links.db: id → f, t, limit, the OSM node ids along it (comma-joined), indexed by (f, t) too."""
    tmp = os.path.join(OUT, "links.db.new")
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute("CREATE TABLE links (id TEXT PRIMARY KEY, f TEXT, t TEXT, maxspd INTEGER, nodes TEXT)")
    db.executemany("INSERT INTO links VALUES (?, ?, ?, ?, ?)",
                   ((lid, ends[lid][0], ends[lid][1], limits.get(lid), ",".join(map(str, ids))) for lid, (ids, _) in ways.items()))
    db.execute("CREATE INDEX links_ft ON links (f, t)")
    db.commit()
    db.close()
    os.replace(tmp, os.path.join(OUT, "links.db"))
    say(f"links.db: {os.path.getsize(os.path.join(OUT, 'links.db')) / 1e6:.0f} MB")

def graph():
    """OSRM's three steps over korea.osm, in its image; the files land beside it."""
    osrm = ["docker", "run", "--rm", "-v", f"{OUT}:/data", OSRM]
    say("osrm-extract")
    run(osrm + ["osrm-extract", "-p", "/opt/car.lua", "/data/korea.osm"])
    say("osrm-partition")
    run(osrm + ["osrm-partition", "/data/korea.osrm"])
    say("osrm-customize")
    run(osrm + ["osrm-customize", "/data/korea.osrm"])
    say("graph ready: " + ", ".join(sorted(f for f in os.listdir(OUT) if f.startswith("korea.osrm"))))

def main():
    os.makedirs(OUT, exist_ok=True)
    if not ARGS.graph_only:
        write_osm(stage())
    if not ARGS.osm_only:
        graph()

if __name__ == "__main__":
    main()
