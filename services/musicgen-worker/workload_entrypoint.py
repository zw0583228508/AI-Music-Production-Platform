"""JSON-only subprocess boundary for the Python 3.9 AudioCraft workload."""
from __future__ import annotations

import json
import os
from pathlib import Path


def main() -> None:
    action = os.environ.get("MUSICGEN_WORKLOAD_ACTION", "")
    if action == "provision":
        from bootstrap_assets import main as provision
        provision()
        from app import asset_state
        verified, message, inventory = asset_state()
        if not verified or inventory is None:
            raise RuntimeError(f"MusicGen provision verification failed: {message}")
        result = {"verified": True, "models": {key: value["resolvedRevision"]
                  for key, value in inventory["models"].items()}}
    elif action == "smoke":
        fixture = Path(os.environ["MUSICGEN_SMOKE_AUDIO"])
        from smoke import main as smoke
        proof = smoke(fixture)
        result = {"fixture": fixture.name, "textArtifactSha256": proof["text"]["artifactSha256"],
                  "melodyArtifactSha256": proof["melody"]["artifactSha256"]}
    else:
        raise RuntimeError("MUSICGEN_WORKLOAD_ACTION must be provision or smoke")
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()