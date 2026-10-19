from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
STACK_ASSET_URL = (
    "https://github.com/yushibats/no.1-semantic-doc-search-yushibats/"
    "releases/latest/download/semantic-doc-search-stack.zip"
)
DEPLOY_URL = (
    "https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl="
    f"{STACK_ASSET_URL}"
)
BUTTON_IMAGE_URL = (
    "https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/"
    "latest/deploy-to-oracle-cloud.svg"
)


class DeploymentContractTests(unittest.TestCase):
    def test_deploy_button_uses_latest_stack_release_asset(self):
        button = f"[![Deploy to Oracle Cloud]({BUTTON_IMAGE_URL})]({DEPLOY_URL})"
        for relative in ("README.md", "docs/deployment.md"):
            with self.subTest(file=relative):
                self.assertIn(button, (ROOT / relative).read_text())

    def test_release_workflow_attaches_button_target_asset(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn(
            "dist/semantic-doc-search-stack.zip",
            workflow,
        )
        self.assertIn("--draft", workflow)


if __name__ == "__main__":
    unittest.main()
