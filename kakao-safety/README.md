# 카카오 안전운전 보완

우리 단속 카메라 목록(경찰청 · 지자체 공공데이터)에 없는 카메라를 **카카오내비 SDK의 안전운전 모드**로 주행 중 실시간 보완한다.
카카오는 단속 카메라를 REST API로 주지 않고 안드로이드 · iOS SDK로만 주므로, 이 서버에서 안드로이드 에뮬레이터를 돌린다.

```
차 페이지 ──(1초마다 위치)──▶ nav /api/kakao/fix ──▶ KakaoHub (server/src/kakao/hub.ts) ── 슬롯 1~3
     ◀──(응답에 카카오 경고)──                        ▲   │ 긴 대기 GET /internal/kakao/slot/N
                                                      │   ▼
                                  POST …/event ── 에뮬레이터 N의 앱 (SafetyService.kt)
                                                  · 받은 위치를 기기 GPS(모의 위치)로 넣음
                                                  · KNSDK 목적지 없는 안내(startWithTrip(null))
                                                  · SDK가 말하려는 안전 안내 → 서버로
```

- **슬롯**: `KAKAO_SLOTS`(기본 3) = 동시에 보완받는 차 수. 처음 위치를 보낸 차가 빈 슬롯을 받고, 90초 위치가 없거나
  3분 서 있으면 놓는다. 슬롯이 다 차면 그 차는 우리 목록만으로 안내한다.
- **말하는 법**: 카카오가 말하려는 카메라가 우리 목록(경로 · 안전운전 감시)에 80 m 안에 있으면 말하지 않는다. 없으면
  우리 목소리로 가장 가까운 단계(1km · 600m · 300m)의 문장을 말하고, 제한 속도가 있으면 카메라 카드에 "· 카카오"로 보인다.
- **저장 안 함**: 카카오 SDK 데이터는 실시간 사용만 허용된다. 서버는 이벤트를 15초 들고 있다가 버리고, 어디에도 쓰지 않는다.
  지도 위에 카카오 카메라를 그리지 않는다(타사 지도 위 표시 금지).
- **자원**: 에뮬레이터 하나에 메모리 약 3.8 GB, 쉬는 동안 CPU 코어의 몇 %. 부팅(26~40초)만 무거워 하나씩 순서대로 켠다.

## 카카오 쪽 설정 (한 번)

1. 카카오 디벨로퍼스 → (REST 키와 같은) 앱 → 플랫폼 → **Android**: 패키지명 `kr.webnavi.kakaosafety`,
   키 해시 `v73ja+SqDWYBOJw8lVflkue/ZHU=` (서명 키 `/mnt/data/webnavi/kakao-safety/kakaosafety.keystore`의 해시).
2. 카카오내비(길찾기 SDK) 사용 설정 — 쿼터 표에 "안전운전 모드"가 보이면 된 것.
3. `/admin` → 설정 → **카카오 네이티브 앱 키**. 저장하면 앱들이 10초 안에 받아 초기화한다.
   `/admin` → 상태 → "카카오 안전운전"에 슬롯마다 대기 · 주행 중 · 오류가 보인다.

## 빌드 · 배포

- 호스트(LXC)에 `/dev/kvm`이 있어야 한다: Proxmox에서 `pct set <id> --dev0 /dev/kvm`.
- `kakao-safety/build.sh` — 컨테이너에서 APK를 빌드해 `/mnt/data/webnavi/kakao-safety/kakaosafety.apk`에 둔다.
  서명 키는 저장소에 없고 그 폴더에만 있다(잃으면 키 해시가 바뀌어 카카오에 다시 등록해야 함).
- `docker compose up -d --build kakao` — 에뮬레이터 컨테이너. `.env`의 `KAKAO_TOKEN`(앱 ↔ 서버 공유 비밀)과
  `KAKAO_SLOTS`를 nav와 같이 쓴다. 죽은 에뮬레이터 · 앱은 30초마다 확인해 다시 띄운다.
- 앱 로그: `docker exec webnavi-kakao-1 adb -s emulator-5554 logcat -s KakaoSafety` (슬롯 1=5554, 2=5556, 3=5558).
