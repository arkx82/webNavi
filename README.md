# tesla-nav

테슬라 순정 브라우저에서 여는 국내용 웹 내비게이션. 경로는 TMAP / 카카오 /
네이버 중 골라 받고, 단속 카메라·방지턱은 공공데이터로, 음성은 Qwen-TTS로.
서버는 집의 NUC(도커)에서 돌고, 차는 HTTPS로 그 서버에 접속한다.

```
web/     Vite + TypeScript + MapLibre GL — 차에서 여는 화면 (빌드 결과를 서버가 정적 서빙)
server/  Fastify + TypeScript — API 키 은닉 프록시, Flatbush 공간 색인, TTS 파일 서빙
caddy/   TLS 종단 (Let's Encrypt)
```

## 실행

```bash
cp .env.example .env        # 키를 채운다. 비워 둔 제공자는 화면에서 숨겨진다
npm install
npm run dev                 # web :5173 (→ /api 프록시), server :8080
npm run build && npm start  # 빌드 결과를 server가 :8080 에서 함께 서빙
npm test                    # server + web 단위 테스트
DASHSCOPE_API_KEY=… npx tsx server/src/prerender.ts   # 고정 멘트 ~90개 미리 렌더링
docker compose up -d --build   # NUC: nav + caddy. DOMAIN 이 .env 에 있어야 인증서를 받는다
```

`server/data/` 에 data.go.kr 표준데이터 CSV를 넣으면 시작 시 색인된다
([server/data/README.md](server/data/README.md)).

## API

| 호출 | 답 |
|---|---|
| `GET /api/health` | 제공자별 키 유무, 색인된 시설물 수 |
| `GET /api/route?provider=tmap\|kakao\|naver&start=lon,lat&goal=lon,lat` | 세 제공자를 한 모양으로: `path`, `guides`, `segments{congestion 0..3}` |
| `GET /api/route?provider=all&…` | 키 있는 제공자 전부 동시에: `{routes, errors}` |
| `GET /api/search?q=&near=lon,lat` | 카카오 로컬 키워드 검색, 가까운 순 |
| `GET /api/safety/near?lon&lat&r=1500` | 반경 안 시설물, 가까운 순 |
| `GET /api/tts?text=` | 그 문장의 WAV. 디스크 캐시(`server/tts/`, 음성+문장 해시) 우선, 없으면 Qwen3-TTS(DashScope) 호출 후 저장 |
| `GET /api/stream?url=` | 음악 스트림을 CORS 헤더 붙여 중계 (Web Audio 그래프에 넣으려면 필요) |

## 계획서를 읽고 바꾼 것

계획서(v1.1)의 골격은 그대로 두고, 확인해 보니 다른 것들만 고쳤다.

1. **지도 라이브러리: Mapbox GL JS → MapLibre GL JS.** API가 같아서 코드는
   똑같고, 토큰과 월 사용량 걱정이 없다. 스타일 URL만 `VITE_MAP_STYLE` 로 바꾸면
   Mapbox 타일도 그대로 쓸 수 있다. 기본은 키 없는 OpenFreeMap(OSM). **한국
   도로망은 OSM 품질을 차에서 직접 봐야 한다** — 부족하면 VWorld(국토지리정보원)
   타일이 대안이고, 카카오/네이버 지도 SDK는 회전(heading-up)이 안 돼 제외.
2. **카메라 방향각 필터(45°)는 그대로 못 쓴다.** 경찰청 표준데이터에는 카메라
   bearing이 없고 `도로노선방향`("상행"/"하행") 텍스트뿐이다. 대신 클라이언트가
   **안내 경로 폴리라인에 카메라를 투영해서 경로 위·진행 방향 앞**인 것만 경고한다
   (반대 차선·직교 도로는 자연히 걸러진다). 서버는 반경 검색만 답한다.
3. **HTTPS가 필수다.** Geolocation, Wake Lock, AudioContext 자동 재생 모두 secure
   context에서만 된다. 차가 NUC에 닿으려면 공인 도메인 + 인증서(Caddy)이거나
   Cloudflare Tunnel이다. `localhost` 는 예외라 개발은 http로 된다.
4. **테슬라 브라우저가 `coords.heading`/`speed`를 주는지는 실차에서만 안다.**
   teslanav.com 도 heading을 믿지 않고 연속 좌표로 계산한다 → `gps.ts` 가 둘 다
   기록하고(`heading`, `course`), 지도는 `course` 를 따른다. 1주차 실차 검증은
   이 화면의 **로그 저장** 버튼으로 CSV를 뽑는 것.
5. **주기적 재탐색은 서버가 아니라 클라이언트 타이머**로 둔다. 서버는 상태가
   없어야 도커에서 그냥 재시작할 수 있다.
6. **3사는 섞지 않고 견준다.** 경로 조각을 이어 붙이면 안내 문구·혼잡 구간·ETA가
   서로 안 맞고 접합부의 주행 가능 여부를 검증할 수 없다. 대신
   `provider=all` 로 세 곳에 동시에 묻고 **ETA가 가장 짧은 것을 몬다**; 버튼에 각
   사의 시간이 같이 보이고 탭하면 갈아탄다. 6분마다 다시 물어 3분 이상 빠른 길이
   나오면 바꾼다. 이탈(35 m·3 s)은 즉시 재탐색.

## 참고: teslanav.com (R44VC0RP)

Next.js + Mapbox + Waze 알림. 가져온 것: heading 계산·스무딩(위 4), 사용자
에이전트에 `tesla` 또는 `qtcarbrowser` 가 들어가면 차, GPX 녹화·재생으로 차
없이 개발(다음 단계에서 CSV 재생으로 같은 걸 한다), 서비스 워커 타일 캐시.
안 가져온 것: Waze(국내 데이터 없음), Redis/Vercel Blob(개인 NUC 한 대에 과함),
React(화면 하나에 프레임워크는 무거움).

## 음성 파이프라인

말할 문장은 클라이언트가 만들고(`phraseFor`, `"${rung}미터 앞 ${guide.text}"`), 서버는
문장 → WAV 캐시일 뿐이다. 고정 멘트는 `prerender.ts` 로 미리 만들고, 제공자가 보내는
회전 안내 문구는 첫 주행에서 한 번 렌더링되면 그 뒤로는 공짜다. 브라우저 오디오는
탭이 있어야 시작되므로 페이지의 첫 터치가 `AudioContext` 를 깨운다. **테슬라에서
순정 오디오 재생 중 이 페이지 소리가 나는지**는 진단 → 소리 테스트로 실차 확인.

## 남은 것 (계획서 2~6주차)

- [ ] 실차: GPS 필드(heading/speed/정확도/주기), Wake Lock, 소리 통과 여부 확인
- [x] 목적지 검색(카카오 로컬 API) 과 경로 요청·표시(혼잡도 색), 3사 비교
- [x] 맵매칭(`geo.ts` 자체 투영, 창 탐색), 60 fps 보간, 이탈 35 m·3 s 판정, 추측
      항법과 1.5 s 복귀 — `tracker.ts`, 단위 테스트 7개
- [x] 경로 위 카메라/방지턱/급커브 경고(`warnings.ts`: 경로에 투영, 25 m 이내·앞쪽만,
      단계별 1회 발화; 급커브는 40 m 안에 35° 이상 꺾이고 안내 지점이 아닌 곳) +
      고정 멘트 사전 렌더링(`prerender.ts`) + 동적 TTS(`/api/tts`, 캐시)
- [x] 회전 안내 음성(500 m·150 m), 도착·이탈·더 빠른 길 멘트
- [x] 웹 오디오 플레이어와 덕킹(`voice.ts` 그래프의 music GainNode를 말할 때 0.3으로;
      `player.ts` 는 `/api/stream` 을 통해 CORS 붙은 스트림만 그래프에 넣을 수 있음)
- [ ] BYOK: 설정 화면에서 키를 넣으면 요청 헤더로 실어 서버가 그 키로 대신 호출
- [x] CSV 로그 재생 모드(진단 → 재생, `?speedup=4`)
