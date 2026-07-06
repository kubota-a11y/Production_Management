# Windows PCへの移行手順

このアプリ（案件管理システム）を、社内に置きっぱなしのWindows PCへ移設するための手順です。
コード自体は今回の対応でWindows/macOSどちらでも動くように修正済みです。

## 全体の流れ

1. Windows PCにNode.jsをインストール
2. プロジェクト一式をWindows PCにコピー
3. 依存パッケージを再インストール（`npm install`）
4. `.env` にNASのパスをWindows形式で設定
5. 動作確認
6. ファイアウォールでLAN内アクセスを許可
7. ログイン時自動起動＋スリープ防止を設定

---

## 1. Node.jsをインストール

[https://nodejs.org](https://nodejs.org) から **LTS版** のWindowsインストーラー（.msi）をダウンロードして実行してください。インストール後、コマンドプロンプトで確認します。

```
node -v
npm -v
```

バージョンが表示されればOKです（Node 18以上が必要）。

## 2. プロジェクトをコピー

`node_modules` フォルダは含めずに（Mac用のバイナリが入っており、Windowsでは動かないため）、プロジェクト一式をUSBメモリや共有フォルダ経由でWindows PCにコピーしてください。

コピー先の例: `C:\ProductionManagement\`

**重要**: `db\projects.db` は既存の案件データが入っているファイルです。これは必ずコピーしてください（削除・上書きしないよう注意）。

## 3. 依存パッケージをインストール

Windows PC上で、コピーしたフォルダに移動してインストールします。

```
cd C:\ProductionManagement
npm install
```

better-sqlite3というパッケージがWindows用に再ビルド（またはダウンロード）されます。もし途中で `node-gyp` や `python` 関連のエラーが出て失敗する場合は、以下のいずれかを試してください。

- Node.jsのバージョンをLTS版（推奨）に変える
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)を「C++によるデスクトップ開発」ワークロード付きでインストールしてから再度 `npm install`

## 4. .env を設定

プロジェクトフォルダに `.env` ファイルを作成し（`.env.example` をコピーして編集）、NASのパスをWindows形式で指定します。

NASがネットワークドライブとして割り当て済み（例: `Z:`）の場合:

```
NAS_BASE_PATH=Z:\DESIGN
```

ドライブ未割り当てでUNCパスを直接使う場合:

```
NAS_BASE_PATH=\\HIYOSHI1\disk1\DESIGN
```

どちらでもエクスプローラーでそのフォルダに実際に入れることを事前に確認してください。

## 5. 動作確認

```
npm start
```

「サーバー起動」とログが出て、`http://localhost:3000` にアクセスして案件管理システムが表示されればOKです。他のPCからのアクセス用URLも同じログに表示されます。

## 6. ファイアウォールの許可

初回起動時にWindows Defenderファイアウォールの確認ダイアログが出たら「アクセスを許可する」を選択してください（**プライベートネットワーク**にチェック）。

ダイアログが出ない・誤って拒否した場合は、手動で許可します。

1. 「Windows Defender ファイアウォールを許可されたアプリ」を検索して開く
2. 「設定の変更」→「別のアプリの許可」
3. `node.exe`（通常 `C:\Program Files\nodejs\node.exe`）を追加し、「プライベート」にチェック

## 7. 自動起動＋スリープ防止

### 自動起動（タスクスケジューラ）

1. 「タスクスケジューラ」を開く
2. 「基本タスクの作成」
3. トリガー: 「ログオン時」
4. 操作: 「プログラムの開始」
   - プログラム: `npm.cmd`（または `C:\Program Files\nodejs\npm.cmd`）
   - 引数: `start`
   - 開始場所: `C:\ProductionManagement`
5. 作成後、タスクのプロパティを開き「全般」タブで「最上位の特権で実行する」にチェック、「条件」タブで「AC電源に接続している場合のみ〜」のチェックを外す

### スリープ防止

設定 → システム → 電源とバッテリー → 画面と電源がオフになるまでの時間 で、「電源接続時」の「スリープ状態にする」を「なし」に設定してください（画面オフだけならOK、スリープはNGです）。

Windows PCなので、Macの「蓋を閉じるとスリープ」のような制約はありません。電源に繋がっていれば継続稼働します。

---

## 旧Mac側の後片付け（任意）

Mac側でLaunchAgentを設定していた場合は、以下で停止・削除できます。

```
launchctl unload ~/Library/LaunchAgents/com.hiyoshi.production-management.plist
rm ~/Library/LaunchAgents/com.hiyoshi.production-management.plist
```

Windows移行後は、社員のみなさんに新しいURL（Windows PCのIPアドレス）を共有してください。
