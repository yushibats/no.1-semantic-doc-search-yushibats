# 設定項目

ルートの`.env.example`を`.env`にコピーし、各自の環境に合わせます。
OCIスタックはアプリとOracle Clientを`/u01/aipoc`配下へ配置します。
これは新規VM用の配置規約で、ローカル起動スクリプトはリポジトリ位置からパスを解決します。
設定画面から保存した値もこの`.env`に保存されます。実際の`.env`はGit管理しません。
`.env`はdotenv形式であり、シェルの`source .env`では読み込みません。

| 設定 | 用途 |
|---|---|
| `ORACLE_26AI_CONNECTION_STRING` | `ユーザー/パスワード@接続サービス名`形式のDB接続。新規OCI導入では自動設定 |
| `ORACLE_CLIENT_LIB_DIR` / `TNS_ADMIN` | Oracle ClientとWallet。ローカル開発では自分の配置先を指定 |
| `ADB_OCID` / `ADB_REGION` | ADBの操作対象。リージョン未指定時はOCIDから判定 |
| `OCI_CONFIG_FILE` / `OCI_PROFILE` / `OCI_KEY_FILE` | 自分のOCI認証設定と秘密鍵。パス未指定時は`~/.oci/config`と同じディレクトリの鍵を使用 |
| `OCI_COMPARTMENT_OCID` | アプリが使用するOCIリソースのコンパートメント |
| `OCI_BUCKET` / `OCI_NAMESPACE` | 文書用Object StorageのバケットとNamespace |
| `OCI_REGION_DEPLOY` | Object Storage等のデプロイ先リージョン |
| `OCI_REGION` | Generative AIの利用リージョン。デプロイ先と異なる場合がある |
| `OCI_COHERE_EMBED_MODEL` / `OCI_EMBEDDING_DIMENSIONS` | Embeddingのモデルと次元数。既存インデックス変更時は再索引が必要 |
| `OCI_ENTERPRISE_AI_BASE_URL` / `OCI_ENTERPRISE_AI_API_KEY` / `OCI_ENTERPRISE_AI_PROJECT` / `OCI_ENTERPRISE_AI_MODEL` | VLM・AIアシスタントの接続。利用可能なモデルを指定 |
| `OCR_ENABLED` / `MINERU_ENABLED` | OCR / MinerUの使用有無。最初は無効で、接続設定後に有効化 |
| `DOTS_MOCR_*` / `OCR_*` / `UNLIMITED_OCR_*` / `MINERU_*` | 各抽出サービスのURL、キー、モデル、処理上限 |
| `OCI_RERANK_ENABLED` / `OCI_RERANK_MODEL` | 再ランキングの使用有無とモデル |
| `PIPELINE_MAX_CONCURRENT_FILES` | 全ジョブで同時処理するファイル数。既定値3 |
| `DEBUG` | 既定値`false`。`true`では認証を省略するため、共有環境では変更しない |
| `EXTERNAL_API_KEYS` | 外部連携用の独自APIキー。空の場合はAPIキー認証を無効化 |
| `SHOW_AI_ASSISTANT` / `SHOW_SEARCH_TAB` | UIの表示切り替え |

モデル名やリージョンの例は利用権限・提供状況を保証するものではありません。
利用するテナンシの接続テストで確認してください。
検索プロファイル、文書メタデータ、索引、処理履歴はOracle DBに保存されます。
認証設定を他の利用者へ渡さず、利用者自身のOCI・DB設定を登録します。

## フロントエンド

開発用Viteサーバーは`/ai/api`をバックエンドへ転送します。
既定のバックエンドは`http://localhost:8081`です。変更時は`VITE_PROXY_TARGET`を指定します。
本番ではNginxが同じURL配下を転送するため、`VITE_API_BASE`は空のままで使用できます。
フロントエンドの環境変数はビルドに埋め込まれるので、秘密情報を設定しません。

## Dify

Difyは任意の連携機能です。まず本体だけを導入・検証してから追加します。
`dify/`のワークフローを取り込む場合は、`API_ENDPOINT`を自分のアプリURLに変更し、
HTTPノードの`Authorization: ApiKey ...`を自分が発行した`EXTERNAL_API_KEYS`の値に置き換えます。
テンプレートの`secret`は実際のキーとして使いません。
