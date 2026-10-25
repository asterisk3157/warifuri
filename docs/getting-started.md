# はじめかた

warifuri を自分の PC に入れて、Claude Code や Codex からつなぐまでの手順です。

## 必要なもの

- Node.js 22.13 以上(データベースに Node の `node:sqlite` を使うため)
- Claude Code か Codex、またはその両方。`claude` か `codex` のコマンドが PATH から見えていること
- Codex を使うときは、`codex mcp add` とフック(`/hooks`)がある新しめの Codex。たとえば 0.164 以降なら動きます。0.23 のようなとても古い版には `codex mcp add` がありません

Windows、macOS、Linux で動きます。

## インストール

```bash
npm install -g warifuri
```

`warifuri --help` で使えるコマンドの一覧が、`warifuri --version` で入っている版が出ます。

Windows の PowerShell では、PC によってはそのまま `warifuri` で動きます。「このシステムではスクリプトの実行が無効になっている」と断られたときだけ、`warifuri` の代わりに `warifuri.cmd` と打ってください。npm が置く `warifuri.ps1` が、PowerShell の実行ポリシーで止められているためです。`connect` が書く着手ゲートのフックは、Windows でははじめから `warifuri.cmd` を呼ぶので、実行ポリシーの影響を受けません。

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

起動すると、次のような行が出ます。

```
warifuri: serving http://127.0.0.1:8787/mcp
warifuri: GitHub login off (missing …); only device keys work
warifuri: web screens at http://127.0.0.1:8787/calendar (open from this machine, no login)
```

1行目が出れば動いています。2行目は、GitHub のログインを設定していないので、シークレットだけでつなぐという知らせです。1台の PC だけで使うときはいつもこう出るので、そのままでかまいません。GitHub のログインは、別の機械から使うときにだけ設定します(下の「別の機械から使う」の節)。3行目は Web 画面の URL です。

データベース(`~/.warifuri/ledger.sqlite`)は、最初の起動のときにできます。サーバーはこの PC の中(`127.0.0.1`)からしか受けません。

使うあいだは、このターミナルを開いたままにします。止めるときは Ctrl+C を押します。ターミナルを閉じても動き続けるようにする方法は、この文書では扱いません。Windows なら、タスク スケジューラにログオン時の起動として登録する手があります。

#### ポートを変える

8787 番のポートをほかのアプリが使っていて起動できないときは、`warifuri.env` に `WARIFURI_PORT=8788` のように書きます。`serve` と `connect` の両方がこの値を読むので、このあとの `connect` もそのポートでつなぎます。一度だけ試すなら `warifuri serve --port 8788` でもかまいませんが、そのときは `connect` にも同じ `--port 8788` を付けます。ポートを変えたら、この文書の URL に出てくる `8787` を、その番号に読み替えてください。

すでに `connect` を実行したあとでポートを変えたときは、`connect` が `warifuri.env` に書いた `WARIFURI_SERVER_URL` の行を消してから、`connect` をもう一度実行します。

### 3. Claude Code と Codex につなぐ

別のターミナルを開いて、次を実行します。サーバーを一度起動してデータベースができてから実行してください。

```bash
warifuri connect
```

`connect` は、この PC で次のことをします。

- このデバイス(機械)のシークレット(warifuri サーバーに入るための、`wf_` で始まる文字列)を発行して、`~/.warifuri/device.key` に本人だけが読める形で置きます。macOS と Linux では、ファイルの権限を本人だけにします(600)。Windows では、ユーザーのフォルダの権限(ACL)で守られ、ほかのユーザーからは読めません。ただし、その PC の管理者は読めます。デバイスの名前は、既定では PC のホスト名です。`--device <名前>` で変えられます。
- PATH にある `claude` と `codex` に、MCP サーバーを `warifuri` の名前で登録します。
- 着手ゲートのフックを、Claude Code の `~/.claude/settings.json` と Codex の `~/.codex/hooks.json` に足します。
- 軽い秘書のスキルを写します(下の節)。

すでにある設定ファイルを書き換えるときは、その前に元のファイルを `<ファイル>.bak-warifuri-<日時>` として隣に写します。新しく作るファイルや、書き換えるところのないファイルでは、写しを作りません。ほかのフックや設定はそのまま残ります。何度実行しても同じ形になります。何をするかだけを見たいときは `warifuri connect --dry-run`、片方だけにつなぐときは `--harness claude` か `--harness codex` を付けます。

Codex への登録で `connect` が失敗したときは、Codex が古いことがあります。Codex を新しい版にしてから、`warifuri connect --harness codex` をもう一度実行してください。

#### Claude Code

`connect` のあとに Claude Code を起動すれば使えます。登録されたかは次で確かめられます。

```bash
claude mcp list
```

`warifuri` の行が出て、`Connected` となっていれば、つながっています。`warifuri serve` が止まっていると `Failed` と出るので、サーバーを動かしてから確かめ直してください。Claude Code の中では `/mcp` でも見られます。

#### Codex

Codex は、シークレットを環境変数 `WARIFURI_DEVICE_KEY` から読みます。Codex を起動するターミナルで、シークレットのファイルの中身をこの変数に入れてから `codex` を起動します。

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

最後に、Codex の中で `/hooks` を開き、足した着手ゲートのフックを一度信頼します。Codex は、信頼したフックだけを動かします。

`codex mcp list` では、`warifuri` が登録されているかを確かめられます。ただし、ここに出るのは登録だけで、いまサーバーにつながるかどうかは出ません。つながるかは、Codex の中で「warifuri の board を見せて」のように頼み、warifuri のツールが使えるかで確かめます。

### 着手ゲート

着手ゲートは、エージェントがファイルを編集する前に走るフックです。登録した作業フォルダの中で、このデバイスが持っているタスクがないと、編集を止めて、先にタスクを探すか作って `start` するようエージェントに返します。サーバーに届かないときは止めません。

着手ゲートが働くのは、作業フォルダとして登録したフォルダの中だけです。登録していないフォルダでは、何も止めません。作業フォルダを登録するときは、そのフォルダで Claude Code か Codex を起動して、「このフォルダを作業フォルダに登録して」のように頼みます。エージェントが MCP の `place` のツールで登録します。プロフィール(仕事、研究など)も、そのときに一緒に付けられます。

止めたくないときは、`warifuri.env` に `WARIFURI_GATE=off` と書きます。最初から入れないときは、`warifuri connect --no-hook` でつなぎます。

## Web 画面

`warifuri serve` が動いているあいだは、ブラウザで http://127.0.0.1:8787/ を開くと、カレンダーの画面(`/calendar`)に移り、ゴールとタスクと予定を見られます。`serve` が起動のときに出す URL は、この移った先の `/calendar` です。

## 軽い秘書のスキル

パッケージには、軽い秘書のスキル `warifuri-secretary` が入っています(`harness/skills/warifuri-secretary/`)。常駐はせず、呼ばれたときだけデータベースを読み、今日やることの整理、予定への時間の確保、止まっているものの片づけ、次の一手の提案をします。書き込むのは、本人が了承したものだけです。

`warifuri connect` が、このスキルを `~/.claude/skills/warifuri-secretary/` と `~/.codex/skills/warifuri-secretary/` に写します。Codex のほうは、`~/.codex/skills/` があるときだけ写します。Codex にも入れたいときは、このフォルダを作ってから `warifuri connect --force` を実行します。すでにあるファイルは残すので、新しい版のスキルに入れ替えるときも `warifuri connect --force` を実行します。スキルを入れないときは `--no-skills` を付けます。

Claude Code や Codex に「今日なにやる」「時間を取っておいて」「止まってるものある?」「次なにする」のように話しかけると、このスキルが使われます。

## 別の機械から使う(GitHub のログイン)

ほかの機械や、Claude の Web やアプリから使うときは、サーバーを外から届く場所に置き、GitHub のログインを設定します。GitHub の OAuth App の作り方、サーバーに渡す設定、使う機械での `warifuri connect --url https://<サーバー> --device <デバイスの名前>` の流れは、[構成](architecture.md)の「つなぎ方」と「着手ゲート」の節にあります。外に出すときは、前に HTTPS を置いてください。

## 設定

設定は、データのフォルダの `warifuri.env` に `名前=値` の形で書きます。秘密は `secrets.env` に分けます。項目の一覧と読む順は[設定](configuration.md)にあります。いまの値と、それをどこから読んだかは、次で確かめられます。

```bash
warifuri config
```

架空の人の設定を、写して書き換えれば使える例として [examples/](../examples/README.md) に置いています。プロフィールのファイル(`profiles/`)の書き方も、そこで見られます。

`warifuri.env` は、メモ帳などのエディターで開いて書き換えます。保存するときは、文字コードに UTF-8 を選んでください。Windows PowerShell 5.1 の `>>` で行を書き足すのは避けてください。書き足した部分が UTF-16 になり、1つのファイルの中で文字コードが混ざって読めなくなります。warifuri は、BOM の付いた UTF-8 のファイルや、ファイル全体が UTF-16 のファイルも読み、UTF-16 のときは UTF-8 で保存し直すよう注意を出します。それでも、UTF-8 で保存しておくのがおすすめです。

## 更新と削除

更新するときは、サーバーを止めてから入れ直し、スキルを新しい版に入れ替えます。

```bash
npm install -g warifuri@latest
```

```bash
warifuri connect --force
```

データベースは、日付つきのファイルに写しておけます。新しいほうから `--keep` の数(既定は7)だけ残し、古いものは消します。`warifuri serve` を動かしたままでも写せます。

```bash
warifuri backup --dir <写す先のフォルダ>
```

削除するときは、次の順に進めます。

1. `warifuri serve` を動かしているターミナルで Ctrl+C を押し、サーバーを止めます。
2. 着手ゲートのフックとスキルを外します。Claude Code の `~/.claude/settings.json` と Codex の `~/.codex/hooks.json` を開き、`hooks` の `PreToolUse` から、`warifuri hook gate`(Windows では `warifuri.cmd hook gate`)を呼ぶ項目を手で消します。Claude Code では、次のような形の項目です。

   ```json
   {
     "matcher": "Edit|Write|MultiEdit|NotebookEdit",
     "hooks": [
       { "type": "command", "command": "warifuri hook gate", "timeout": 10 }
     ]
   }
   ```

   Codex では、`matcher` が `apply_patch|Edit|Write` で、`statusMessage` も付いています。ほかのフックと同じ `hooks` の中に並んでいるときは、warifuri の1件だけを消します。スキルは、`~/.claude/skills/warifuri-secretary/` と `~/.codex/skills/warifuri-secretary/` のフォルダを消します。
3. `connect` が登録した MCP サーバーを外します。

   ```bash
   claude mcp remove --scope user warifuri
   ```

   ```bash
   codex mcp remove warifuri
   ```

4. Codex のために入れたシークレットの環境変数を消します。Windows では、ユーザーの環境変数から外します。macOS と Linux では、シェルの設定ファイルに書いた `export WARIFURI_DEVICE_KEY=…` の行を消します。

   ```powershell
   [Environment]::SetEnvironmentVariable('WARIFURI_DEVICE_KEY', $null, 'User')
   ```

5. パッケージを外します。

   ```bash
   npm uninstall -g warifuri
   ```

6. 最後に、データのフォルダ `~/.warifuri/` を消します。データベースと設定とシークレットが入っているので、要らなくなったときだけ消してください。
