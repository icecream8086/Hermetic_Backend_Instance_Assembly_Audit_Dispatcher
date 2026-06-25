#!/bin/sh
# Producer — sends numbered JSON messages to Consumer via localhost:9999
# Shared resource: container group network namespace (localhost nat)
# Usage: producer.sh [interval_seconds]

INTERVAL="${1:-1}"
SEQ=0

echo "[producer] started, interval=${INTERVAL}s, target=localhost:9999"

while true; do
  SEQ=$((SEQ + 1))
  TS=$(date +%s)
  MSG="{\"seq\":${SEQ},\"ts\":${TS},\"payload\":\"data_${RANDOM}\"}"
  if echo "${MSG}" | nc -w 1 localhost 9999 2>/dev/null; then
    echo "[producer] seq=${SEQ} ts=${TS} ✓"
  else
    echo "[producer] seq=${SEQ} ts=${TS} ✗ consumer unreachable"
  fi
  sleep "${INTERVAL}"
done
