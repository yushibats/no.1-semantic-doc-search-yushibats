#!/usr/bin/env python3
"""Reject tracked credentials, local artifacts, and handoff-only implementation notes."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SELF = PurePosixPath("scripts/audit_repository.py")
SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".sso", ".tfstate", ".zip"}
SENSITIVE_NAMES = {".env", "wallet.zip", "ip_list.txt"}
CONTENT_PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(rb"gh[pousr]_[A-Za-z0-9_]{20,}"),
    "AWS access key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "local user path": re.compile(rb"/(?:home|Users)/[^/\s]+/"),
}
HANDOFF_NOTE_PARTS = (
    b"reference" + "プロジェクト".encode(),
    b"pony" + b"tail:",
    "ユーザー要望により削除".encode(),
    "本番環境ではコメントアウト".encode(),
)


def tracked_files() -> list[PurePosixPath]:
    output = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"])
    return [PurePosixPath(value.decode()) for value in output.split(b"\0") if value]


def main() -> int:
    problems: list[str] = []
    for relative in tracked_files():
        if relative == SELF:
            continue
        name = relative.name.lower()
        suffix = relative.suffix.lower()
        if name in SENSITIVE_NAMES or suffix in SENSITIVE_SUFFIXES or ".tfstate" in name:
            problems.append(f"tracked sensitive/generated file: {relative}")
            continue
        path = ROOT / relative
        if not path.is_file():
            continue
        data = path.read_bytes()
        for label, pattern in CONTENT_PATTERNS.items():
            if pattern.search(data):
                problems.append(f"{label}: {relative}")
        for marker in HANDOFF_NOTE_PARTS:
            if marker in data:
                problems.append(f"development-history note: {relative}")

    if problems:
        print("Repository sharing audit failed:")
        for problem in sorted(set(problems)):
            print(f"- {problem}")
        return 1
    print("repository sharing audit: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
