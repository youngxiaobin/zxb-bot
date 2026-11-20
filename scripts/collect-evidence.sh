#!/usr/bin/env bash
# 在干净工作区上收集门禁全文。不使用管道，因此退出码就是命令本身的退出码。
set -u
cd "$(dirname "$0")/.."
OUT="${PA_ARTIFACT_DIR:-$PWD/artifacts}/evidence"
mkdir -p "$OUT"
SHA="$(git rev-parse HEAD)"
{
  echo "sha=$SHA"
  echo "status<<"
  git status --porcelain
  echo ">>"
  echo "node=$(node -v)"
  echo "pnpm=$(pnpm -v)"
} > "$OUT/context.txt"
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，拒绝采集" >&2
  exit 2
fi

run_gate() {
  local name="$1"
  shift
  printf '%q ' "$@" > "$OUT/$name.cmd"
  echo >> "$OUT/$name.cmd"
  set +e
  "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr"
  local rc=$?
  set -e
  echo "$rc" > "$OUT/$name.exit"
  echo "GATE $name exit=$rc"
}

set -e
run_gate pnpm-test pnpm test
run_gate typecheck pnpm typecheck
run_gate typecheck-mobile pnpm typecheck:mobile
run_gate lint pnpm lint
run_gate desktop-build pnpm --filter @pa/desktop build
pnpm --filter @pa/desktop exec vite preview --host 127.0.0.1 --port 47341 --strictPort >"$OUT/vite-preview.stdout" 2>"$OUT/vite-preview.stderr" &
echo $! > "$OUT/vite-preview.pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null "http://127.0.0.1:47341/"; then
    break
  fi
  sleep 0.4
done
run_gate desktop-final env PA_DESKTOP_URL=http://127.0.0.1:47341 PA_ARTIFACT_DIR="$OUT" node --import tsx scripts/desktop-final-states.mjs
ELECTRON="$(find node_modules/.pnpm -path '*/electron/dist/electron' -type f -print -quit)"
if [ -n "${DISPLAY:-}" ] && [ -n "$ELECTRON" ] && [ -x "$ELECTRON" ]; then
  run_gate electron-window env PA_DESKTOP_URL=http://127.0.0.1:47341 PA_ELECTRON_SHOT="$OUT/electron-window.png" "$ELECTRON" scripts/electron-window.cjs
else
  echo "not-run" > "$OUT/electron-window.exit"
  echo "DISPLAY=${DISPLAY:-unset} ELECTRON=${ELECTRON:-missing}" > "$OUT/electron-window.stdout"
  echo "native Electron window was not started" > "$OUT/electron-window.stderr"
fi
if [ -f "$OUT/vite-preview.pid" ]; then
  kill "$(cat "$OUT/vite-preview.pid")" 2>/dev/null || true
fi
run_gate expo-web-export pnpm --filter @pa/mobile exec expo export --platform web --output-dir /tmp/pa-expo-web
for name in desktop-approve-final.png desktop-reject-final.png desktop-wide-list.png desktop-wide-chat.png desktop-wide-settings.png desktop-wide-approval.png desktop-narrow-list.png desktop-narrow-chat.png desktop-narrow-settings.png desktop-narrow-approval.png desktop-final-states.json electron-window.png; do
  if [ -f "$OUT/$name" ]; then
    cp -f "$OUT/$name" "$(dirname "$OUT")/$name"
  fi
done
git archive --format=tar.gz --prefix=personal-agent/ -o "$OUT/personal-agent-source-$SHA.tgz" HEAD
echo "ARCHIVE $OUT/personal-agent-source-$SHA.tgz"
echo "DONE $SHA"
