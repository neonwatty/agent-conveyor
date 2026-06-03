from __future__ import annotations

import json
import os
import shutil
import stat
import argparse
from importlib import resources
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError


SKILL_NAMES = ("manage-codex-workers", "codex-review")


def default_codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser().resolve()


def _skill_assets_root() -> resources.abc.Traversable:
    return resources.files("workerctl").joinpath("assets", "skills")


def _copy_tree(src: resources.abc.Traversable, dest: Path) -> None:
    if src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            _copy_tree(child, dest / child.name)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())


def install_bundled_skills(*, codex_home: Path | None = None, dry_run: bool = False) -> dict[str, Any]:
    target_home = (codex_home or default_codex_home()).expanduser().resolve()
    assets_root = _skill_assets_root()
    if not assets_root.is_dir():
        raise WorkerError("bundled skills are missing from the agent-conveyor package")

    skills: list[dict[str, Any]] = []
    for skill_name in SKILL_NAMES:
        source = assets_root.joinpath(skill_name)
        if not source.is_dir():
            raise WorkerError(f"bundled skill is missing: {skill_name}")
        destination = target_home / "skills" / skill_name
        skills.append({
            "name": skill_name,
            "source": f"agent-conveyor:{skill_name}",
            "target": str(destination),
        })
        if dry_run:
            continue
        if destination.exists():
            shutil.rmtree(destination)
        _copy_tree(source, destination)
        if skill_name == "codex-review":
            helper = destination / "scripts" / "codex-review"
            if helper.exists():
                helper.chmod(helper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    return {
        "codex_home": str(target_home),
        "dry_run": dry_run,
        "skills": skills,
    }


def print_install_skills_result(result: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(result, indent=2, sort_keys=True))
        return
    action = "Would install" if result["dry_run"] else "Installed"
    print(f"{action} Agent Conveyor skills into {result['codex_home']}/skills:")
    for skill in result["skills"]:
        print(f"  {skill['name']} -> {skill['target']}")


def command_install_skills(args: argparse.Namespace) -> int:
    codex_home = Path(args.codex_home).expanduser().resolve() if args.codex_home else None
    result = install_bundled_skills(codex_home=codex_home, dry_run=bool(args.dry_run))
    print_install_skills_result(result, json_output=bool(args.json))
    return 0
