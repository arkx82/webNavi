#!/bin/sh
# The osrm service: the graph in shared memory, osrm-routed serving from it, and the live
# speeds the nav server writes (speeds.csv: from_node,to_node,km/h) folded in whenever the
# file changes — osrm-customize with the speed file, then osrm-datastore swaps the new
# data in under the running router, no restart. A graph rebuilt by build.py is taken up
# the same way. Needs a big enough /dev/shm (compose: shm_size).
set -u
DATA=/data
GRAPH=$DATA/korea.osrm
SPEEDS=$DATA/speeds.csv
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }

until [ -f "$GRAPH.mldgr" ]; do echo "serve: waiting for $GRAPH (tools/nodelink/build.py)"; sleep 30; done
osrm-datastore "$GRAPH" || exit 1
osrm-routed --shared-memory --algorithm mld --max-table-size 1000 &
ROUTED=$!
graph_seen=$(mtime "$GRAPH.mldgr")
speeds_seen=0
while kill -0 $ROUTED 2>/dev/null; do
  sleep 15
  s=$(mtime "$SPEEDS")
  g=$(mtime "$GRAPH.mldgr")
  if [ "$s" != "$speeds_seen" ] && [ "$s" != 0 ]; then
    echo "serve: speeds.csv changed, customizing"
    if osrm-customize --segment-speed-file "$SPEEDS" "$GRAPH" >/dev/null 2>&1 && osrm-datastore "$GRAPH" >/dev/null 2>&1; then
      echo "serve: live speeds in"
    else
      echo "serve: customize with speeds failed"
    fi
    speeds_seen=$s
    graph_seen=$(mtime "$GRAPH.mldgr")
  elif [ "$g" != "$graph_seen" ]; then
    echo "serve: graph rebuilt, reloading"
    sleep 5
    osrm-datastore "$GRAPH" >/dev/null 2>&1 && echo "serve: new graph in"
    graph_seen=$(mtime "$GRAPH.mldgr")
  fi
done
