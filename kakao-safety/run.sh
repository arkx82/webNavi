#!/bin/bash
# 카카오 안전운전's emulators (README.md): SLOTS of them, booted one after another (a boot takes five or six cores for
# half a minute), each with the safety app on slot N; then watched, and an emulator or app that dies is brought back.
set -u
SLOTS=${SLOTS:-3}
NAV_HOST=${NAV_HOST:-nav}
NAV_PORT=${NAV_PORT:-8080}
APK=${APK:-/data/kakaosafety.apk}
PKG=kr.webnavi.kakaosafety
mkdir -p "$ANDROID_AVD_HOME"
log() { echo "$(date '+%F %T') $*"; }

[ -n "${KAKAO_TOKEN:-}" ] || { log "KAKAO_TOKEN 없음 — 앱이 서버에 말할 수 없음"; sleep infinity; }
[ -f "$APK" ] || { log "$APK 없음 — kakao-safety/build.sh 먼저"; sleep infinity; }

# The apps reach the nav server through the emulator's host (10.0.2.2): this container, forwarding to nav.
socat TCP-LISTEN:8099,fork,reuseaddr "TCP:${NAV_HOST}:${NAV_PORT}" &
adb start-server >/dev/null 2>&1

serial() { echo "emulator-$((5552 + 2 * $1))"; }

boot() {
  local n=$1 s; s=$(serial "$n")
  [ -d "$ANDROID_AVD_HOME/slot$n.avd" ] || echo no | avdmanager create avd -n "slot$n" -k "$SYSTEM_IMAGE" -d pixel_5 --force >/dev/null
  log "slot $n: booting $s"
  emulator -avd "slot$n" -port $((5552 + 2 * n)) -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
    -memory 2048 -cores 2 -no-snapshot -dns-server 1.1.1.1,8.8.8.8 >"/tmp/emu$n.log" 2>&1 &
  local t0; t0=$(date +%s)
  until [ "$(adb -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
    sleep 2
    if [ $(( $(date +%s) - t0 )) -gt 300 ]; then log "slot $n: did not boot"; return 1; fi
  done
  log "slot $n: booted in $(( $(date +%s) - t0 )) s"
}

start_app() {
  local n=$1 s; s=$(serial "$n")
  adb -s "$s" install -r -g "$APK" >/dev/null 2>&1 || { log "slot $n: install failed"; return 1; }
  adb -s "$s" shell appops set "$PKG" android:mock_location allow
  adb -s "$s" shell pm grant "$PKG" android.permission.ACCESS_BACKGROUND_LOCATION 2>/dev/null
  adb -s "$s" shell cmd location set-location-enabled true 2>/dev/null
  adb -s "$s" shell dumpsys deviceidle whitelist +"$PKG" >/dev/null 2>&1
  adb -s "$s" shell am start-foreground-service -n "$PKG/.SafetyService" \
    --es base http://10.0.2.2:8099 --ei slot "$n" --es token "$KAKAO_TOKEN" >/dev/null
  log "slot $n: app started"
}

up() { [ "$(adb -s "$(serial "$1")" get-state 2>/dev/null)" = device ]; }
app_up() { [ -n "$(adb -s "$(serial "$1")" shell pidof "$PKG" 2>/dev/null | tr -d '\r')" ]; }

for n in $(seq 1 "$SLOTS"); do boot "$n" && start_app "$n"; done

while true; do
  sleep 30
  for n in $(seq 1 "$SLOTS"); do
    if ! up "$n"; then
      log "slot $n: emulator gone — again"
      pkill -f -- "-avd slot$n " 2>/dev/null
      boot "$n" && start_app "$n"
    elif ! app_up "$n"; then
      log "slot $n: app gone — again"
      start_app "$n"
    fi
  done
done
