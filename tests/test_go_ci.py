"""Exercise the workflow's actual shell scripts without network dependencies.

Run with: python3 -m unittest discover -s tests -v
YAML structure and GitHub expressions are checked separately with actionlint.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/go-basic-tests.yaml"


def run_block(anchor):
    """Extract an anchored step's literal run block, enforcing its indentation."""
    lines = WORKFLOW.read_text().splitlines()
    start = lines.index("      - &" + anchor)
    for index in range(start + 1, len(lines)):
        if lines[index] == "        run: |":
            break
        if lines[index].startswith("      - "):
            raise AssertionError(f"Missing run block for {anchor}")
    else:
        raise AssertionError(f"Missing run block for {anchor}")
    script = []
    for line in lines[index + 1:]:
        if line and not line.startswith("          "):
            break
        script.append(line[10:] if line else "")
    if not script:
        raise AssertionError(f"Empty run block for {anchor}")
    return "\n".join(script) + "\n"


class GoWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.module = self.root / "module"
        self.module.mkdir()
        (self.module / "go.mod").write_text("module example.com/ci\n\ngo 1.20\n")
        self.env = dict(os.environ, RUNNER_TEMP=str(self.root), GITHUB_JOB="test",
                        GITHUB_OUTPUT=str(self.root / "outputs"),
                        GITHUB_STEP_SUMMARY=str(self.root / "summary"),
                        UNIT_TESTS_PATH="./...",
                        TEST_PARALLELISM="0", TEST_PACKAGE_PARALLELISM="0",
                        TEST_TIMEOUT_MINUTES="10", TEST_COVERAGE="false", GOPROXY="off", GOSUMDB="off",
                        GOTOOLCHAIN="local", GOFLAGS="", GOWORK="off")

    def shell(self, anchor):
        return subprocess.run(["bash", "-e", "-o", "pipefail", "-c", run_block(anchor)],
                              cwd=self.module, env=self.env, text=True,
                              capture_output=True, timeout=120)

    def execute(self):
        result = self.shell("go_tests")
        outputs = dict(line.split("=", 1) for line in
                       Path(self.env["GITHUB_OUTPUT"]).read_text().splitlines())
        self.results = Path(outputs["results_dir"])
        self.assertEqual(outputs["artifact_name"], self.results.name)
        self.assertEqual(self.results.parent, self.root)
        summary = self.summarize("success" if result.returncode == 0 else "failure")
        return result, summary

    def summarize(self, outcome):
        self.env.update(TEST_RESULTS_DIR=str(self.results), TEST_OUTCOME=outcome)
        result = self.shell("go_test_summary")
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(self.env["GITHUB_STEP_SUMMARY"]).read_text()

    @unittest.skipUnless(shutil.which("go"), "Go is required for integration tests")
    def test_real_go_outcomes(self):
        cases = {
            "pass": ('package ci\nimport "testing"\n'
                     'func TestPass(t *testing.T) { t.Log("passing output") }\n',
                     True, "passing output"),
            "named_subtest": ('package ci\nimport "testing"\n'
                              'func TestParent(t *testing.T) { t.Run("child", '
                              'func(t *testing.T) { t.Fatal("failure marker") }) }\n',
                              False, "TestParent/child"),
            "testmain": ('package ci\nimport ("testing"; "os"; "fmt")\n'
                         'func TestMain(m *testing.M) { fmt.Println("TestMain marker"); os.Exit(1) }\n',
                         False, "TestMain marker"),
            "build": ('package ci\nvar broken = undefinedBuildMarker\n',
                      False, "undefinedBuildMarker"),
        }
        for name, (source, success, marker) in cases.items():
            with self.subTest(name=name):
                Path(self.env["GITHUB_OUTPUT"]).write_text("")
                Path(self.env["GITHUB_STEP_SUMMARY"]).write_text("")
                (self.module / "ci_test.go").write_text(source)
                result, summary = self.execute()
                self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
                self.assertTrue((self.results / "tests.jsonl").exists())
                self.assertIn(marker, (self.results / "tests.log").read_text() +
                              (self.results / "test.stderr").read_text())
                self.assertIn("Go tests: " + ("success" if success else "failure"), summary)
                if not success:
                    self.assertIn(marker, summary)

    @unittest.skipUnless(shutil.which("go"), "Go is required for integration tests")
    def test_go_list_failure_retains_diagnostics(self):
        self.env["UNIT_TESTS_PATH"] = "./missing-package"
        result, summary = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.results / "list.stderr").read_text())
        self.assertIn("missing-package", summary)
        self.assertIn("No named test failure", summary)
        self.assertTrue((self.results / "tests.log").exists())

    def fake_go(self, packages="example.com/ci\nexample.com/ci/e2e\n"):
        binary = self.root / "bin"
        binary.mkdir(exist_ok=True)
        fake = binary / "go"
        fake.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                        "with open(os.environ['GO_CALLS'], 'a') as out:\n"
                        "    out.write(json.dumps(sys.argv[1:]) + '\\n')\n"
                        f"if sys.argv[1] == 'list': print({packages!r}, end='')\n")
        fake.chmod(0o755)
        self.env.update(PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        GO_CALLS=str(self.root / "calls"))

    def test_flags_and_package_filtering(self):
        self.fake_go()
        for coverage, parallel, package_parallel in (
                ("false", "2", "3"), ("true", "0", "0"),
                ("false", "0", "0")):
            with self.subTest(coverage=coverage, parallel=parallel):
                self.env.update(TEST_COVERAGE=coverage,
                                TEST_PARALLELISM=parallel,
                                TEST_PACKAGE_PARALLELISM=package_parallel,
                                UNIT_TESTS_PATH="./pkg/...\n./internal/... ./literal-$(touch-INJECTED)/*")
                result, _ = self.execute()
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in (self.root / "calls").read_text().splitlines()]
                self.assertEqual(calls[-2], ["list", "./pkg/...", "./internal/...",
                                             "./literal-$(touch-INJECTED)/*"])
                expected = ["test", "-json", "-count=1", "-timeout", "10m"]
                if parallel != "0":
                    expected += ["-parallel", parallel, "-p", package_parallel]
                if coverage == "true":
                    expected += ["-covermode=count", "-coverprofile=coverage.out"]
                else:
                    expected += ["-race"]
                self.assertEqual(calls[-1], expected + ["example.com/ci"])

    def test_timeout_wrapper_preserves_input_for_validation(self):
        wrapper = WORKFLOW.with_name("incluster-comp-pr-created.yaml").read_text()
        self.assertIn("TEST_TIMEOUT_MINUTES: ${{ inputs.TEST_TIMEOUT_MINUTES }}", wrapper)
        self.assertNotIn("inputs.TEST_TIMEOUT_MINUTES ||", wrapper)

    def test_custom_timeout_in_both_modes(self):
        self.fake_go()
        for coverage in ("false", "true"):
            with self.subTest(coverage=coverage):
                self.env.update(TEST_TIMEOUT_MINUTES="30", TEST_COVERAGE=coverage)
                result, _ = self.execute()
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in (self.root / "calls").read_text().splitlines()]
                self.assertEqual(calls[-1][3:5], ["-timeout", "30m"])

    def test_invalid_timeout_fails_before_go(self):
        self.fake_go()
        for value in ("0", "-1", "1.5", "abc", "", "$(touch INJECTED)"):
            with self.subTest(value=value):
                self.env["TEST_TIMEOUT_MINUTES"] = value
                result, summary = self.execute()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("TEST_TIMEOUT_MINUTES must be a positive integer", summary)
                self.assertFalse((self.root / "calls").exists())
                self.assertFalse((self.module / "INJECTED").exists())

    def test_invalid_parallelism_fails_before_go(self):
        self.fake_go()
        for setting in ("TEST_PARALLELISM", "TEST_PACKAGE_PARALLELISM"):
            for value in ("-1", "1.5", "abc"):
                with self.subTest(setting=setting, value=value):
                    self.env.update(TEST_PARALLELISM="0", TEST_PACKAGE_PARALLELISM="0")
                    self.env[setting] = value
                    result, summary = self.execute()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(setting + " must be a non-negative integer", summary)
                    self.assertFalse((self.root / "calls").exists())

    def test_empty_package_selection_fails(self):
        self.fake_go(packages="example.com/ci/e2e\n")
        result, summary = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No unit-test packages selected", summary)

    def test_summary_escapes_and_preserves_complete_artifact(self):
        self.results = self.root / "results"
        self.results.mkdir()
        events = [dict(Action="output", Package="pkg", Test="TestPassing",
                       Output="NOISY_PASSING_TEST\n" * 500),
                  dict(Action="pass", Package="pkg", Test="TestPassing"),
                  dict(Action="output", Package="pkg", Test="TestFail<script>",
                       Output="old output\n" * 50 + "<failure>&\n"),
                  dict(Action="fail", Package="pkg", Test="TestFail<script>")]
        (self.results / "tests.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events) + '{"partial":')
        summary = self.summarize("failure")
        self.assertIn("TestFail&lt;script&gt;", summary)
        self.assertIn("&lt;failure&gt;&amp;", summary)
        self.assertNotIn("<script>", summary)
        self.assertNotIn("NOISY_PASSING_TEST", summary)
        self.assertIn("1 non-JSON or incomplete lines", summary)
        readable = (self.results / "tests.log").read_text()
        self.assertEqual(readable.count("NOISY_PASSING_TEST"), 500)
        self.assertEqual(readable.count("old output"), 50)
        self.assertTrue(readable.endswith('{"partial":'))

    def test_oversized_summary_is_bounded(self):
        self.results = self.root / "results"
        self.results.mkdir()
        with (self.results / "tests.jsonl").open("w") as log:
            for index in range(30):
                for action, output in (("output", "<" * 20000), ("fail", "")):
                    log.write(json.dumps(dict(Action=action, Package="pkg", Test=f"Test{index}",
                                              Output=output)) + "\n")
        summary = self.summarize("failure")
        self.assertLess(len(summary.encode()), 65000)
        self.assertIn("Summary truncated", summary)
        self.assertEqual((self.results / "tests.log").stat().st_size, 600000)

    def test_go_build_events_include_compiler_diagnostics(self):
        self.results = self.root / "results"
        self.results.mkdir()
        import_path = "example.com/ci [example.com/ci.test]"
        events = [dict(Action="build-output", ImportPath=import_path,
                       Output="./ci_test.go:2:14: undefined: compilerMarker\n"),
                  dict(Action="build-fail", ImportPath=import_path),
                  dict(Action="fail", Package="example.com/ci", FailedBuild=import_path)]
        (self.results / "tests.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events))
        summary = self.summarize("failure")
        self.assertIn("compilerMarker", summary)
        self.assertIn("example.com/ci", summary)


if __name__ == "__main__":
    unittest.main()
