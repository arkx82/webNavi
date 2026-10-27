#!/bin/bash
# Builds the safety app (README.md) in a container and puts the APK where the emulators install it from.
# The signing key stays on the server: its hash is what the Kakao app registers.
set -e
cd "$(dirname "$0")"
KEYS=/mnt/data/webnavi/kakao-safety
docker build -q -f build.Dockerfile -t webnavi-kakao-build . >/dev/null
docker volume create webnavi_kakao_gradle >/dev/null
docker run --rm -v "$PWD:/src" -v "$KEYS:/src/signing" -v webnavi_kakao_gradle:/home/gradle/.gradle -w /src \
  webnavi-kakao-build gradle --no-daemon -q assembleRelease
cp app/build/outputs/apk/release/app-release.apk "$KEYS/kakaosafety.apk"
echo "APK → $KEYS/kakaosafety.apk"
