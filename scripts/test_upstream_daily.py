"""Windows scheduler guard integration tests; no live Codex, network or app changes."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
POWERSHELL = shutil.which("powershell.exe")


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell integration")
class DailyUpstreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-upstream-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.repo = self.directory / "checkout with spaces"
        self.scripts = self.repo / "scripts"
        self.scripts.mkdir(parents=True)
        for name in ("upstream-daily-windows.ps1", "upstream-daily.prompt.txt", "upstream-daily.schema.json"):
            shutil.copyfile(ROOT / "scripts" / name, self.scripts / name)
        (self.repo / ".gitignore").write_text("/.tools\n", encoding="utf-8")
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("remote", "add", "origin", "https://github.com/ffffhx/herdr-app.git")
        self.git("remote", "add", "upstream", "https://github.com/herdrdev/herdr-app.git")
        self.git("add", ".")
        self.git("commit", "-m", "test: fixture")
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.called = self.directory / "called.txt"
        fake = self.bin / "fake.py"
        fake.write_text(
            "import json, os, pathlib, sys, time\n"
            "args = sys.argv[1:]\n"
            "pathlib.Path(os.environ['HERDR_TEST_CALLED']).write_text(sys.stdin.read(), encoding='utf-8')\n"
            "time.sleep(float(os.environ.get('HERDR_TEST_DELAY', '0')))\n"
            "report = {'outcome': os.environ.get('HERDR_TEST_OUTCOME', 'up-to-date'), 'summary': 'test result', "
            "'upstream_commit': None, 'installed_commit': None, 'installed_sha256': None, 'checks': [], 'blockers': []}\n"
            "pathlib.Path(args[args.index('-o') + 1]).write_text(json.dumps(report), encoding='utf-8')\n"
            "print(json.dumps({'type': 'test.complete'}))\n"
            "sys.exit(int(os.environ.get('HERDR_TEST_EXIT', '0')))\n",
            encoding="utf-8",
        )
        (self.bin / "codex.cmd").write_text(f'@echo off\n"{sys.executable}" "{fake}" %*\n', encoding="utf-8")
        for name in ("node", "cargo", "bun", "ppilot"):
            (self.bin / f"{name}.cmd").write_text("@echo off\nexit /b 0\n", encoding="utf-8")
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        LOCALAPPDATA=str(self.directory / "appdata"), HERDR_TEST_CALLED=str(self.called))
        self.command = [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                        str(self.scripts / "upstream-daily-windows.ps1")]

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.STDOUT, text=True).strip()

    def run_task(self, *args, **env):
        result = subprocess.run(self.command + list(args), env=dict(self.env, **env),
                                capture_output=True, encoding="utf-8", timeout=30)
        self.assertTrue(result.stdout.strip(), result.stderr)
        return result.returncode, json.loads(result.stdout)

    def test_check_only_does_not_invoke_codex_or_change_source(self):
        before = self.git("rev-parse", "HEAD")
        code, record = self.run_task("-CheckOnly")
        self.assertEqual((code, record["outcome"]), (0, "ready"))
        self.assertFalse(self.called.exists())
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_dirty_checkout_is_preserved_without_invoking_codex(self):
        draft = self.repo / "draft.txt"
        draft.write_text("unfinished work", encoding="utf-8")
        code, record = self.run_task()
        self.assertEqual((code, record["outcome"]), (0, "skipped"))
        self.assertFalse(self.called.exists())
        self.assertEqual(draft.read_text(encoding="utf-8"), "unfinished work")

    def test_wrong_branch_and_in_progress_git_operation_are_skipped(self):
        self.git("checkout", "-b", "other-task")
        self.assertEqual(self.run_task()[1]["outcome"], "skipped")
        self.git("checkout", "main")
        marker = self.repo / ".git" / "index.lock"
        marker.write_text("owned by another operation", encoding="utf-8")
        self.assertEqual(self.run_task()[1]["outcome"], "skipped")
        self.assertTrue(marker.exists())
        self.assertFalse(self.called.exists())

    def test_structured_agent_outcomes_and_nonzero_exit(self):
        code, record = self.run_task()
        self.assertEqual((code, record["outcome"]), (0, "up-to-date"))
        self.assertIn("Run directory:", self.called.read_text(encoding="utf-8"))
        self.assertTrue((Path(record["directory"]) / "events.jsonl").exists())
        code, record = self.run_task(HERDR_TEST_OUTCOME="blocked")
        self.assertEqual((code, record["outcome"]), (2, "blocked"))
        code, record = self.run_task(HERDR_TEST_EXIT="7")
        self.assertEqual((code, record["outcome"]), (1, "failed"))
        self.assertIn("code 7", record["summary"])

    def test_claimed_installation_requires_real_manifest_and_binary(self):
        code, record = self.run_task(HERDR_TEST_OUTCOME="installed")
        self.assertEqual((code, record["outcome"]), (1, "failed"))
        self.assertFalse((self.directory / "appdata" / "Programs" / "herdr-app").exists())

    def test_concurrent_run_does_not_start_a_second_agent(self):
        process = subprocess.Popen(self.command, env=dict(self.env, HERDR_TEST_DELAY="3"),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")
        try:
            deadline = time.monotonic() + 15
            while not self.called.exists() and time.monotonic() < deadline and process.poll() is None:
                time.sleep(0.05)
            self.assertTrue(self.called.exists())
            code, record = self.run_task()
            self.assertEqual((code, record["outcome"]), (0, "skipped"))
            self.assertIn("Another upstream update", record["summary"])
        finally:
            output, error = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0, error)
        completed = json.loads(output)
        latest = json.loads((self.repo / ".tools" / "upstream-daily" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["run"], completed["run"])


if __name__ == "__main__":
    unittest.main()
