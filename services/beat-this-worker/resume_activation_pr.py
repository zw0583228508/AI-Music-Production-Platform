"""Reopen the exact retained Beat This activation proposal."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Callable


Run = Callable[..., subprocess.CompletedProcess[str]]


def run_checked(run: Run, command: list[str]) -> subprocess.CompletedProcess[str]:
    result = run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("GitHub activation proposal command failed")
    return result


def recover_proposal(
    *,
    repository: str,
    base_branch: str,
    head_branch: str,
    expected_head_oid: str,
    title: str,
    body_file: Path,
    run: Run = subprocess.run,
) -> str:
    if not re.fullmatch(r"[a-f0-9]{40}", expected_head_oid):
        raise ValueError("activation proposal head revision is invalid")
    listed = run_checked(run, [
        "gh", "pr", "list",
        "--repo", repository,
        "--state", "all",
        "--head", head_branch,
        "--limit", "10",
        "--json", "number,state,headRefOid,baseRefName,url",
    ])
    proposals = json.loads(listed.stdout)
    if not isinstance(proposals, list) or len(proposals) > 1:
        raise ValueError("expected at most one retained activation proposal")
    if proposals:
        proposal = proposals[0]
        if (
            not isinstance(proposal, dict)
            or proposal.get("headRefOid") != expected_head_oid
            or proposal.get("baseRefName") != base_branch
            or not isinstance(proposal.get("number"), int)
            or not isinstance(proposal.get("url"), str)
        ):
            raise ValueError("retained activation proposal identity changed")
        state = proposal.get("state")
        if state == "OPEN":
            return proposal["url"]
        if state == "CLOSED":
            run_checked(run, [
                "gh", "pr", "reopen", str(proposal["number"]),
                "--repo", repository,
            ])
            return proposal["url"]
        raise ValueError("retained activation proposal was already merged")
    created = run_checked(run, [
        "gh", "pr", "create",
        "--repo", repository,
        "--base", base_branch,
        "--head", head_branch,
        "--title", title,
        "--body-file", str(body_file),
    ])
    url = created.stdout.strip()
    if not url.startswith("https://github.com/"):
        raise ValueError("GitHub did not return an activation proposal URL")
    return url


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--expected-head-oid", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", required=True)
    args = parser.parse_args()
    print(recover_proposal(
        repository=args.repository,
        base_branch=args.base,
        head_branch=args.head,
        expected_head_oid=args.expected_head_oid,
        title=args.title,
        body_file=Path(args.body_file),
    ))


if __name__ == "__main__":
    main()