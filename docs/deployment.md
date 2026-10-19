# OCIへの導入

この手順は新規環境向けです。既存の稼働サーバーやDBへの上書きインストールには使いません。
アプリのソースとデータ・接続設定は分離しています。共有元の文書、DBデータ、APIキー、Walletは含まれません。

## 必要なもの

- OCIの利用可能なコンパートメント、VCN、サブネット、SSH公開鍵。
- Ubuntu x86_64のComputeイメージ。スタックの初期設定は`apt`を使用します。
- Oracle AI Database 26aiのVector / Oracle Text機能。このスタックはADBを新規作成します。
- OCI Object Storage、Embedding / Rerank用のOCI Generative AIへのアクセス。
- VLM・AIアシスタントを利用する場合はOCI Enterprise AIの接続先・APIキー・モデル。
- OCR / MinerUを有効化する場合は別途そのAPI。スタックはGPUやOCRサーバーを作成しません。

Compute、ADB、ストレージ、AIの利用料金が発生します。初期値はCompute 2 OCPU / 16 GB、
ブートディスク100 GB、ADB 2 ECPU / 1 TBです。作成前に値を確認してください。
デプロイ先は大阪または東京を選択できますが、AIモデルの利用リージョンは別に設定します。

## 権限とネットワーク

スタックの作成・実行には、所属グループに対象コンパートメントの
`manage orm-stacks`と`manage orm-jobs`が必要です。さらにCompute、ネットワーク、ADB、
Object Storageを実際に作成・利用できる権限が必要です。
共有VCNが別コンパートメントにある場合は、そのネットワークにもアクセス権が必要です。
管理者は[Resource Managerの権限定義](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/resourcemanagerpolicyreference.htm)
を参照して、利用者・アプリ用ユーザーの権限を分けて設定してください。
アプリは画面またはOCI設定ファイルで指定された認証情報を使います。スタックはIAM設定を自動作成しません。

ComputeからGitHub、OSパッケージ、Python/npmレジストリ、利用するOCI APIへの外向き通信が必要です。
プライベートサブネットではNAT等の経路と、利用者からのアクセス経路を用意します。
利用者からNginxへの80番、管理元からのSSH 22番、ComputeからADBへの1522番を用途に応じて許可します。
アプリの8081 / 5175番をインターネットへ直接開放する必要はありません。
外部に提供する場合のHTTPS終端はロードバランサーやリバースプロキシ側で設定します。

## 1. 配布ZIPを取得する

[Releases](https://github.com/yushibats/no.1-semantic-doc-search-yushibats/releases)から、
この手順に対応した`semantic-doc-search-stack.zip`と`SHA256SUMS`を取得します。
旧`v1.13.1.zip`はこの稼働版とは異なります。

まだ新しいリリースがない場合は、GitHubに存在する整備済みコミットをチェックアウトし、次を実行します。

```bash
git clone https://github.com/yushibats/no.1-semantic-doc-search-yushibats.git
cd no.1-semantic-doc-search-yushibats
git checkout <整備済みコミットの40桁SHA>
python3 scripts/package_release.py
```

`dist/semantic-doc-search-stack.zip`が生成されます。未コミットの変更があるとパッケージ作成は停止します。
ZIP直下にTerraform定義、`schema.yaml`、`release.auto.tfvars.json`、`RELEASE.json`が入ります。
Resource ManagerにはソースZIPではなく、このスタックZIPを指定してください。

`release.auto.tfvars.json`は取得元と40桁のコミットSHAを固定します。
ComputeはそのSHAだけを取得し、一致を検証してから初期設定を実行します。
コミットがGitHub上に未公開の場合や取得元が非公開の場合、このデプロイ経路では起動できません。
リリースのタグが存在するだけでは配布ZIPが公開されたことにはなりません。

## 2. スタックを作成する

1. OCIコンソールをデプロイ先リージョンに切り替え、Resource Managerの「スタックの作成」でZIPをアップロードします。
2. コンパートメントとTerraform 1.5.xを選びます。
3. `deploy_region`をコンソールと同じリージョンにし、そのテナンシの可用性ドメイン、Ubuntu x86_64イメージ、Computeのシェイプを選びます。
4. VCNとCompute用サブネットを選び、ADBのPrivate Endpointを使う場合はADB用サブネットも選びます。
5. DB名・ADMINパスワード・バケット名・SSH公開鍵を指定します。最初はDifyを無効にします。
6. Planを確認してからApplyします。

Apply成功後もVM内のインストールが続くことがあります。SSHで次を確認します。

```bash
sudo cloud-init status --long
sudo tail -n 80 /var/log/cloud-init-custom.log
sudo tail -n 80 /var/log/init_script.log
curl --fail http://127.0.0.1/ai/health
```

`/ai/health`が`healthy`を返したら、スタック出力の`application_url`を開きます。
Terraform stateやcloud-initの設定にはDB認証情報・Walletが含まれるため、共有するのは配布ZIPだけです。

## 3. アプリを初期設定する

1. 作成したDBのユーザー名・パスワードでログインします。共有元のログイン情報は使いません。
2. 「設定」のDB管理で接続を確認し、新しいDBのシステムテーブルを初期化します。
   APIは`POST /ai/api/database/system-tables/initialize`です。初期化と**再作成**は別の操作です。
3. OCI設定でObject Storage、Embedding、必要に応じてEnterprise AIの接続を設定します。
4. 検索設定でVLM抽出プロファイルを確認します。OCR / MinerUは利用できる接続先を登録してから有効にします。
5. `docs/sample-document.md`を文書管理から登録し、必要な処理を実行して公開状態にします。
6. 「青空サンプル」「開放的なリビング」等で検索し、結果・ダウンロード・処理状態を確認します。

共有元DB内の文書・タグ・カスタムプロファイルはコピーされません。
ソースに含まれる初期値を確認し、利用目的に合わせて設定します。
詳しい設定は[設定項目](configuration.md)、更新・削除は[運用手順](operations.md)を参照してください。

## よくある問題

| 症状 | 確認すること |
|---|---|
| スタック作成で`NotAuthorizedOrNotFound (404)` | コンパートメントの権限とZIPの参照先。まず取得済みスタックZIPのアップロードで切り分ける |
| `git fetch`が失敗 | `RELEASE.json`のリポジトリとコミットがGitHubで取得できるか、VMの外向き経路 |
| Apply成功後に502 | cloud-initの終了状況、`/var/log/app-backend.log`、`/var/log/app-frontend.log` |
| ログインできない | DB接続文字列、Wallet、DBの状態、1522番への経路 |
| 検索結果が空 | 初期化済みか、対象文書の処理・公開状態、選択した検索方式、モデル設定 |
| OCRだけ失敗 | 有効化したOCRサービスのURL・APIキー・モデル。OCR APIは別途用意する |
