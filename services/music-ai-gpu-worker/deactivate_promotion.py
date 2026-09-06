"""Atomically remove a provider from the canonical active promotion set."""
from __future__ import annotations

import argparse
from pathlib import Path

from activate_promotion import read_canonical, write_canonical
from modal_config import DEPLOYMENTS


def deactivate(provider: str, output: Path) -> None:
    if provider not in DEPLOYMENTS:
        raise ValueError("unknown promotion provider")
    canonical = read_canonical(output)
    if provider not in canonical["bundles"]:
        raise ValueError("provider is not active in canonical promotions")
    del canonical["bundles"][provider]
    write_canonical(canonical, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    deactivate(args.provider, Path(args.output))


if __name__ == "__main__":
    main()