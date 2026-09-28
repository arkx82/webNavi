# Safety data

Drop the 공공데이터포털 standard-data CSVs here; every `*.csv` is loaded at
start and indexed in memory (Flatbush). Files are matched by name:

| File name contains | Read as |
|---|---|
| 방지턱 | speed bumps (`kind: bump`) |
| anything else | enforcement cameras (`단속구분` → speed / signal / speed-signal / section-start / section-end; `보호구역구분` → school) |

Sources (data.go.kr):

- 전국무인교통단속카메라표준데이터 — 경찰청
- 전국과속방지턱표준데이터 — 행정안전부

Both come as UTF-8 with BOM or EUC-KR; both are handled. Columns are read by
their Korean header names (위도, 경도, 단속구분, 제한속도, 도로노선방향, …).

Note: neither file gives a camera *bearing*, only a text like 상행/하행.
Direction filtering is done on the client against the route polyline.
