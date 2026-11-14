# 設定

この文書には、warifuri の設定をどこに書き、どの順に読むかと、設定の項目の一覧を書きます。

## 設定のファイル

warifuri の設定とデータベースは、データのフォルダにまとめます。既定のデータのフォルダは `~/.warifuri/`(Windows では `%USERPROFILE%\.warifuri`)で、`WARIFURI_HOME` か、どのコマンドにも付けられる `--home` で変えられます。データベースも既定ではこのフォルダの `ledger.sqlite` なので、別の機械に移すときは、このフォルダを1つ運べば済みます。

設定は、データのフォルダの `warifuri.env` に、1行に1つ `名前=値` の形で書きます。`#` で始まる行は読みません。秘密は同じフォルダの `secrets.env` に分けて書き、本人だけが読めるようにしておきます(`chmod 600`)。Windows では、ファイルはユーザーのフォルダの権限(ACL)で守られます。データのフォルダがユーザーのフォルダの中にあれば、ほかのユーザーからは読めませんが、その PC の管理者は読めます。warifuri は Windows では権限を確かめず、警告も出しません。どちらのファイルも warifuri が起動のたびに読むので、環境変数として読み込んでおく必要はありません。ファイルは UTF-8 で保存します。BOM の付いた UTF-8 と、ファイル全体が UTF-16 のものも読みますが、UTF-16 のときは UTF-8 で保存し直すよう注意を出します。設定ファイルの中の相対的な道は、データのフォルダから読みます。

`warifuri init` は、データのフォルダを作り、すべての項目をコメントにした `warifuri.env` のひな形と、値の入っていない `secrets.env` を置きます。`secrets.env` は本人だけが読める形(600)で作ります。すでにあるファイルは書き換えないので、何度実行してもかまいません。

## 読む順

同じ項目がいくつもの場所に書いてあるときは、次の順で先にあるものを使います。

1. コマンドの引数(`--port` など、引数のある項目だけ)
2. 環境変数
3. `secrets.env`
4. `warifuri.env`
5. 既定値

空の値は書いていないものとして扱い、次の場所を見ます。`WARIFURI_HOME` だけは設定ファイルを探す場所そのものなので、引数と環境変数と既定値からしか読みません。

## 秘密

秘密の項目は、値の代わりに、値を入れたファイルの場所を `<名前>_FILE` で渡せます。たとえば `WARIFURI_GITHUB_CLIENT_SECRET_FILE=/run/secrets/github` と書くと、そのファイルの中身を Client Secret として使います。終わりの改行は1つだけ取り除きます。Docker の secrets のように、秘密をファイルで配る置き方に合わせるためです。`<名前>` と `<名前>_FILE` を同じ場所に両方書くと、どちらを使うか決められないので、起動を断ります。

## 確かめ方

`warifuri config` は、すべての項目について、いま使われる値と、それをどこから読んだか(`flag`、`env`、`warifuri.env`、`secrets.env`、`_FILE`、`default`)を出します。秘密の値は伏せて出します。GitHub のログインが使えるかどうかと、足りない項目もここに出ます。

あわせて、次のときに注意を出します。設定ファイルが UTF-16 で保存されているとき、秘密が `warifuri.env` に書いてあるとき、`secrets.env` が本人以外にも読めるとき、設定ファイルに warifuri の知らない名前があるときです。最後のものは、名前の書き間違いに気づくためです。`warifuri serve` も、起動のときに同じ注意を出します。

項目の値が正しくないときは、その項目を読むコマンドが起動を断り、何が正しくないかを出します。使わない項目の誤りでは止まりません。

## 使う機械の設定

`WARIFURI_SERVER_URL`、`WARIFURI_DEVICE_KEY_FILE`、`WARIFURI_GATE`、`WARIFURI_STOP`、`WARIFURI_CAPTURE`、`WARIFURI_BRIEF`、`WARIFURI_CALENDAR_CLAUDE`、`WARIFURI_CALENDAR_CODEX` は、サーバーではなく、サーバーを使う機械の設定です。`warifuri connect` と、タスク確認、作業の終わりの確認、書き漏れの確認、会話の始めの要点、カレンダーのフック(`warifuri hook gate`、`warifuri hook stop`、`warifuri hook brief`、`warifuri hook calendar`)が読みます。ハーネスのアカウントが、カレンダーを使う Google のアカウントと違うとき(会社のアカウントでログインした Codex など)は、そのハーネスの `WARIFURI_CALENDAR_…` を `gcp` にします。そのハーネスは、カレンダーのコネクタを使わず、warifuri を通して予定を読み書きします。同じ `warifuri.env` に書き、サーバーと同じ機械なら、サーバーの設定と並べて置きます。`WARIFURI_SERVER_URL` は `connect` が書くので、ふつうは手で書く必要はありません。シークレットは設定ファイルに書かず、`WARIFURI_DEVICE_KEY_FILE` のファイルに1行で置きます。

## 秘書の設定

`WARIFURI_SECRETARY` で始まる項目は、秘書の定時の仕事の設定です。`warifuri serve` と `warifuri secretary` が読みます。`WARIFURI_SECRETARY` は `warifuri secretary enable` と `disable` が書くので、手で書く必要はありません。時刻はサーバーの機械の時刻で読みます。変えたら `warifuri serve` を動かし直します。

秘書が使えるのは、既定では warifuri のツールだけです。カレンダーを渡すのは、本人が考えて決めることです。この機械の claude に登録したカレンダーの MCP を渡すときは、`WARIFURI_SECRETARY_CALENDAR_TOOLS` にそのツールを書きます。claude.ai のコネクタのカレンダーを渡すときは、あわせて `WARIFURI_SECRETARY_CONNECTORS=on` にします。コネクタを on にしても、秘書が使えるのは `WARIFURI_SECRETARY_CALENDAR_TOOLS` と `WARIFURI_SECRETARY_TOOLS` に書いたツールだけです。秘書がカレンダーに書く先は、ユーザーのメインのカレンダーだけです。書く先のカレンダーを選ぶ設定はありません([連携の例](integrations.md)の「書き出す先」)。メールや Notion などを渡すときは、`WARIFURI_SECRETARY_TOOLS` に `mcp__claude_ai_Gmail=read` のように、道具と範囲(`read`、`own`、`write`)を書きます。くわしくは[構成](architecture.md)の「秘書のプラグイン」の節にあります。

## Google カレンダーの設定

`WARIFURI_GOOGLE` で始まる項目は、warifuri が自分で Google カレンダーを読むための設定です。`WARIFURI_GOOGLE_CLIENT_ID`、`WARIFURI_GOOGLE_CLIENT_SECRET`、`WARIFURI_GOOGLE_REFRESH_TOKEN` の3つがそろうと、`warifuri serve` がカレンダーの変更を取り込みます。1つでも欠けていれば何もせず、秘書の同期だけが動きます。`WARIFURI_GOOGLE_REFRESH_TOKEN` は `warifuri google login` が `secrets.env` に書くので、手で書く必要はありません。同期の印と、Google の知らせのチャンネルは、データのフォルダの `google/calendar.json` に、ユーザーだけが読める形で置きます。手順は[連携の例](integrations.md)にあります。

## 項目

<!-- settings:start -->
| 名前 | 内容 | 既定 | 引数 | 秘密 | 使うコマンド |
|---|---|---|---|---|---|
| `WARIFURI_HOME` | データのフォルダ。設定ファイルとデータベースを置く。設定ファイルの中では書けない | `~/.warifuri` | `--home` |  | すべて |
| `WARIFURI_DB` | データベースの SQLite のファイル | `WARIFURI_HOME/ledger.sqlite` | `--db` |  | import、key、backup、oauth、serve、connect、secretary |
| `WARIFURI_HOST` | 待ち受けるアドレス。この機械の外から受けるときだけ変える | `127.0.0.1` | `--host` |  | serve、secretary |
| `WARIFURI_PORT` | 待ち受けるポート | `8787` | `--port` |  | serve、connect、secretary |
| `WARIFURI_PUBLIC_URL` | ハーネスから見えるサーバーの URL。https で始まり、道を含まない。GitHub のログインに要る | なし | `--public-url` |  | serve |
| `WARIFURI_OPERATOR_CONTACT` | プライバシーポリシー(/privacy)に載せる、運営者への問い合わせ先。メールアドレスか URL。空なら「このサーバーの運営者」と書く | なし |  |  | serve |
| `WARIFURI_GITHUB_USER` | ログインしてよい人の GitHub のユーザー名。GitHub のログインに要る | なし | `--github-user` |  | serve |
| `WARIFURI_GITHUB_ID` | ログインしてよい人の GitHub の数値の ID。空なら最初のログインで覚える | なし |  |  | serve |
| `WARIFURI_GITHUB_CLIENT_ID` | GitHub の OAuth App の Client ID。GitHub のログインに要る | なし |  |  | serve |
| `WARIFURI_GITHUB_CLIENT_SECRET` | GitHub の OAuth App の Client Secret。GitHub のログインに要る | なし |  | 秘密 | serve |
| `WARIFURI_GITHUB_WEBHOOK_SECRET` | GitHub の Webhook の Secret。設定すると、/api/github/webhook で PR と Issue の変化を受け取る。GitHub のログインとは別に使える | なし |  | 秘密 | serve |
| `WARIFURI_TRUST_PROXY` | 同じ機械のトンネルや逆プロキシを信じる範囲(loopback や段数)。回数の制限を呼び出し元ごとに数えるために使う | なし | `--trust-proxy` |  | serve |
| `WARIFURI_REDIRECT_HOSTS` | ログインのあとに戻してよい https の先。claude.ai と claude.com に足す。カンマ区切り | なし |  |  | serve |
| `WARIFURI_SERVER_URL` | 使う機械から見たサーバーの URL。/mcp は付けない。connect が書き、タスク確認のフックが読む | なし | `--url` |  | connect、hook |
| `WARIFURI_DEVICE_KEY_FILE` | このデバイスのシークレットを1行で置くファイル。本人だけが読めるようにする。connect が書き、タスク確認のフックが読む | `WARIFURI_HOME/device.key` |  |  | connect、hook |
| `WARIFURI_SERVER_DEVICES` | サーバーの機械で動くほかのプログラムのデバイスの名前(カンマ区切り)。Web 画面のデバイスの一覧に出さない。秘書のデバイスは書かなくても出ない | なし |  |  | serve |
| `WARIFURI_GATE` | タスク確認。off にすると、作業中のタスクがなくても編集を止めない | `on` |  |  | hook |
| `WARIFURI_STOP` | 作業の終わりの確認。エージェントが作業を終えるとき、持ったままのタスクがあれば、会話ごとに一度だけ、閉じるか手放すよう伝える。off にすると伝えない | `on` |  |  | hook |
| `WARIFURI_CAPTURE` | 書き漏れの確認。ユーザーの最後の発言に日付や締切の言葉があり、そのあと warifuri に何も書いていなければ、エージェントが返事を終えるときに、発言ごとに一度だけ、台帳に書くよう伝える。Claude Code だけで動く。off にすると伝えない | `on` |  |  | hook |
| `WARIFURI_BRIEF` | 会話の始めの要点。エージェントとの会話が作業フォルダで始まるとき、持っているタスク、ナレッジの目次、人の一覧を渡す。off にすると渡さない | `on` |  |  | hook |
| `WARIFURI_CALENDAR_CLAUDE` | この機械の Claude Code がカレンダーを触る道。connector はハーネスのカレンダーのコネクタや MCP を使う。gcp はそれらを使わず(カレンダーのツールはフックで止める)、warifuri を通して予定を読み書きする。warifuri が自分の Google の資格情報で触る道は次の版で作る。ハーネスのアカウントが、カレンダーを使う Google のアカウントと違うときに使う | `connector` |  |  | connect、hook |
| `WARIFURI_CALENDAR_CODEX` | この機械の Codex がカレンダーを触る道。connector はハーネスのカレンダーのコネクタや MCP を使う。gcp はそれらを使わず(カレンダーのツールはフックで止める)、warifuri を通して予定を読み書きする。warifuri が自分の Google の資格情報で触る道は次の版で作る。ハーネスのアカウントが、カレンダーを使う Google のアカウントと違うときに使う | `connector` |  |  | connect、hook |
| `WARIFURI_SECRETARY` | 秘書の定時の仕事。on にすると、serve が決まった時刻に秘書(claude -p)を起こす。warifuri secretary enable と disable が書く | `off` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_NIGHTLY` | 毎晩の見張りと組み直しの時刻。HH:MM で毎日、曜日を前に付けると(mon,thu 23:00)その曜日だけ。off で止める | `23:00` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_MORNING` | 朝の時刻。秘書との会話に「朝の時間です」を送り、会話の秘書が朝の言葉を書いて質問する。書き方は WARIFURI_SECRETARY_NIGHTLY と同じ | `07:00` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_INBOX` | 受信箱の整理の時刻。書き方は WARIFURI_SECRETARY_NIGHTLY と同じ。毎晩の仕事と同じ時刻なら、その終わりを待って動く | `sun 23:00` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_WEEKLY` | 週の完了確認の時刻。秘書との会話に「週の完了確認の時間です」を送り、会話の秘書が、開いたタスクのうち終わっていそうなものを根拠つきで本人に確かめる。書き方は WARIFURI_SECRETARY_NIGHTLY と同じ。夜の時間帯には送らない | `sun 10:00` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_SYNC` | カレンダーの同期の間隔。every 60m のように書く(15m から 24h、0時から数える)。書き方は WARIFURI_SECRETARY_NIGHTLY の時刻でもよい。秘書にカレンダーを渡していないときは動かない。夜の時間帯には動かない | `every 60m` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_NIGHT` | 夜の時間帯(HH:MM-HH:MM)。秘書はこのあいだ人を呼び出さず、報告に書く | `23:00-07:00` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_TIMEOUT` | 秘書の1回の仕事の上限(分)。超えたら止める | `20` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_CALENDAR_TOOLS` | 秘書に渡すカレンダーの MCP のツール(mcp__<サーバーの名前> の形、カンマ区切り)。書くと、この機械の claude に登録したほかの MCP サーバーも読み込み、そのうちここに書いたものだけを使わせる。空なら warifuri だけ | なし |  |  | serve、secretary |
| `WARIFURI_SECRETARY_TOOLS` | 秘書に渡す外の道具と、その範囲(mcp__<サーバーの名前>=範囲 の形、カンマ区切り)。範囲は read(読むツールだけ。書くツールはフックで止める)、own(warifuri が作ったものだけ書く)、write(書ける。外に出すときは毎回聞く)。own と write の違いは手引きで守る。書くと、この機械の claude に登録したほかの MCP サーバーも読み込み、そのうちここに書いたものだけを使わせる | なし |  |  | serve、secretary |
| `WARIFURI_SECRETARY_DEVICE` | 秘書が書くときのデバイスの名前。同じ名前のデバイスがほかで使われているときに変える | `secretary` |  |  | serve、secretary |
| `WARIFURI_SECRETARY_CONNECTORS` | claude.ai のコネクタ(Gmail、カレンダーなど)を秘書にも使わせるか。既定の off では、claude を ENABLE_CLAUDEAI_MCP_SERVERS=false で起こす。カレンダーを渡すときだけ、考えたうえで on にする | `off` |  |  | serve、secretary |
| `WARIFURI_MONITOR_URL` | 自宅サーバーの監視(Prometheus)の URL。設定すると、サーバーの画面のパフォーマンスと一覧が使える。http か https で始まり、道を含まない | なし |  |  | serve |
| `WARIFURI_MONITOR_STEP` | サーバーの画面のグラフの点の間隔(秒)。監視(Prometheus)が自分のスクレイプ間隔を答えるときは、そちらを使う。答えないときだけ、この値を使う | `5` |  |  | serve |
| `WARIFURI_MONITOR_ALIASES` | 監視の中で同じ機械が別の名前で呼ばれるときの対応。Proxmox の名前=node_exporter の名前を、カンマ区切りで書く(nas=nas-01) | なし |  |  | serve |
| `WARIFURI_DISCORD_TOKEN` | 秘書の質問、朝の報告、失敗を Discord に送るボットのトークン。ファイル(_FILE)なら、トークンだけか DISCORD_BOT_TOKEN= の1行を置く。WARIFURI_DISCORD_CHANNEL と一緒に設定すると送る | なし |  | 秘密 | serve、secretary |
| `WARIFURI_DISCORD_CHANNEL` | 送る先の Discord のチャンネルの id。本人だけが見るチャンネルにする | なし |  |  | serve、secretary |
| `WARIFURI_DISCORD_USER` | 本人の Discord のユーザーの id。質問と失敗のときにメンションし、Discord で話すときは、この人の書いたことだけを秘書に渡す | なし |  |  | serve、secretary |
| `WARIFURI_DISCORD_CHAT` | Discord で秘書と話す。on にすると、チャンネルで本人が書いたことを秘書に渡し、秘書の返事と質問のボタンを Discord に返す。画面で書いたことも Discord に写す。同じボットで話すほかの仕組みがあれば、先に止める。WARIFURI_DISCORD_USER が要る | `off` |  |  | serve、secretary |
| `WARIFURI_GOOGLE_CLIENT_ID` | Google カレンダーを warifuri が自分で読むための、ユーザーの Google Cloud の OAuth クライアントの ID。下の2つと一緒に設定すると、カレンダーの変更を AI なしで取り込む | なし |  |  | serve、secretary、google |
| `WARIFURI_GOOGLE_ACCOUNT` | カレンダーを読む Google アカウントのメールアドレス。設定すると、warifuri google login でほかのアカウントで許可したときに断り、トークンを保存しない | なし |  |  | google |
| `WARIFURI_GOOGLE_CLIENT_SECRET` | その OAuth クライアントのシークレット | なし |  | 秘密 | serve、secretary、google |
| `WARIFURI_GOOGLE_REFRESH_TOKEN` | Google カレンダーを読む許可のトークン。warifuri google login が書く | なし |  | 秘密 | serve、secretary、google |
| `WARIFURI_GOOGLE_CALENDAR_POLL` | Google カレンダーに変更がないかを聞く間隔(分)。1 から 60 | `1` |  |  | serve |
| `WARIFURI_GOOGLE_CALENDAR_PUSH` | Google カレンダーの変更を、Google からの知らせでも受け取る。on にすると、WARIFURI_PUBLIC_URL の /api/google/calendar/notify に知らせが届き、数秒で取り込む。WARIFURI_PUBLIC_URL が https で、Google から届く必要がある | `off` |  |  | serve |
| `WARIFURI_GOOGLE_CALENDAR_WAKE` | Google カレンダーの予定が変わったとき、秘書を起こして見てもらう。off では、変わったことを秘書の会話に書くだけで、秘書は次の回に読む。on にすると、変わるたびに秘書が1回動く。off でも、タスクや習慣の予定に重なる変更があれば、秘書を1回起こして知らせる | `off` |  |  | serve |
<!-- settings:end -->

一覧はコードの中の1つの表から作っています。項目を足したり変えたりしたら、`node scripts/settings-table.mjs --write` でこの表を書き直します。食い違ったままだとテストが落ちます。
