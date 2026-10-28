#!/usr/bin/env bash
# A project where mistake-brain is already set up: MISTAKES.md with its insert marker, and a git repo.
set -euo pipefail
git init -q .
cat > MISTAKES.md <<'MD'
# MISTAKES.md

Raw, append-only log for this agent. Newest entries go directly below the marker.

<!-- mistake-brain: new entries are inserted immediately below this line -->
MD
mkdir -p .agent-brain/shared
printf '# MEMORY\n' > .agent-brain/shared/MEMORY.md
