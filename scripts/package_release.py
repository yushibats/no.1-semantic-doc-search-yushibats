#!/usr/bin/env python3
"""Build source and OCI stack archives from one clean, committed revision."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

STACK_PREFIX = "terraform/stack/"


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args])


def repository_from_origin(root: Path) -> str:
    """Return owner/name for a GitHub origin without embedding one account in the tool."""
    try:
        origin = subprocess.check_output(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except subprocess.CalledProcessError as error:
        raise ValueError("Specify --repository OWNER/REPOSITORY or configure a GitHub origin") from error
    match = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?",
        origin,
    )
    if not match:
        raise ValueError("Git origin is not a supported GitHub URL; specify --repository OWNER/REPOSITORY")
    return match.group(1)


def validate_path(name: str) -> None:
    path = PurePosixPath(name)
    forbidden_dirs = {".git", ".oci", ".terraform", ".venv", "node_modules", "storage",
                      "uploads", "backups", "backup", "test-results", "playwright-report"}
    if path.is_absolute() or ".." in path.parts or forbidden_dirs.intersection(path.parts):
        raise ValueError(f"Non-distributable path: {name}")
    if ((path.name.startswith(".env") and path.name != ".env.example")
            or path.suffix.lower() in {".pem", ".key", ".p12", ".sso", ".zip", ".log", ".bak", ".backup"}
            or ".tfstate" in path.name or ".before-" in path.name
            or path.name.endswith((".tfvars", ".tfvars.json"))):
        raise ValueError(f"Configuration, credential, or generated file: {name}")


def write_zip(path: Path, files: dict[str, tuple[bytes, int]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (content, mode) in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)


def package(root: Path, output: Path, ref: str, repository: str | None = None) -> dict:
    repository = repository or repository_from_origin(root)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must be owner/name, without credentials or a URL")
    if git(root, "status", "--porcelain", "--untracked-files=normal").strip():
        raise ValueError("Commit source changes before packaging; the working tree must be clean")
    revision = git(root, "rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Expected a full Git commit SHA")
    source: dict[str, tuple[bytes, int]] = {}
    with tarfile.open(fileobj=io.BytesIO(git(root, "archive", "--format=tar", revision))) as archive:
        for entry in archive:
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError(f"Only regular files are distributable: {entry.name}")
            validate_path(entry.name)
            content = archive.extractfile(entry).read()
            if re.search(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{40}", content):
                raise ValueError(f"Private key material detected: {entry.name}")
            source[entry.name] = (content, entry.mode)
    required = {"init_script.sh", "backend/uv.lock", "frontend/package-lock.json",
                STACK_PREFIX + "variables.tf", STACK_PREFIX + "cloud_init/bootstrap.template.yaml"}
    if not required.issubset(source):
        raise ValueError(f"Missing release inputs: {sorted(required - source.keys())}")
    manifest = {"repository": repository, "commit": revision,
                "source_url": f"https://github.com/{repository}/tree/{revision}",
                "files": {name: hashlib.sha256(data).hexdigest() for name, (data, _) in sorted(source.items())}}
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    source["RELEASE.json"] = (manifest_bytes, 0o644)
    stack = {name[len(STACK_PREFIX):]: entry for name, entry in source.items() if name.startswith(STACK_PREFIX)}
    stack["RELEASE.json"] = (manifest_bytes, 0o644)
    stack["release.auto.tfvars.json"] = ((json.dumps({
        "source_repository_url": f"https://github.com/{repository}.git",
        "source_revision": revision,
    }, indent=2) + "\n").encode(), 0o644)
    output.mkdir(parents=True, exist_ok=True)
    paths = [output / "semantic-doc-search-source.zip", output / "semantic-doc-search-stack.zip"]
    for path, files in zip(paths, [source, stack]):
        write_zip(path, files)
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in paths))
    return {"commit": revision, "repository": repository, "artifacts": [str(p) for p in paths]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--repository", help="GitHub owner/repository; defaults to the origin remote")
    parser.add_argument("--output", type=Path, default=Path("dist"))
    args = parser.parse_args()
    try:
        print(json.dumps(package(Path(__file__).resolve().parents[1], args.output, args.ref, args.repository), indent=2))
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release packaging failed: {error}\n")
