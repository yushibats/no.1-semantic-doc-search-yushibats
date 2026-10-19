#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="${PROJECT_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
readonly BACKEND_PYTHON="${PROJECT_ROOT}/backend/.venv/bin/python"
readonly LOG_DIR="${LOG_DIR:-${PROJECT_ROOT}/logs}"

if [[ ! -x "${BACKEND_PYTHON}" ]]; then
  echo "バックエンドのPython環境が見つかりません: ${BACKEND_PYTHON}" >&2
  exit 1
fi

# .envはシェルスクリプトではないためsourceしない。python-dotenvで解析した
# NUL区切りのKEY=VALUEをexportし、空白やシェル記号を含む値も安全に扱う。
while IFS= read -r -d '' assignment; do
  export "${assignment}"
done < <(
  "${BACKEND_PYTHON}" - "${PROJECT_ROOT}/.env" <<'PY'
import re
import sys
from pathlib import Path

from dotenv import dotenv_values

env_path = Path(sys.argv[1])
for key, value in dotenv_values(env_path).items():
    if value is None or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        continue
    sys.stdout.buffer.write(f"{key}={value}".encode() + b"\0")
PY
)

if [[ -z "${TNS_ADMIN:-}" && -n "${ORACLE_CLIENT_LIB_DIR:-}" ]]; then
  export TNS_ADMIN="${ORACLE_CLIENT_LIB_DIR}/network/admin"
fi
if [[ -n "${ORACLE_CLIENT_LIB_DIR:-}" ]]; then
  export LD_LIBRARY_PATH="${ORACLE_CLIENT_LIB_DIR}:${LD_LIBRARY_PATH:-}"
fi

readonly API_HOST_VALUE="${API_HOST:-0.0.0.0}"
readonly API_PORT_VALUE="${API_PORT:-8081}"
mkdir -p "${LOG_DIR}"

echo "セマンティック文書検索バックエンドサービスを起動中..."
(
  cd "${PROJECT_ROOT}/backend"
  nohup .venv/bin/python -m uvicorn app.main:app \
    --host "${API_HOST_VALUE}" --port "${API_PORT_VALUE}" \
    > "${LOG_DIR}/app-backend.log" 2>&1 &
)

echo "セマンティック文書検索フロントエンドサービスを起動中..."
(
  cd "${PROJECT_ROOT}/frontend"
  nohup npm run preview -- --host 0.0.0.0 --port 5175 \
    > "${LOG_DIR}/app-frontend.log" 2>&1 &
)

echo "セマンティック文書検索サービスの起動を開始しました。"
