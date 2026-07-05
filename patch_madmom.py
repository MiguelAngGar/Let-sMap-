"""Patch madmom 0.16.1 for Python 3.10+.

Restores ABC names (MutableSequence, Mapping, ...) on the `collections`
module, which Python 3.10 removed. The shim is inserted AFTER madmom's
`from __future__` import (which must stay first in the file).

Idempotent + self-healing: removes any previously mis-placed shim first.
Run with the venv python:
    .\.venv\Scripts\python patch_madmom.py
"""
import os
import sys

MARKER = "# --- madmom py310 collections compat ---"
END = "# --- end compat ---"
SHIM = MARKER + """
import collections as _c
import collections.abc as _abc
for _n in ('MutableSequence', 'MutableMapping', 'Mapping', 'Sequence',
           'Iterable', 'Callable', 'MutableSet', 'Set', 'Hashable',
           'Container', 'Sized', 'ItemsView', 'KeysView', 'ValuesView'):
    if not hasattr(_c, _n):
        setattr(_c, _n, getattr(_abc, _n))
del _c, _abc, _n
""" + END

here = os.path.dirname(os.path.abspath(__file__))
init_path = os.path.join(here, ".venv", "lib", "site-packages", "madmom", "__init__.py")

if not os.path.isfile(init_path):
    sys.exit("madmom __init__.py not found at: " + init_path)

with open(init_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 1. Strip any previously inserted shim block (self-heal a bad run).
if any(MARKER in ln for ln in lines):
    start = next(i for i, ln in enumerate(lines) if MARKER in ln)
    end = next(i for i, ln in enumerate(lines) if END in ln)
    del lines[start:end + 1]

# 2. Find the last `from __future__` import; insert shim right after it.
future_idx = [i for i, ln in enumerate(lines) if ln.lstrip().startswith("from __future__")]
if future_idx:
    insert_at = future_idx[-1] + 1
else:
    # No future import: place after leading comments/docstring (best effort: top).
    insert_at = 0

lines.insert(insert_at, "\n" + SHIM + "\n")

with open(init_path, "w", encoding="utf-8") as f:
    f.writelines(lines)

print("patched (shim after __future__):", init_path)
