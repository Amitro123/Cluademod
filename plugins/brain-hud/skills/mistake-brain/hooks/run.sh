#!/bin/sh
# Runs one mistake-brain hook with the machine's Python 3: python3, else python
# (Windows installs often have only `python`). The hook's stdin passes through.
# With no Python 3 at all the hook is skipped and the session goes on.
dir=$(dirname "$0")
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    exec "$py" "$dir/$1"
  fi
done
exit 0
