# ローカル開発と検証

必要なものはPython 3.13、uv、Node.js 20.19以上、npmです。
文書変換にはPoppler、LibreOffice、日本語フォント、DB接続にはOracle Client / Walletも必要です。
macOS向けには`scripts/setup-mac.sh`があります。OCI向け`init_script.sh`はVM全体の設定を変更するため、
手元のPCでは実行しません。

```bash
git clone https://github.com/yushibats/no.1-semantic-doc-search-yushibats.git
cd no.1-semantic-doc-search-yushibats
cp .env.example .env
uv sync --directory backend --locked --python 3.13 --group dev
npm ci --prefix frontend
```

`.env`のDB、Wallet、OCI接続を設定してから、別々のターミナルで起動します。

```bash
bash scripts/start-backend.sh
```

```bash
bash scripts/start-frontend.sh
```

ブラウザーで`http://localhost:5175/ai/`を開きます。
使用済みポートを停止する設定は既定で無効です。別の稼働アプリがある場合はポートを変更してください。

## 変更前後の確認

```bash
uv run --directory backend --frozen pytest -q
npm run --prefix frontend test:ui
npm run --prefix frontend build
python3 -m unittest discover -s scripts/tests -v
terraform -chdir=terraform/stack fmt -check -recursive
terraform -chdir=terraform/stack init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform/stack validate
python3 scripts/validate_cloud_init.py
```

バックエンドテストはDB・AIサービスをモックし、CIでは実際の認証情報を使いません。
これは新規OCI環境への導入確認や実モデルでの検索確認とは別です。
新規導入の確認には[サンプル文書](sample-document.md)を使い、登録・処理・検索・再起動を確認します。

依存関係は`backend/uv.lock`、`frontend/package-lock.json`、
`terraform/stack/.terraform.lock.hcl`で固定します。更新する場合はロックファイルも同じPRに含めます。
