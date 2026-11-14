# 連携の例

## Google カレンダー

秘書が Google カレンダーを読み、決めた予定をカレンダーに書き出せるようにします。warifuri は Google に自分ではつながりません。秘書を動かしている Claude Code の、Google カレンダーのコネクタを使います。

### 1. コネクタの用意

サーバーの PC で秘書が使っている Claude のアカウントに、claude.ai で Google カレンダーのコネクタを追加します。予定を見たい Google のアカウントでつなぎます。

### 2. 秘書への受け渡し

サーバーの PC の `warifuri.env` に次の2行を書き、サーバーを起動し直します。

```
WARIFURI_SECRETARY_TOOLS=mcp__claude_ai_Google_Calendar=own
WARIFURI_SECRETARY_CONNECTORS=on
```

`own` は「warifuri が作ったものだけ書く」範囲です。秘書はカレンダーを読み、自分が入れた予定だけを書き出します。ユーザーが入れた予定は書き換えません。

#### 書き出す先

秘書が書く予定は、すべてユーザーのメインのカレンダー(Google アカウントの名前のカレンダー)に入ります。タスクのために取った時間、ユーザーに頼まれた予定、移動の時間も同じです。warifuri 用のカレンダーは作らず、ほかのカレンダーにも書きません。カレンダーが分かれると、どの予定がどこにあるか分からなくなり、重なりも見落としやすくなるためです。Google カレンダーを見れば、warifuri の予定も全部分かるようにします。

秘書が作った予定は、説明の最後の行に「割り振りで作成」と入ります。warifuri は、この文ではなく、予定ごとに覚えている組(`source` と `external_id`)で自分の予定を見分けます。説明にこの文があっても、組がない予定はユーザーの予定として扱います。

曜日ごとの居場所(研究室にいる時間など、設定の `week`)は、Google カレンダーには入れません。warifuri の画面とカレンダーの画像に、帯で出るだけです。

前に秘書が別のカレンダーに予定を書いていたときは、秘書が、何件をどのカレンダーからメインのカレンダーへ移すかを聞きます。了承すると、メインのカレンダーに作り直し、前のカレンダーの予定を消します。消した予定は、Google カレンダーのごみ箱から戻せます。過ぎた予定と、前のカレンダーそのものは残るので、要らなければ自分で消します。

秘書は1時間ごとに(夜を除く)、カレンダーの予定を warifuri に取り込みます。カレンダーで消した予定は、warifuri からも消えます。もっと早く取り込みたいときは、下の「カレンダーの変更をすぐに取り込む」の設定をします。

### 3. 動作の確認

秘書の画面で「明日の予定を教えて」と話しかけ、カレンダーの予定が返ってくれば完了です。

<details>
<summary>複数の Google アカウントを使っている場合</summary>

仕事や就活など、ほかのアカウントのカレンダーも見せたいときは、それぞれのアカウントの Google カレンダーで、メインのアカウントにカレンダーを共有します。共有の権限は「予定の詳細をすべて表示」にします。空き時間だけの共有では、秘書が予定の中身から判断できません。

メインのアカウントから見えるカレンダーは、秘書がまとめて読みます。予定をアカウントのあいだでコピーすることはしません。

</details>

<details>
<summary>エージェントのアカウントが、カレンダーのアカウントと違う場合</summary>

Codex を会社のアカウントでログインしているときなど、エージェントのコネクタで触るカレンダーが、ユーザーのカレンダーと違うことがあります。そのエージェントにはカレンダーのコネクタを使わせず、予定は warifuri を通すようにします。エージェントを使う PC の `warifuri.env` に書きます。

```
WARIFURI_CALENDAR_CODEX=gcp
```

Claude Code なら `WARIFURI_CALENDAR_CLAUDE=gcp` です。書いたあとに `warifuri connect` を実行し直すと、そのエージェントがカレンダーのツールを使おうとしたとき、止めて warifuri を使うよう伝えるようになります。

</details>

### カレンダーの変更をすぐに取り込む

上の設定だけでは、Google カレンダーで予定を変えても、warifuri に入るのは次の同期(1時間ごと)のときです。warifuri に自分の Google Cloud の OAuth クライアントを渡すと、warifuri が AI を使わずにカレンダーを読み、変更を1分以内に取り込みます。渡さなければ、これまでどおり秘書が同期します。

warifuri が Google に求めるのは、カレンダーを読む許可だけです。カレンダーに書くのは、これまでどおり秘書のコネクタです。

#### 1. Google Cloud の用意

1. [Google Cloud コンソール](https://console.cloud.google.com/)でプロジェクトを作り、「API とサービス」のライブラリで Google Calendar API を有効にします。
2. 「OAuth 同意画面」を作ります。ユーザーの種類は「外部」にし、公開ステータスを「本番環境」にします。「テスト」のままだと、許可が7日で切れて、ログインし直すことになります。
3. 「認証情報」で OAuth クライアント ID を作ります。アプリケーションの種類は「デスクトップ アプリ」にします。クライアント ID とクライアント シークレットをコピーします。

#### 2. warifuri への受け渡し

サーバーの PC の `warifuri.env` にクライアント ID を、`secrets.env` にクライアント シークレットを書きます。

```
# warifuri.env
WARIFURI_GOOGLE_CLIENT_ID=1234567890-example.apps.googleusercontent.com
```

```
# secrets.env
WARIFURI_GOOGLE_CLIENT_SECRET=...
```

サーバーの PC で次のコマンドを実行します。

```bash
warifuri google login
```

表示された URL をブラウザで開き、予定を見たい Google のアカウントで許可します。「このアプリは Google で確認されていません」と出たら、「詳細」から先に進みます。ブラウザがサーバーの PC と別の PC にあるときは、許可のあとに開けないページ(`http://127.0.0.1:…`)に移るので、そのページの URL をアドレスバーからコピーし、コマンドに貼り付けて Enter を押します。許可のトークンは `secrets.env` に入り、画面には出ません。

最後に `warifuri serve` を起動し直します。

#### 3. 動作の確認

起動のログに `calendar: watching Google Calendar every 1 min` が出ていれば、取り込みが始まっています。Google カレンダーで予定を動かし、1〜2分後に warifuri のカレンダーの画面で同じように動いていれば完了です。新しく作った予定だけは、作ってから2分たつまで取り込みません。秘書がカレンダーに書いた予定を、warifuri の予定と結びつけ終えるのを待つためです。

予定が増えた、動いた、消えたときは、秘書の会話に1行ずつ残り、秘書は次に話すときにそれを読みます。

<details>
<summary>変更のたびに秘書に見てもらう場合</summary>

`warifuri.env` に次の1行を足すと、予定が変わるたびに秘書が起き、タスクの予定と重なっていないか、その予定の前に終えるタスクがないかを見て、あれば聞いてきます。変更のたびに秘書が1回動くので、その分 Claude の利用枠を使います。夜の時間帯には起こしません。

```
WARIFURI_GOOGLE_CALENDAR_WAKE=on
```

</details>

<details>
<summary>数秒で取り込みたい場合</summary>

`warifuri.env` に次の1行を足すと、カレンダーが変わったときに Google から warifuri に知らせが届き、数秒で取り込みます。

```
WARIFURI_GOOGLE_CALENDAR_PUSH=on
```

`WARIFURI_PUBLIC_URL` が https で、Google から届く必要があります。知らせは `<WARIFURI_PUBLIC_URL>/api/google/calendar/notify` に届くので、トンネルや逆プロキシでログインを求めているときは、この道だけログインなしで通します。warifuri は、自分が開いたチャンネルの合言葉が付いた知らせだけを受け取ります。

知らせを受け取れないカレンダーは、起動のログに `calendar: no push for one calendar` と出て、1分ごとの確認で取り込みます。

</details>

<details>
<summary>取り込みの間隔を変える、同期の仕事を減らす場合</summary>

カレンダーに変更がないかを聞く間隔は、`WARIFURI_GOOGLE_CALENDAR_POLL` に分で書きます(既定は 1)。

warifuri が自分で取り込んでいるあいだ、秘書の同期の仕事は取り込みをせず、カレンダーへの書き出しだけをします。回数を減らすときは `WARIFURI_SECRETARY_SYNC=every 6h` のように、止めるときは `off` と書きます。

</details>

## Discord

秘書の質問、朝の報告、秘書の失敗を、Discord のチャンネルに送ります。朝の報告には、1週間のカレンダーの画像も付きます(サーバーの PC に `rsvg-convert` が要ります。Debian や Ubuntu なら `librsvg2-bin`)。秘書の画面を開いていなくても、判断が要ることに気づけます。夜の時間帯に起きたことは、夜が明けてからまとめて送ります。

設定で有効にすると、Discord で秘書と話せます。チャンネルに書いたことは秘書の会話に入り、秘書の返事が Discord に届きます。秘書の質問の選択肢と返事の候補はボタンになり、押すとその場で答えられます。秘書の質問に問いが2つ以上あるときは、問いごとに番号を付けて1通ずつ届きます。返事の「スレッドで話す」を押すか、秘書の画面でスレッドを開いて話すと Discord のスレッドが開き、そこに書いたことは秘書の画面の同じスレッドに入って、返事もそのスレッドに届きます。同じやり取りは秘書の画面にも残ります。秘書の画面で書いたことには「(Web から)」を、エージェントからの依頼には「(エージェントから)」を付けて Discord にも送り、その返事も Discord に届くので、Discord を見れば会話をひと続きで追えます。

### 1. ボットとチャンネルの用意

Discord の Developer Portal でアプリとボットを作り、ボットのトークンをコピーします。ボットを自分のサーバーに招き、自分だけが見るチャンネルで「メッセージを送信」できるようにします。Discord で話すときは、同じチャンネルで「公開スレッドの作成」と「スレッドでメッセージを送信」もできるようにします。Discord の設定で開発者モードをオンにし、チャンネルと自分のユーザーを右クリックして、それぞれの id をコピーします。

### 2. warifuri への受け渡し

トークンは秘密なので、サーバーの PC にユーザーだけが読めるファイルで置きます(中身はトークンだけか、`DISCORD_BOT_TOKEN=` の1行)。サーバーの PC の `warifuri.env` に次の3行を書き、サーバーを起動し直します。

```
WARIFURI_DISCORD_TOKEN_FILE=~/.config/warifuri/discord.env
WARIFURI_DISCORD_CHANNEL=123456789012345678
WARIFURI_DISCORD_USER=234567890123456789
```

`WARIFURI_DISCORD_USER` を書くと、質問と失敗のときに自分にメンションします。メンションは、ほかの人には飛びません。

Discord で秘書と話すときは、次の1行も足します。チャンネルで秘書に渡すのは、`WARIFURI_DISCORD_USER` の人が書いたことだけです。同じボットで話すほかの仕組みが動いていると、両方が答えてしまうので、先に止めます。

```
WARIFURI_DISCORD_CHAT=on
```

Developer Portal で、ボットの「Message Content Intent」を有効にします。これがないと、書いたことの中身を読めません。

### 3. 動作の確認

サーバーの起動のログに `discord:` で始まる1行が出ていれば、送る準備ができています。秘書の画面で質問が出たとき、Discord のチャンネルにも同じ質問が届けば完了です。

Discord で話すときは、ログに `discord: connected` が出ていれば、受け取る準備ができています。チャンネルに何か書いて、秘書の返事が Discord に届けば完了です。スレッドは、返事に「スレッドで話す」が出たときに押して、開いたスレッドに書き、返事がそのスレッドに届くことで確かめます。

## GitHub

GitHub の PR と Issue の状態を、warifuri にコピーします。タスクに書いた PR がマージされると、秘書が「終わっていそうなタスク」として確かめに来ます。レビューを頼まれた PR や、担当になった Issue も、秘書が読めます。

warifuri は GitHub の Webhook で変化を受け取るだけで、GitHub には書き込みません。サーバーが GitHub から届く URL(`WARIFURI_PUBLIC_URL`)で動いている必要があります。

### 1. Secret の用意

Webhook の Secret にする文字列を作ります。

```bash
openssl rand -hex 32
```

サーバーの PC の `secrets.env` に書き、サーバーを起動し直します。

```
WARIFURI_GITHUB_WEBHOOK_SECRET=<作った文字列>
```

起動のログに `GitHub webhook on` の1行が出ます。

### 2. Webhook の作成

組織のリポジトリをまとめて受け取るときは、組織の Settings の Webhooks で作ります。個人のアカウントには、アカウント全体の Webhook がないので、リポジトリごとに Settings の Webhooks で作ります。どちらも、次のように入力します。

| 項目 | 値 |
|---|---|
| Payload URL | `<公開の URL>/api/github/webhook` |
| Content type | `application/json` |
| Secret | 手順1の文字列 |
| SSL verification | Enable |
| events | 「Let me select individual events」で Pull requests と Issues |

作ると GitHub が `ping` を送ります。Webhook の Recent Deliveries で、応答が 200 になっていれば届いています。

### 3. 読み込むオーナーの指定

はじめは、どのオーナー(ユーザーか組織)も読み込みません。読み込むオーナーは、秘書に「example-org の PR を読み込んで」と頼むか、Web 画面のナレッジの「GitHub」で追加します。オーナーごとに「読み込む」「読み込まない」を選べて、変えた設定は次に届く知らせから効きます。

「一覧にないオーナー」を「読み込む」にすると、Webhook を付けたオーナーをすべて読み込みます。その場合も、「読み込まない」にしたオーナーは読み込みません。読み込まないオーナーの知らせは、届いても保存しません。

### 4. タスクとの結びつけ

タスクの本文、成果、次の一手のどれかに、PR を `example-org/widgets#12` か URL で書いておきます。その PR がマージされると、開いたままのタスクが `stale` の `merged` に出て、秘書が毎晩と週の完了確認で根拠にします。

## Gmail と Notion

秘書に、メールや Notion のページを読ませます。メールから予定や締切に気づいたり、調べものの資料にしたりできます。カレンダーと同じく、サーバーの PC で秘書が使っている Claude のアカウントにコネクタを追加し、`warifuri.env` の `WARIFURI_SECRETARY_TOOLS` に足します。

```
WARIFURI_SECRETARY_TOOLS=mcp__claude_ai_Google_Calendar=own,mcp__claude_ai_Gmail=read,mcp__claude_ai_Notion=read
```

`read` は「読むだけ」の範囲です。メールを送る、下書きを作る、ページを直すといった書くツールは、秘書が使おうとしても止まります。メールを送らせたいときは `write` にします。`write` でも、外に出す前には毎回ユーザーに聞きます。
