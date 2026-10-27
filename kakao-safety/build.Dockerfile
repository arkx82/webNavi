# Builds the safety app's APK (kakao-safety/README.md): JDK, Gradle and the Android SDK, nothing installed on the host.
FROM gradle:8.10.2-jdk17
ENV ANDROID_SDK_ROOT=/opt/android ANDROID_HOME=/opt/android
RUN mkdir -p /opt/android/cmdline-tools && cd /opt/android/cmdline-tools \
    && curl -fsSLo t.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && unzip -q t.zip && rm t.zip \
    && mv cmdline-tools latest \
    && yes | /opt/android/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
    && /opt/android/cmdline-tools/latest/bin/sdkmanager --install "platforms;android-35" "build-tools;35.0.0" "platform-tools" >/dev/null
WORKDIR /src
