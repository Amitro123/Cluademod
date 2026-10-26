"""Cursor sessionStart adapter reads the shared index and prints Cursor's schema."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HOOK = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain"
    / "hooks"
    / "cursor_brief.py"
)
MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"


def _run(payload: dict, env_extra: dict | None = None) -> str:
    import os

    env = dict(os.environ)
    env.pop("MISTAKE_BRAIN_HOST", None)
    env.update(env_extra or {})
    done = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


def _project(tmp_path: Path) -> Path:
    (tmp_path / "MISTAKES.md").write_text(f"# MISTAKES.md\n\n{MARKER}\n", encoding="utf-8")
    shared = tmp_path / ".agent-brain" / "shared" / "MEMORY.md"
    shared.parent.mkdir(parents=True, exist_ok=True)
    shared.write_text(
        "# MEMORY.md\n\n## Areas\n- [Area] Areas/x.md — SHARED_LESSON (1 lesson)\n",
        encoding="utf-8",
    )
    return tmp_path


def test_cursor_brief_uses_the_shared_index_and_cursor_schema(tmp_path):
    project = _project(tmp_path)
    out = json.loads(_run({"hook_event_name": "sessionStart", "workspace_roots": [str(project)]}))
    assert set(out) == {"additional_context"}
    assert "SHARED_LESSON" in out["additional_context"]


def test_cursor_brief_reads_the_same_content_regardless_of_inherited_host(tmp_path):
    """MISTAKE_BRAIN_HOST is overridden to "cursor" by cursor_brief.py itself
    regardless of what the parent process set -- but even if it weren't,
    both hosts now resolve to the same file, so this is no longer a
    meaningful distinction to guard. Kept as a non-regression check."""
    project = _project(tmp_path)
    out = json.loads(
        _run(
            {"hook_event_name": "sessionStart", "workspace_roots": [str(project)]},
            {"MISTAKE_BRAIN_HOST": "claude"},
        )
    )
    assert "SHARED_LESSON" in out["additional_context"]


def test_cursor_brief_prints_nothing_on_bad_stdin(tmp_path):
    import os

    env = dict(os.environ)
    done = subprocess.run(
        [sys.executable, str(HOOK)],
        input="not json",
        capture_output=True,
        text=True,
        env=env,
        cwd=tmp_path,
        timeout=30,
    )
    assert done.returncode == 0
