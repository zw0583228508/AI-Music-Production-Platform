"""Deploy Beat This from an exact, clean Git revision."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def git(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=ROOT, text=True
    ).strip()

def main() -> None:
    revision = git("rev-parse", "HEAD")
    if len(revision) != 40:
        raise RuntimeError("Beat This deployment requires a full Git revision")
    dirty = subprocess.run(
        ["git", "diff", "--quiet", "HEAD", "--",
         "services/beat-this-worker"],
        cwd=ROOT,
        check=False,
    )
    if dirty.returncode:
        raise RuntimeError("Beat This worker has uncommitted deployment inputs")
    environment = {**os.environ, "BEAT_THIS_SOURCE_REVISION": revision}
    subprocess.run(
        [
            "uv", "run", "modal", "deploy",
            "services/beat-this-worker/modal_app.py",
            "--name", "beat-this-worker", "--strategy", "rolling",
        ],
        cwd=ROOT,
        env=environment,
        check=True,
    )

if __name__ == "__main__":
    main()