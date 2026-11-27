#!/usr/bin/env python3
"""Generate repository-specific rollout files without changing GitHub state."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def plan(repositories, sha, template):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Use the full reviewed kubescape/workflows commit SHA")
    if template.count("POLICY_COMMIT_SHA") != 1:
        raise ValueError("Template must contain exactly one commit placeholder")
    workflow = template.replace("POLICY_COMMIT_SHA", sha)
    entries = []
    seen = set()
    for repository in repositories:
        name = repository["name"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in {".", ".."}:
            raise ValueError("Invalid repository name")
        full_name = repository.get("full_name", f"kubescape/{name}")
        if full_name != f"kubescape/{name}" or full_name.lower() in seen:
            raise ValueError("Inventory must contain unique Kubescape repositories")
        seen.add(full_name.lower())
        reason = None
        if repository.get("archived"):
            reason = "archived"
        elif repository.get("disabled"):
            reason = "disabled"
        elif not repository.get("permissions", {}).get("push"):
            reason = "no write access"
        elif not repository.get("default_branch"):
            reason = "no default branch"
        entries.append({
            "repository": full_name,
            "base": repository.get("default_branch"),
            "eligible": reason is None,
            "skip_reason": reason,
            "issues_enabled": repository.get("has_issues", True),
            "private": repository.get("private", False),
        })
    return workflow, entries


def write_plan(workflow, entries, output):
    for entry in entries:
        if not entry["eligible"]:
            continue
        name = entry["repository"].split("/", 1)[1]
        path = output / name / ".github/workflows/contribution-policy.yaml"
        if path.exists() and path.read_text() != workflow:
            raise ValueError(f"Refusing to overwrite a different workflow at {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(workflow)
    output.mkdir(parents=True, exist_ok=True)
    (output / "rollout.json").write_text(json.dumps(entries, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True, help="JSONL repository inventory from gh api")
    parser.add_argument("--sha", required=True, help="Full reviewed shared-action commit SHA")
    parser.add_argument("--output", type=Path, required=True, help="Local output directory; may contain private repository names")
    args = parser.parse_args()
    repositories = [json.loads(line) for line in args.inventory.read_text().splitlines() if line.strip()]
    workflow, entries = plan(repositories, args.sha, (ROOT / "templates/contribution-policy.yaml").read_text())
    write_plan(workflow, entries, args.output)
    print(f"Generated {sum(e['eligible'] for e in entries)} caller workflows; {sum(not e['eligible'] for e in entries)} repositories skipped. No GitHub changes made.")


if __name__ == "__main__":
    main()
