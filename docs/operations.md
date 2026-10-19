# 更新・リリース・削除

## リリース

1. PRの変更内容、CI、必要な検証環境での動作を確認して`main`へマージします。
2. マージ後のコミットに新しい`v*`タグを作成してpushします。既存タグは付け替えません。
3. GitHub Actionsが検証後、ソースZIP、OCIスタックZIP、`SHA256SUMS`を**ドラフトリリース**に添付します。
4. スタックZIPで新規環境への導入を確認し、リリースノートに確認結果・制約を記載して通常Releaseとして公開します。
5. 公開後、READMEのDeploy to Oracle Cloudボタンで「スタックの作成」が開き、パッケージが設定されることを確認します。
6. 利用者にはREADMEまたはそのリリースのURLを共有します。

ローカルで同じ成果物を生成するには、クリーンなチェックアウトで次を実行します。

```bash
python3 scripts/package_release.py --ref HEAD
```

フォークの場合は`--repository OWNER/REPOSITORY`を指定します。
パッケージ対象はGitにコミットされたファイルだけで、認証ファイルや生成物が紛れた場合は停止します。
`RELEASE.json`で取得元コミットとファイルハッシュを追跡できます。

READMEのDeploy to Oracle Cloudボタンは、次の公開済み最新Releaseアセットを参照します。

```text
https://github.com/yushibats/no.1-semantic-doc-search-yushibats/releases/latest/download/semantic-doc-search-stack.zip
```

GitHubで新しい通常Releaseを公開すると、ボタンは同名のアセットへ自動的に切り替わります。
ドラフトやプレリリースは`releases/latest`の対象外なので、検証中の成果物が利用者へ配布されることはありません。
Releaseを公開する前に、`semantic-doc-search-stack.zip`が添付されていることを確認してください。

## 既存環境の更新

更新前に、現在のコミット、`.env`、Wallet、DB、Object Storageの復元方法を確保します。
GitHubのコード更新だけでは、共有元のDBデータやモデル設定は移行されません。

1. 現在の作業差分を確認し、未コミットの変更を別途退避します。
2. 検証済みのタグまたはコミットをチェックアウトします。
3. `uv sync --directory backend --locked`と`npm ci --prefix frontend`を実行します。
4. `npm run --prefix frontend build`を実行します。
5. 導入先の管理方法でバックエンド・フロントエンドを再起動します。
6. `/ai/health`、ログイン、サンプル文書の検索を確認します。

`init_script.sh`は新規VM用です。`.env`を作り直すので更新目的では実行しません。
システムテーブルの「再作成」は通常のアプリ更新では不要です。
旧スキーマから移行が必要な場合は、DBバックアップと移行内容を確認したうえで別途実施します。
コードの切り戻しは旧コミットへ戻して再ビルドします。DB構造を変更した場合はコードだけでは戻りません。

## 削除

このスタックはCompute、ADB、文書バケットと、選択時はDify用バケットを作成します。
Destroyにはバケット内オブジェクトを削除する処理も含まれます。必要な文書・DBを先に退避してください。
バケット削除時の処理にはOCI CLIの権限が必要です。失敗した場合はバケット内容を確認し、空にしてから再実行します。
既存VCN・サブネットはこのスタックの管理対象外です。

## 配布物の追跡

配布ZIPの`RELEASE.json`には取得元リポジトリ、コミットSHA、各ファイルのハッシュが入ります。
障害調査や更新時はこの情報から導入済みソースを特定してください。
秘密情報、DBデータ、アップロード済み文書、環境固有の`.env`は配布物に含めません。
