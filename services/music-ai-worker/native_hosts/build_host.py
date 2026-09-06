#!/usr/bin/env python3
"""Build a single checksum-bound executable native host zipapp."""
from __future__ import annotations

import argparse
import os
import tempfile
import zipapp
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("vst3", "sfz"))
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    entry = "pedalboard_vst3_host.py" if args.kind == "vst3" else "sfizz_track_model_host.py"
    with tempfile.TemporaryDirectory(prefix="native-host-build-") as temporary:
        package = Path(temporary)
        (package / "__main__.py").write_text(
            (root / entry).read_text().replace(
                'sys.path.insert(0, str(Path(__file__).resolve().parent))\n', ""
            )
        )
        (package / "common.py").write_bytes((root / "common.py").read_bytes())
        args.output.parent.mkdir(parents=True, exist_ok=True)
        zipapp.create_archive(package, args.output, interpreter="/usr/bin/env python3")
    os.chmod(args.output, 0o755)


if __name__ == "__main__":
    main()