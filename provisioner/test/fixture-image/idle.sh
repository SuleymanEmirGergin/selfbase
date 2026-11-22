#!/usr/bin/env bash
# Fixture service: idles; on SIGTERM writes a marker into its volume, so a test can tell a clean stop from SIGKILL.
on_term() {
  for d in /data/storage /data; do
    if [ -d "$d" ]; then echo clean > "$d/stopped-cleanly"; break; fi
  done
  exit 0
}
trap on_term TERM
sleep infinity &
wait
