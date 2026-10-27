# 카카오 안전운전 (kakao-safety/README.md): Android emulators on KVM, each running the safety app for one car.
FROM ubuntu:24.04
ARG CMDLINE_TOOLS=commandlinetools-linux-11076708_latest.zip
ARG SYSTEM_IMAGE="system-images;android-34;google_apis;x86_64"
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/opt/android \
    ANDROID_HOME=/opt/android \
    ANDROID_AVD_HOME=/data/avd \
    PATH=/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:/opt/android/emulator:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless curl unzip socat ca-certificates libpulse0 libgl1 libnss3 libxcomposite1 libxcursor1 \
      libxdamage1 libxi6 libxtst6 libasound2t64 libxkbfile1 libxkbcommon0 libdbus-1-3 jq procps \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/android/cmdline-tools && cd /opt/android/cmdline-tools \
    && curl -fsSLo t.zip https://dl.google.com/android/repository/${CMDLINE_TOOLS} && unzip -q t.zip && rm t.zip \
    && mv cmdline-tools latest \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager --install "platform-tools" "emulator" "${SYSTEM_IMAGE}" >/dev/null
ENV SYSTEM_IMAGE=${SYSTEM_IMAGE}
COPY run.sh /run.sh
RUN chmod +x /run.sh
VOLUME /data
CMD ["/run.sh"]
