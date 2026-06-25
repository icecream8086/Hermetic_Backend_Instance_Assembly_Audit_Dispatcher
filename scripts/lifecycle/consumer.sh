#!/bin/sh
# Consumer — listens on localhost:9999, appends received data to /tmp/received.txt
# Shared resource: /tmp/received.txt (local filesystem, not shared across containers)
# For cross-container shared storage, mount an NFS/EmptyDir volume instead
# Usage: consumer.sh

RECV_FILE="${1:-/tmp/received.txt}"
COUNT=0

echo "[consumer] listening on :9999, output=${RECV_FILE}"

# Trap to print final count on exit
cleanup() {
  echo "[consumer] stopping, received ${COUNT} messages total"
  exit 0
}
trap cleanup INT TERM

while true; do
  if LINE=$(nc -l -p 9999 -w 1 2>/dev/null); then
    echo "${LINE}" >> "${RECV_FILE}"
    COUNT=$((COUNT + 1))
    echo "[consumer] msg #${COUNT}: $(echo "${LINE}" | head -c 60)"
  fi
done
