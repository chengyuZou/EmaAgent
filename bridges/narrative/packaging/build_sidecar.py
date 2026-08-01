# 在当前操作系统原生冻结 Narrative Bridge，并原子装配为 Tauri Sidecar。
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PROJECT_ROOT.parents[1]
TAURI_ROOT = WORKSPACE_ROOT / "apps" / "desktop" / "src-tauri"


def host_target() -> str:
    machine = platform.machine().lower()
    architecture = "aarch64" if machine in {"arm64", "aarch64"} else "x86_64"
    if sys.platform == "win32":
        return f"{architecture}-pc-windows-msvc"
    if sys.platform == "darwin":
        return f"{architecture}-apple-darwin"
    if sys.platform.startswith("linux"):
        return f"{architecture}-unknown-linux-gnu"
    raise RuntimeError(f"不支持的 Bridge 构建平台: {sys.platform}/{machine}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="构建 Ema Narrative Bridge Tauri Sidecar")
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError(
            f"Bridge 发布 Python 必须是 3.11，当前是 {platform.python_version()}"
        )
    actual_host = host_target()
    if args.target != actual_host:
        raise RuntimeError(
            f"Bridge 原生依赖必须在目标平台构建: target={args.target}, host={actual_host}"
        )

    staging_root = TAURI_ROOT / ".release-staging" / f"bridge-{os.getpid()}"
    dist_root = staging_root / "dist"
    work_root = staging_root / "work"
    shutil.rmtree(staging_root, ignore_errors=True)
    dist_root.mkdir(parents=True)

    environment = os.environ.copy()
    environment["TAURI_ENV_TARGET_TRIPLE"] = args.target
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--noconfirm",
            "--distpath",
            str(dist_root),
            "--workpath",
            str(work_root),
            str(PROJECT_ROOT / "packaging" / "narrativeBridge.spec"),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
    )

    suffix = ".exe" if sys.platform == "win32" else ""
    output_name = f"ema-narrative-bridge{suffix}"
    built_root = dist_root / "ema-narrative-bridge"
    built = built_root / output_name
    if not built.is_file() or built.stat().st_size == 0:
        raise RuntimeError(f"PyInstaller 未生成 Narrative Bridge Sidecar: {built}")
    subprocess.run([str(built), "--version"], check=True)

    destination_root = TAURI_ROOT / "resources" / "narrative-bridge-runtime"
    temporary_root = destination_root.with_name(
        f"{destination_root.name}.tmp-{os.getpid()}"
    )
    backup_root = destination_root.with_name(
        f"{destination_root.name}.previous-{os.getpid()}"
    )
    shutil.rmtree(temporary_root, ignore_errors=True)
    shutil.rmtree(backup_root, ignore_errors=True)
    shutil.copytree(built_root, temporary_root)
    destination = temporary_root / output_name
    if sys.platform != "win32":
        destination.chmod(
            destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        )

    manifest = {
        "schemaVersion": 1,
        "target": args.target,
        "pythonVersion": platform.python_version(),
        "fileName": output_name,
        "size": destination.stat().st_size,
        "sha256": sha256(destination),
    }
    manifest_path = temporary_root / "release-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if destination_root.exists():
        destination_root.replace(backup_root)
    try:
        temporary_root.replace(destination_root)
        shutil.rmtree(backup_root, ignore_errors=True)
    except BaseException:
        shutil.rmtree(destination_root, ignore_errors=True)
        if backup_root.exists():
            backup_root.replace(destination_root)
        raise
    shutil.rmtree(staging_root, ignore_errors=True)
    print(f"Narrative Bridge sidecar prepared for {args.target}")


if __name__ == "__main__":
    main()
