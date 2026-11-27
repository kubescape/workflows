import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rollout", ROOT / "scripts/contribution-policy-rollout.py")
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def repository(self, name="operator", **changes):
        return {"name": name, "default_branch": "main", "permissions": {"push": True}, "has_issues": True, **changes}

    def test_active_repositories_include_issue_disabled_forks(self):
        workflow, entries = rollout.plan([
            self.repository(),
            self.repository("fork", has_issues=False, fork=True),
            self.repository("archive", archived=True),
            self.repository("restricted", permissions={"push": False}),
            self.repository("disabled", disabled=True),
        ], "a" * 40, "uses: kubescape/workflows/action@POLICY_COMMIT_SHA")
        self.assertEqual([e["eligible"] for e in entries], [True, True, False, False, False])
        self.assertIn("@" + "a" * 40, workflow)
        self.assertFalse(entries[1]["issues_enabled"])

    def test_rejects_mutable_refs_foreign_repositories_and_path_traversal(self):
        for sha in ["main", "v1", "a" * 39]:
            with self.assertRaises(ValueError):
                rollout.plan([self.repository()], sha, "POLICY_COMMIT_SHA")
        for repository in [self.repository("../other"), self.repository(full_name="other/operator")]:
            with self.assertRaises(ValueError):
                rollout.plan([repository], "a" * 40, "POLICY_COMMIT_SHA")

    def test_existing_local_changes_are_preserved(self):
        workflow, entries = rollout.plan([self.repository()], "a" * 40, "POLICY_COMMIT_SHA")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            rollout.write_plan(workflow, entries, output)
            rollout.write_plan(workflow, entries, output)
            path = output / "operator/.github/workflows/contribution-policy.yaml"
            path.write_text("local edits")
            with self.assertRaises(ValueError):
                rollout.write_plan(workflow, entries, output)
            self.assertEqual(path.read_text(), "local edits")

    def test_template_has_no_checkout_and_uses_only_the_pinned_action(self):
        template = (ROOT / "templates/contribution-policy.yaml").read_text()
        workflow, _ = rollout.plan([self.repository()], "a" * 40, template)
        self.assertNotIn("actions/checkout", workflow)
        self.assertNotIn("pull_request.head", workflow)
        self.assertIn("github.repository_owner == 'kubescape'", workflow)
        self.assertIn("queue: max", workflow)
        self.assertIn("vars.CONTRIBUTION_POLICY_START != ''", workflow)
        self.assertEqual(workflow.count("- uses:"), 1)


if __name__ == "__main__":
    unittest.main()
