#!/bin/sh
# Puts the Let's Encrypt certificate for the Fleet Telemetry server where its container reads it, and the chain the
# car is told to trust (ca.pem: the intermediate and the root it chains to). Run after issuing and after each renewal:
#   docker run --rm -v /mnt/data/webnavi/letsencrypt:/etc/letsencrypt -v /root/.cf.ini:/cf.ini:ro \
#     certbot/dns-cloudflare renew --dns-cloudflare --dns-cloudflare-credentials /cf.ini && sh fleet/install-cert.sh telemetry.<domain>
set -eu
NAME=${1:?usage: install-cert.sh telemetry.<domain>}
LE=/mnt/data/webnavi/letsencrypt/live/$NAME
OUT=/mnt/data/webnavi/telemetry
mkdir -p "$OUT"
install -m 644 "$LE/fullchain.pem" "$OUT/tls.crt"
# The container runs as uid/gid 65532 (distroless nonroot).
install -m 640 -g 65532 "$LE/privkey.pem" "$OUT/tls.key"
# The root the chain ends at: the issuer of its last certificate (since 2026 a cross-signed "Root YR", issued by
# ISRG Root X1), fetched from Let's Encrypt itself.
ISSUER=$(awk '/BEGIN CERT/{c=""} {c=c $0 "\n"} END{printf "%s", c}' "$LE/chain.pem" | openssl x509 -noout -issuer)
case "$ISSUER" in
  *"ISRG Root X1"*) ROOT=https://letsencrypt.org/certs/isrgrootx1.pem ;;
  *"ISRG Root X2"*) ROOT=https://letsencrypt.org/certs/isrg-root-x2.pem ;;
  *) echo "unknown issuer: $ISSUER" >&2; exit 1 ;;
esac
curl -fsS "$ROOT" -o "$OUT/root.pem"
cat "$LE/chain.pem" "$OUT/root.pem" > "$OUT/ca.pem"
# The leaf must verify against exactly what the car will be given.
openssl verify -CAfile "$OUT/root.pem" -untrusted "$LE/chain.pem" "$LE/cert.pem"
docker restart webnavi-fleet-telemetry-1 >/dev/null 2>&1 || true
