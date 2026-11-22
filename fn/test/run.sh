#!/bin/sh
# Runs the fn tests in a pinned Deno container (Deno need not be installed). Usage: sh fn/test/run.sh
set -e
cd "$(dirname "$0")/.."
docker run --rm \
  -v "$(pwd -W 2>/dev/null || pwd):/app:ro" \
  -v "$(cd test/fixtures/client-stub && (pwd -W 2>/dev/null || pwd)):/client:ro" \
  -e FUNCTIONS_DIR=/app/test/fixtures/supabase/functions \
  -e JWT_SECRET=test-secret-test-secret-test-secret \
  -e FN_IMPORT_TIMEOUT_MS=500 \
  -w /app \
  denoland/deno:alpine-2.1.4 \
  deno test --no-lock --allow-net --allow-env --allow-read=/app,/client --import-map=/app/import_map.json test/main.test.ts
