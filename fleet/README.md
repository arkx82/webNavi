# 차량 속도로 터널 보정 (Tesla)

터널에서 GPS가 끊기면 화면의 차는 마지막 속도로 밀려 가다가, 나올 때 크게 튄다(안에서 막히면 수백 m).
차가 직접 보내는 **속도·오도미터**를 받으면 터널 안에서도 실제로 간 만큼만 움직인다
(`web/src/car-track.ts` → `tracker.ts`). 차 화면이 열려 있을 때만 받고, 닫히면 1분 뒤 끊는다.

받는 길은 두 가지이고, `/admin` → **차량 (Tesla)** 에서 고른다.

| | Owner 스트리밍 | Fleet Telemetry |
|---|---|---|
| 공식 여부 | 비공식 (TeslaMate가 쓰는 방식) | 공식 |
| 준비 | Tesla 로그인만 | 앱 등록, 키 페어링, 포트 포워딩, 인증서 |
| 주기 | 약 0.5–1초 | 값이 바뀔 때, 최소 1초 |
| 비용 | 없음 | 신호 15만 개당 $1, 계정마다 매달 $10 할인 (주행 1시간 ≈ 1만 신호) |

## Owner 스트리밍

1. `/admin` → 차량 → **Owner 스트리밍** → **Tesla 로그인 열기**.
2. Tesla 계정으로 로그인하면 `https://auth.tesla.com/void/callback?code=…` 에서 "Page Not Found"가 뜬다.
   그 **주소 전체**를 복사해 붙여 넣고 **완료**. (토큰 앱에서 받은 refresh token을 붙여 넣어도 된다.)
3. 차 목록이 뜨면, 차마다 볼 사용자를 고른다 (기본: 모든 사용자).

## Fleet Telemetry

차가 우리 서버로 직접 접속한다(mTLS). TLS가 `fleet-telemetry` 컨테이너에서 끝나야 하므로
**Cloudflare Tunnel이 아니라 따로 연 포트**로 받는다.

1. **앱 등록** (developer.tesla.com): Allowed Origin `https://<도메인>`,
   Redirect URI `https://<도메인>/admin/car/tesla/callback`, 스코프 Vehicle Information · Vehicle Location.
   공개키는 서버가 `/.well-known/appspecific/com.tesla.3p.public-key.pem` 에서 내보낸다
   (`CONFIG_DIR/tesla/fleet-key.pem`, 처음 한 번 만들어짐 — 지우면 페어링부터 다시).
2. **텔레메트리 주소**: 예) `telemetry.<도메인>` A 레코드 → 집 공인 IP, Cloudflare는 **DNS only(회색 구름)**.
   공유기에서 TCP `8443` → 이 서버 `8443` 포워딩 (`TELEMETRY_PORT` 로 바꿀 수 있음).
3. **인증서**: Cloudflare DNS 편집 토큰(`/root/.cf.ini`, `dns_cloudflare_api_token = …`, 0600)으로 발급 (포트 80 불필요).
   ```bash
   docker run --rm -v /mnt/data/webnavi/letsencrypt:/etc/letsencrypt -v /root/.cf.ini:/cf.ini:ro \
     certbot/dns-cloudflare certonly --non-interactive --agree-tos --register-unsafely-without-email \
     --dns-cloudflare --dns-cloudflare-credentials /cf.ini --key-type rsa -d telemetry.<도메인>
   sh fleet/install-cert.sh telemetry.<도메인>   # tls.crt · tls.key(uid 65532) · ca.pem 배치, 검증
   docker compose --profile fleet up -d
   ```
   `ca.pem` 은 차가 믿을 체인(중간 인증서 + 교차 서명된 Root YR + ISRG Root X1). 갱신(90일)은 같은 이미지로
   `renew` 후 `install-cert.sh` — 스크립트가 컨테이너도 재시작한다.
4. `/admin` → 차량 → **Fleet Telemetry**: Client ID · Secret · `telemetry.<도메인>:8443` 저장 후
   ① 파트너 등록 → ② Tesla 로그인 → ③ 폰에서 `https://tesla.com/_ak/<도메인>` 열어 차에 키 추가 →
   ④ 텔레메트리 설정 보내기 → **상태 확인**에서 `synced`, `key_paired` 가 true인지 본다.
   설정은 1년 뒤 만료되므로 그 전에 ④를 다시 누른다.

받는 항목은 `server/src/car/fleet.ts` 의 `TELEMETRY_FIELDS`
(속도·오도미터·기어 1초, 위치·방위 5초 — 위치는 기록용).

## 확인

차 화면 진단 로그에 남는다.
- `차량 스트리밍: streaming` — 받는 중
- `차량 첫 샘플: … 오도미터 1.6 m 단위` — 오도미터가 10 m보다 촘촘하면 거리를 오도미터로, 아니면 속도로 잰다
- `추측 항법 끝 42초 · 차량 속도 · GPS와 +6 m · 차 자체 위치와 GPS 15 m` — 터널을 나올 때의 오차.
  마지막 값은 차가 스스로 추정한 위치가 터널 안에서도 맞는지 보려는 기록이다.

책상에서는 모의 주행 → **터널 정체** (60초 터널, 안에서 멈췄다 기어감).
