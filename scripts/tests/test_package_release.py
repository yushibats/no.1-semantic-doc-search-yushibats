import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).parents[1] / "package_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.output = Path(self.temp.name) / "out"
        self.git("init", "-q")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release@example.com")
        files = {".gitignore": ".env\nnode_modules/\ndist/\n", ".env.example": "API_KEY=\n",
                 "init_script.sh": "#!/bin/bash\n", "backend/uv.lock": "version = 1\n",
                 "frontend/package-lock.json": "{}\n", "terraform/stack/variables.tf": "# fixture\n",
                 "terraform/stack/cloud_init/bootstrap.template.yaml": "#cloud-config\n"}
        for name, content in files.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        self.git("add", ".")
        self.git("commit", "-qm", "Fixture")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args]).decode().strip()

    def build(self):
        return release.package(self.root, self.output, "HEAD", "example/semantic-search")

    def test_pins_same_commit_and_excludes_ignored_secrets(self):
        (self.root / ".env").write_text("API_KEY=local-secret\n")
        result = self.build()
        with zipfile.ZipFile(self.output / "semantic-doc-search-stack.zip") as z:
            config = json.loads(z.read("release.auto.tfvars.json"))
            self.assertEqual(config["source_revision"], self.git("rev-parse", "HEAD"))
            self.assertEqual(config["source_repository_url"], "https://github.com/example/semantic-search.git")
            self.assertIn("cloud_init/bootstrap.template.yaml", z.namelist())
        with zipfile.ZipFile(self.output / "semantic-doc-search-source.zip") as z:
            self.assertNotIn(".env", z.namelist())
            self.assertEqual(json.loads(z.read("RELEASE.json"))["commit"], result["commit"])
        first = (self.output / "semantic-doc-search-stack.zip").read_bytes()
        self.build()
        self.assertEqual(first, (self.output / "semantic-doc-search-stack.zip").read_bytes())
        self.assertIn(hashlib.sha256(first).hexdigest(), (self.output / "SHA256SUMS").read_text())

    def test_rejects_uncommitted_changes(self):
        (self.root / "init_script.sh").write_text("uncommitted\n")
        with self.assertRaisesRegex(ValueError, "working tree"):
            self.build()

    def test_rejects_tracked_credentials(self):
        (self.root / ".env").write_text("API_KEY=secret\n")
        self.git("add", "-f", ".env")
        self.git("commit", "-qm", "Accidental secret")
        with self.assertRaisesRegex(ValueError, "credential"):
            self.build()

    def test_rejects_repository_with_shell_or_url_components(self):
        for repository in ["https://github.com/a/b", "a/b;cmd", "a/b/extra"]:
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                release.package(self.root, self.output, "HEAD", repository)


if __name__ == "__main__":
    unittest.main()
