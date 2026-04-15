#!/usr/bin/env bash
# Semantic Doc Search Backend dev server launcher
# Usage:
#   BACKEND_PORT=8081 ./scripts/start-backend.sh
# Notes:
#   - Requires: uv (https://astral.sh)
#   - This will run `uv sync` for backend/ and then start uvicorn with --reload.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../" && pwd)"
cd "$ROOT_DIR"

export PATH="/root/.local/bin:${PATH}"

# .envファイルから環境変数を安全に読み込み
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT_DIR/.env"
  set +a
fi

# backend/.env が存在する場合はルート .env より優先して上書き
if [ -f "$ROOT_DIR/backend/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/backend/.env"
  set +a
fi

# Oracle Client環境変数を設定
# 優先順位: 環境変数 TNS_ADMIN > /u01/aipoc/props/wallet > ORACLE_CLIENT_LIB_DIR/network/admin
if [ -z "${TNS_ADMIN:-}" ]; then
  # TNS_ADMINが未設定の場合
  if [ -d "/u01/aipoc/props/wallet" ]; then
    export TNS_ADMIN="/u01/aipoc/props/wallet"
  elif [ -n "${ORACLE_CLIENT_LIB_DIR:-}" ]; then
    export TNS_ADMIN="${ORACLE_CLIENT_LIB_DIR}/network/admin"
  fi
fi

if [ -n "${ORACLE_CLIENT_LIB_DIR:-}" ]; then
  export LD_LIBRARY_PATH="${ORACLE_CLIENT_LIB_DIR}:${LD_LIBRARY_PATH:-}"
fi

if [ -n "${TNS_ADMIN:-}" ]; then
  echo "[バックエンド] Oracle Client設定:"
  echo "  ORACLE_CLIENT_LIB_DIR: ${ORACLE_CLIENT_LIB_DIR:-未設定}"
  echo "  TNS_ADMIN: ${TNS_ADMIN}"
fi

PORT="${BACKEND_PORT:-${API_PORT:-8081}}"

echo "[バックエンド] FastAPI dev serverをポート ${PORT} で起動中..."

UV_BIN="$(command -v uv || true)"
if [ -z "$UV_BIN" ] && [ -x "/root/.local/bin/uv" ]; then
  UV_BIN="/root/.local/bin/uv"
fi

if [ -z "$UV_BIN" ]; then
  echo "[バックエンド] ERROR: 'uv' が見つかりません。" 1>&2
  echo "         uvをインストール:  curl -LsSf https://astral.sh/uv/install.sh | sh" 1>&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -PiTCP:"$PORT" -sTCP:LISTEN -t || true)"
  if [ -n "$PIDS" ]; then
    if [ "${BACKEND_KILL_EXISTING:-}" = "1" ] || [ "${BACKEND_KILL_EXISTING:-}" = "true" ]; then
      echo "[バックエンド] ポート ${PORT} が使用中です。停止中: ${PIDS}"
      kill $PIDS || true
      sleep 1
    else
      echo "[バックエンド] ERROR: ポート ${PORT} が既に使用中です (pids: ${PIDS})" 1>&2
      echo "         BACKEND_PORTを変更するか、BACKEND_KILL_EXISTING=1 で停止してください。" 1>&2
      exit 1
    fi
  fi
fi

echo "[バックエンド] Python依存関係をuvで同期中 (backend/)"
"$UV_BIN" sync --directory backend

echo "[バックエンド] uvicorn app.main:app を自動リロードで起動 (0.0.0.0:${PORT})"
exec "$UV_BIN" run --directory backend uvicorn app.main:app --reload --host 0.0.0.0 --port "$PORT"
