"""Real semantic smoke. Requires provisioned assets and a GPU-capable runtime."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from inference import similarity


def run(fixtures: Path) -> dict:
    violin = (fixtures / "violin.mid").read_bytes()
    drums = (fixtures / "drums.mid").read_bytes()
    import base64

    violin_item = {"modality": "midi", "dataBase64": base64.b64encode(violin).decode()}
    drums_item = {"modality": "midi", "dataBase64": base64.b64encode(drums).decode()}
    matching = similarity({"modality": "text", "text": "solo violin melody"}, violin_item)["similarity"]
    mismatched = similarity({"modality": "text", "text": "solo violin melody"}, drums_item)["similarity"]
    if not matching > mismatched:
        raise AssertionError(f"matching score {matching} must exceed mismatched score {mismatched}")
    return {"ok": True, "matching": matching, "mismatched": mismatched}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    print(json.dumps(run(parser.parse_args().fixtures), sort_keys=True))