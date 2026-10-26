"""brain-hud's hooks/hooks.json registers the skill's hooks, and nothing else does.

The plugin is the one path that registers them: init registers none and
removes what an older install put in settings. This ties hooks.json to the
hook files init_project.py knows, so a hook added to one can't be forgotten
in the other.

Run: pytest tests/skill/scripts/test_plugin_manifest.py -v
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILL = PLUGIN_ROOT / "skills" / "mistake-brain"
sys.path.insert(0, str(SKILL / "scripts"))

import init_project  # noqa: E402

HOOKS_JSON = PLUGIN_ROOT / "hooks" / "hooks.json"
RUNNER = 'sh "${CLAUDE_PLUGIN_ROOT}/skills/mistake-brain/hooks/run.sh" '

EXPECTED = {
    ("SessionStart", "startup|resume|clear|compact"): init_project.BRIEF_HOOK,
    ("Stop", None): init_project.REVERT_HOOK,
    ("PostToolUse", "Bash"): init_project.CAPTURE_HOOK,
    ("PostToolUse", "Edit|Write|MultiEdit"): init_project.AUTO_PIPELINE_HOOK,
    ("PostToolUseFailure", "Bash|PowerShell"): init_project.VALIDATION_FAILURE_HOOK,
}


def _registered() -> dict[tuple[str, str | None], list[str]]:
    data = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    out: dict[tuple[str, str | None], list[str]] = {}
    for event, entries in data["hooks"].items():
        for entry in entries:
            for h in entry["hooks"]:
                assert h["type"] == "command"
                out.setdefault((event, entry.get("matcher")), []).append(h["command"])
    return out


def test_hooks_json_keeps_the_mods_module():
    data = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    assert data["modules"] == ["./register.tsx"]


def test_every_skill_hook_is_registered_once_with_its_matcher():
    registered = _registered()
    assert set(registered) == set(EXPECTED)
    for key, hook in EXPECTED.items():
        assert registered[key] == [RUNNER + hook], key
    assert set(EXPECTED.values()) == set(init_project.HOOK_FILES)


def test_each_command_resolves_to_a_file_in_the_plugin():
    for commands in _registered().values():
        for command in commands:
            m = re.fullmatch(r'sh "\$\{CLAUDE_PLUGIN_ROOT\}/(.+?)" (\S+\.py)', command)
            assert m, command
            runner = PLUGIN_ROOT / m.group(1)
            assert runner.is_file()
            assert (runner.parent / m.group(2)).is_file()


def test_timeouts_are_set():
    data = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    for entries in data["hooks"].values():
        for entry in entries:
            for h in entry["hooks"]:
                assert 0 < h["timeout"] <= 60
