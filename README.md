# tesla-nav

> 계획서 대비 진행 상황: [docs/STATUS.md](docs/STATUS.md)

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
cp .env.example .env        # DOMAIN 만 필수. 키는 /admin 에서 넣는 게 기본
npm install
npm run dev                 # web :5173 (→ /api 프록시), server :8080
npm run build && npm start  # 빌드 결과를 server가 :8080 에서 함께 서빙
npm test                    # server + web 단위 테스트 (19개)
DASHSCOPE_API_KEY=… npx tsx server/src/prerender.ts   # 고정 멘트 ~90개 미리 렌더링
docker compose up -d --build   # NUC: nav + caddy. DOMAIN 이 .env 에 있어야 인증서를 받는다
```

`server/data/` 에 data.go.kr 표준데이터 CSV를 넣으면 시작 시 색인된다
([server/data/README.md](server/data/README.md)).

## 설정 페이지 `/admin`

키를 파일에 쓰지 않고 브라우저에서 넣는다. 첫 방문에 비밀번호를 정하고(8자
이상), 그 뒤로는 그 비밀번호로 들어간다. 필드마다 "저장됨 …1234" 식으로 마지막
네 자만 보이고, 키 자체는 다시 나오지 않는다. **저장하면 재시작 없이 바로
적용**된다(제공자가 호출 때마다 읽음). 버튼 둘: **연결 확인**은 서비스마다 실제
호출을 한 번씩 해서 ok/오류를 표로 보여 주고, **고정 멘트 렌더링**은 경고 문장
~90개를 미리 만든다.

저장 방식 (`server/src/settings.ts`):
- `CONFIG_DIR/master.key` — 첫 실행 때 만든 32바이트 난수, 0600.
- `CONFIG_DIR/settings.enc` — 키·목소리·비밀번호 해시를 JSON으로 묶어
  AES-256-GCM 으로 암호화(iv·tag·본문 base64), 0600.
- 비밀번호는 scrypt 해시, 세션은 master.key 로 HMAC 서명한 쿠키(30일, HttpOnly,
  https 뒤에서는 Secure), 틀린 시도 5번이면 그 주소는 1분 잠김, 변경 요청은
  `X-Requested-With` 헤더가 있어야 받는다.
- 약속의 범위: 백업이나 볼륨 복사본이 새어도 `master.key` 없이는 읽을 수 없다.
  서버의 root 는 둘 다 가지므로 그 위는 막지 않는다.
- 환경변수(`.env`)는 페이지에서 비워 둔 필드의 대체값. 페이지에서 `-` 를 넣으면
  저장값이 지워지고 환경변수로 돌아간다.

도커에서는 `nav_config` 볼륨이 `/config`, `nav_tts` 가 `/tts` 라 이미지를 다시
빌드해도 남는다.

## NUC 에 올리기

```bash
git clone … tesla-nav && cd tesla-nav
cp .env.example .env            # DOMAIN=nav.example.com 만 채운다
mkdir -p server/data            # 표준데이터 CSV를 여기에
docker compose up -d --build    # 이미지 328 MB, 첫 빌드 수 분
open https://nav.example.com/admin   # 비밀번호 정하고 키 입력, 연결 확인
```

- 도메인의 A 레코드가 집 공인 IP 를 가리키고 80/443 이 NUC 로 포워딩돼 있어야
  Caddy 가 인증서를 받는다. 포트를 못 여는 회선이면 Caddy 대신 Cloudflare Tunnel
  을 `nav:8080` 앞에 두면 된다(HTTPS 는 터널이 끝낸다).
- 차에서는 `https://nav.example.com` 을 브라우저 즐겨찾기로. `/admin` 은 같은 주소
  뒤에 있으니 비밀번호가 곧 방어선이다 — 짧게 짓지 말 것.
- 확인된 것(2026-09-29): 이미지 빌드, 컨테이너에서 웹·`/admin`·`/api/*` 응답,
  재시작 뒤 볼륨의 설정 유지. Caddy 는 실제 도메인이 있어야 해서 아직 안 띄워 봤다.

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

## 화면

왼쪽 열 하나가 세 화면을 번갈아 쓴다. 한국 내비·구글 내비의 공통 구조를 따랐다.

1. **검색** — 속도·시각, "어디로 갈까요?", 최근 목적지(브라우저에 6개).
2. **경로 미리보기** — 목적지 이름/주소, 제공자별 경로 **카드**(소요 시간 크게, 도착
   시각, 거리, "가장 빠름"/"최단 거리" 태그, 혼잡도 비율 막대). 지도에는 모든 경로가
   보이고 고른 것만 색, 나머지는 회색. 카드를 탭하면 바뀌고 **안내 시작**으로 출발.
3. **안내 중** — 파란 배너에 회전 화살표(3사 코드와 OSRM 문자열을 하나의 화살표
   표로, `maneuver.ts`)·남은 거리·도로명, 그 아래 "다음 … 후 …" 한 줄(800 m 안일 때),
   도착 시각과 남은 시간·거리, **경로**(주행 중에도 카드를 다시 불러 갈아탐; 닫으면
   그대로 계속)·**종료**. 지도를 끌면 왼쪽 아래 ⌖ 버튼이 나와 다시 따라간다.

음악은 오른쪽 아래 미니바(아래 "음악"). `?demo` 는 3번 화면으로, `?demo&screen=preview`
는 2번 화면으로 바로 연다.

## 음성 파이프라인

말할 문장은 클라이언트가 만들고(`phraseFor`, `"${rung}미터 앞 ${guide.text}"`), 서버는
문장 → WAV 캐시일 뿐이다. 고정 멘트는 `prerender.ts` 로 미리 만들고, 제공자가 보내는
회전 안내 문구는 첫 주행에서 한 번 렌더링되면 그 뒤로는 공짜다. 브라우저 오디오는
탭이 있어야 시작되므로 페이지의 첫 터치가 `AudioContext` 를 깨운다. **테슬라에서
순정 오디오 재생 중 이 페이지 소리가 나는지**는 진단 → 소리 테스트로 실차 확인.

## 음악

차 안의 순정 오디오(스포티파이 앱 등)는 브라우저가 건드릴 수 없으므로, 음성이
음악을 줄이려면 **음악도 이 페이지에서** 나와야 한다. 네 서비스를 놓고 확인한 것:

| 서비스 | 되나 | 이유 |
|---|---|---|
| **Spotify** | 만듦, 실차 미확인 | Web Playback SDK 로 페이지가 Connect 기기가 됨. Premium 필요, Widevine 필요 — 테슬라 브라우저에 Widevine 이 있는지가 관건 |
| **TIDAL** | 만듦, 계정으로 미확인 | 공식 Player SDK(`@tidal-music/player`)가 제3자에게 허용된 유일한 재생 경로. 구독 필요, Widevine 동일 |
| **유튜브 뮤직** | 안 함 | 재생 API 가 없고 유일한 경로가 영상 iframe 인데, **테슬라는 주행 중 브라우저 영상 재생을 막는다**. 정차 중에만 되는 음악은 내비에 의미가 없다. 브랜드 계정 여부와 무관 |
| **멜론** | 안 함 | 제3자 재생 API 자체가 없음 (검색·차트 메타데이터만). 스크래핑은 약관 위반 |
| 스트림 URL | 화면에서 뺌 | 인터넷 라디오는 되지만 볼품이 없어 페이지에서 내렸다. 서버의 `/api/stream` CORS 중계는 남아 있다 |

구조 (`web/src/music/`): `MusicSource` 하나의 얼굴(연결·목록·재생·⏮⏯⏭·`setVolume`).
Spotify/TIDAL 은 DRM 이라 Web Audio 그래프 밖이므로 SDK 의 볼륨으로 덕킹한다
(`Voice.duckers`). 화면은 음악 앱들처럼 **아래 미니바**(아트·곡명·⏯⏭)와, 탭하면
왼쪽 열 전체를 덮는 **풀 플레이어**(서비스 탭, 큰 아트, 진행 바, ⏮⏯⏭, 재생목록).
목록에서 고르면 도로 미니바로 접힌다. 계정 연결은 `/admin` 에서 한 번:

1. developer.spotify.com / developer.tidal.com 에서 앱을 만든다. Redirect URI 는
   `https://<도메인>/api/music/spotify/callback` (TIDAL 도 같은 꼴). Spotify 는
   2025-11 부터 http 리다이렉트를 받지 않는다(루프백 `127.0.0.1` 만 예외).
2. `/admin` 에 Client ID/Secret 저장 → **연결** → 그 서비스에 로그인.
3. 서버가 refresh token 을 `settings.enc` 에 넣고, 차의 페이지는
   `/api/music/<서비스>/token` 으로 짧은 access token 만 받는다.

**열린 문제 — 차 페이지의 인증.** `/api/music/*/token` 은 차 브라우저가
로그인 없이 부르므로, 도메인을 아는 누구나 소유자의 Spotify 를 조종할 수 있다
(경로·TTS 호출도 마찬가지로 소유자 비용). 다음 단계: `/admin` 에서 만든 긴 키를
차 브라우저에 한 번 넣게 하고(`?key=` → localStorage → 헤더) 모든 `/api/*` 가
그것을 요구하게 한다.

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
- [x] BYOK → `/admin` 설정 페이지로 대신함 (키는 서버에 암호화 저장)
- [ ] 차 페이지 접근 키 (위 "열린 문제")
- [ ] Spotify / TIDAL 을 실제 계정으로, 그리고 차에서 (Widevine)
- [x] CSV 로그 재생 모드(진단 → 재생, `?speedup=4`)
- [x] 모의 주행(진단 → 모의 주행): 경로를 따라 1 Hz 가짜 GPS, 속도 슬라이더, 터널 10초
      (추측 항법 확인), 이탈(60 m 옆 → 재탐색 확인). `?demo` 는 가짜 경로로 자동 시작
