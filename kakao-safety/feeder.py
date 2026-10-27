#!/usr/bin/env python3
"""
Each slot's car fixes into its emulator's own GPS (README.md). 카카오내비 SDK takes no location an app marks as mock
(KNGPSManager reads Location.isMock()), so the fixes go in where a phone's would: the emulator's GNSS, by `adb emu geo
fix`. One thread a slot, each long-asking nav for its car's next fix as the app does (feeder=1: the app's own asks are
what say it is up).
"""
import json, os, subprocess, sys, threading, time, urllib.request

NAV = f"http://{os.environ.get('NAV_HOST', 'nav')}:{os.environ.get('NAV_PORT', '8080')}"
TOKEN = os.environ.get("KAKAO_TOKEN", "")
SLOTS = int(os.environ.get("SLOTS", "3"))


def fix_args(fix: dict) -> list[str]:
    """`geo fix <lon> <lat> <alt> <satellites> <knots>`: the emulator takes $GPRMC/$GPGGA sentences and drops them
    (Android 14 image, 2026-10-27), and its fix carries no course — the SDK finds the way from the fixes in a row."""
    knots = max(0.0, float(fix.get("speed") or 0)) * 1.943844
    return ["geo", "fix", f"{fix['lon']:.6f}", f"{fix['lat']:.6f}", "30", "10", f"{knots:.1f}"]


def feed(n: int) -> None:
    serial = f"emulator-{5552 + 2 * n}"
    after = 0
    while True:
        try:
            req = urllib.request.Request(f"{NAV}/internal/kakao/slot/{n}?after={after}&wait=10&feeder=1", headers={"X-Kakao-Token": TOKEN})
            with urllib.request.urlopen(req, timeout=20) as r:
                a = json.load(r)
            fix = a.get("fix")
            if not fix:
                continue
            after = fix.get("seq", after)
            subprocess.run(["adb", "-s", serial, "emu", *fix_args(fix)], capture_output=True, timeout=5)
        except Exception as e:  # nav restarting, the emulator rebooting: again in a moment
            print(f"slot {n}: {e}", file=sys.stderr, flush=True)
            time.sleep(3)


if __name__ == "__main__":
    for n in range(1, SLOTS + 1):
        threading.Thread(target=feed, args=(n,), daemon=True).start()
    while True:
        time.sleep(3600)
