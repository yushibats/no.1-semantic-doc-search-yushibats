#!/usr/bin/env python3
"""Render and parse cloud-init locally without creating any OCI resources."""

import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import tempfile


root = Path(__file__).resolve().parents[1]
revision = "a" * 40
repository = "https://github.com/example/semantic-doc-search.git"
password = 'Fixture-only: "quotes" # spaces & symbols'
values = {
    "db_conn": base64.b64encode(gzip.compress(b"fixture-connection")).decode(),
    "db_pass": password, "adb_pass": password, "db_dsn": "fixture_high",
    "adb_name": "FIXTURE", "comp_id": "fixture-compartment", "bucket": "fixture-bucket",
    "dify_bucket": "fixture-dify", "adb_ocid": "fixture-adb", "enable_dify": False,
    "dify_branch": "1.13.0", "deploy_region": "ap-osaka-1", "bucket_namespace": "fixture",
    "oci_access_key": "", "oci_secret_key": "", "external_api_keys": "",
    "show_ai_assistant": True, "show_search_tab": True, "compute_subnet_is_private": "false",
    "wallet": base64.b64encode(b"fixture-wallet").decode(),
    "source_repository_url": repository, "source_revision": revision,
}
with tempfile.TemporaryDirectory() as temp:
    var_file = Path(temp) / "fixture.tfvars.json"
    var_file.write_text(json.dumps({
        "availability_domain": "fixture-ad", "deploy_region": "ap-osaka-1",
        "instance_image_source_id": "fixture-image", "source_revision": revision,
    }))
    expression = 'jsonencode(yamldecode(templatefile("cloud_init/bootstrap.template.yaml", ' + json.dumps(values) + ')))'
    result = subprocess.run(
        [os.getenv("TF_BINARY", "terraform"), "console", "-no-color", f"-var-file={var_file}"],
        cwd=root / "terraform/stack", input=expression + "\n", text=True,
        capture_output=True, check=True,
    )
    cloud_init = json.loads(json.loads(result.stdout))
    files = {item["path"]: item for item in cloud_init["write_files"]}
    assert files["/u01/aipoc/props/db_password.txt"]["content"] == password
    assert files["/u01/aipoc/props/adb_password.txt"]["content"] == password
    assert all(item["permissions"] == "0600" for item in files.values())
    bootstrap = cloud_init["runcmd"][-1]
    assert f"git remote add origin '{repository}'" in bootstrap
    assert f"git fetch --depth 1 origin '{revision}'" in bootstrap
    assert f'test "$(git rev-parse HEAD)" = \'{revision}\'' in bootstrap
    subprocess.run(["bash", "-n"], input=bootstrap, text=True, check=True)
print("cloud-init YAML, credential quoting, shell syntax and source pinning: OK")
