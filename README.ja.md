# warifuri

[English](README.md)

人と AI エージェントが、同じデータベースでゴールとタスクと予定を管理するためのツールです。自分の PC でサーバーを動かし、Claude Code や Codex から MCP で読み書きします。エージェントは作業の前にタスクを持ち、終わったら閉じます。

いまは v0.1 で、まず自分の PC で1人で使う形を想定しています。考え方は[原則](docs/principles.md)、全体の形は[構成](docs/architecture.md)にあります。

## 必要なもの

- Node.js 22.13 以上(データベースに Node の `node:sqlite` を使うため)
- Claude Code か Codex、またはその両方。`claude` か `codex` のコマンドが PATH から見えていること

Windows、macOS、Linux で動きます。

## インストール

```bash
npm install -g warifuri
```

`warifuri --help` で、使えるコマンドの一覧が出ます。

Windows の PowerShell で「このシステムではスクリプトの実行が無効になっている」と断られたときは、`warifuri` の代わりに `warifuri.cmd` と打ってください。npm が置く `warifuri.ps1` が、PowerShell の実行ポリシーで止められているためです。

## はじめる

### 1. データのフォルダを作る

```bash
warifuri init
```

データのフォルダ `~/.warifuri/`(Windows では `%USERPROFILE%\.warifuri`)に、設定ファイル `warifuri.env` のひな形、空の `secrets.env`、空の `profiles/` を作ります。すでにあるファイルは書き換えません。

### 2. サーバーを動かす

```bash
warifuri serve
```

`warifuri: serving http://127.0.0.1:8787/mcp` と出れば動いています。データベース(`~/.warifuri/ledger.sqlite`)は、最初の起動のときにできます。サーバーはこの PC の中(`127.0.0.1`)からしか受けません。使うあいだは、このターミナルを開いたままにします。止めるときは Ctrl+C を押します。

### 3. Claude Code と Codex につなぐ

別のターミナルを開いて、次を実行します。サーバーを一度起動してデータベースができてから実行してください。

```bash
warifuri connect
```

`connect` は、この PC で次のことをします。

- このデバイス(機械)の鍵を発行して、`~/.warifuri/device.key` に本人だけが読める形で置きます。デバイスの名前は、既定では PC のホスト名です。`--device <名前>` で変えられます。
- PATH にある `claude` と `codex` に、MCP サーバーを `warifuri` の名前で登録します。
- 着手ゲートのフックを、Claude Code の `~/.claude/settings.json` と Codex の `~/.codex/hooks.json` に足します。
- 軽い秘書のスキルを写します(下の節)。

設定ファイルを書き換える前には、元のファイルを `<ファイル>.bak-warifuri-<日時>` として隣に写します。ほかのフックや設定はそのまま残ります。何度実行しても同じ形になります。何をするかだけを見たいときは `warifuri connect --dry-run`、片方だけにつなぐときは `--harness claude` か `--harness codex` を付けます。

#### Claude Code

`connect` のあとに Claude Code を起動すれば使えます。登録されたかは次で確かめられます。

```bash
claude mcp list
```

`warifuri` が出ていれば、つながっています。Claude Code の中では `/mcp` でも見られます。

#### Codex

Codex は、鍵を環境変数 `WARIFURI_DEVICE_KEY` から読みます。Codex を起動するターミナルで、鍵のファイルの中身をこの変数に入れてから `codex` を起動します。

macOS と Linux:

```bash
export WARIFURI_DEVICE_KEY="$(cat ~/.warifuri/device.key)"
```

Windows の PowerShell:

```powershell
$env:WARIFURI_DEVICE_KEY = (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim()
```

毎回入れるのが手間なら、macOS と Linux ではシェルの設定ファイル(`~/.zshrc` など)に同じ行を書きます。Windows では、ユーザーの環境変数に入れておけます。入れたあとに開いたターミナルから使えます。

```powershell
[Environment]::SetEnvironmentVariable('WARIFURI_DEVICE_KEY', (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim(), 'User')
```

最後に、Codex の中で `/hooks` を開き、足した着手ゲートのフックを一度信頼します。Codex は、信頼したフックだけを動かします。登録されたかは `codex mcp list` で確かめられます。

### 着手ゲート

着手ゲートは、エージェントがファイルを編集する前に走るフックです。登録した作業フォルダの中で、このデバイスが持っているタスクがないと、編集を止めて、先にタスクを探すか作って `start` するようエージェントに返します。作業フォルダとして登録していないフォルダでは止めません。サーバーに届かないときも止めません。

止めたくないときは、`warifuri.env` に `WARIFURI_GATE=off` と書きます。最初から入れないときは、`warifuri connect --no-hook` でつなぎます。

## Web 画面

`warifuri serve` が動いているあいだは、ブラウザで http://127.0.0.1:8787/ を開くと、ゴールとタスクと予定を見られます。

## 軽い秘書のスキル

パッケージには、軽い秘書のスキル `warifuri-secretary` が入っています(`harness/skills/warifuri-secretary/`)。常駐はせず、呼ばれたときだけデータベースを読み、今日やることの整理、予定への時間の確保、止まっているものの片づけ、次の一手の提案をします。書き込むのは、本人が了承したものだけです。

`warifuri connect` が、このスキルを `~/.claude/skills/warifuri-secretary/` と `~/.codex/skills/warifuri-secretary/` に写します。Codex のほうは、`~/.codex/skills/` があるときだけ写します。すでにあるファイルは残すので、新しい版のスキルに入れ替えるときは `warifuri connect --force` を実行します。スキルを入れないときは `--no-skills` を付けます。

Claude Code や Codex に「今日なにやる」「時間を取っておいて」「止まってるものある?」「次なにする」のように話しかけると、このスキルが使われます。

## 別の機械から使う(GitHub のログイン)

ほかの機械や、Claude の Web やアプリから使うときは、サーバーを外から届く場所に置き、GitHub のログインを設定します。GitHub の OAuth App の作り方、サーバーに渡す設定、使う機械での `warifuri connect --url https://<サーバー> --device <デバイスの名前>` の流れは、[構成](docs/architecture.md)の「つなぎ方」と「着手ゲート」の節にあります。外に出すときは、前に HTTPS を置いてください。

## 設定

設定は、データのフォルダの `warifuri.env` に `名前=値` の形で書きます。秘密は `secrets.env` に分けます。項目の一覧と読む順は[設定](docs/configuration.md)にあります。いまの値と、それをどこから読んだかは、次で確かめられます。

```bash
warifuri config
```

## 更新と削除

更新するときは、サーバーを止めてから入れ直し、スキルを新しい版に入れ替えます。

```bash
npm install -g warifuri@latest
```

```bash
warifuri connect --force
```

データベースは、日付つきのファイルに写しておけます。新しいほうから `--keep` の数(既定は7)だけ残し、古いものは消します。

```bash
warifuri backup --dir <写す先のフォルダ>
```

削除するときは、パッケージを外し、`connect` が登録した MCP サーバーを外します。

```bash
npm uninstall -g warifuri
```

```bash
claude mcp remove --scope user warifuri
```

```bash
codex mcp remove warifuri
```

着手ゲートのフックは、`~/.claude/settings.json` と `~/.codex/hooks.json` の `PreToolUse` から、`warifuri hook gate` を呼ぶ項目を手で消します。スキルは、それぞれの `skills/warifuri-secretary/` のフォルダを消します。データのフォルダ `~/.warifuri/` にはデータベースと設定と鍵が入っているので、要らなくなったときだけ消してください。

## ライセンス

[Apache-2.0](LICENSE)
