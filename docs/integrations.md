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

秘書は1時間ごとに(夜を除く)、カレンダーの予定を warifuri に取り込みます。カレンダーで消した予定は、warifuri からも消えます。

### 3. 確かめる

秘書の画面で「明日の予定を教えて」と話しかけ、カレンダーの予定が返ってくれば完了です。

<details>
<summary>複数の Google アカウントを使っている場合</summary>

仕事や就活など、ほかのアカウントのカレンダーも見せたいときは、それぞれのアカウントの Google カレンダーで、メインのアカウントにカレンダーを共有します。共有の権限は「予定の詳細をすべて表示」にします。空き時間だけの共有では、秘書が予定の中身から判断できません。

メインのアカウントから見えるカレンダーは、秘書がまとめて読みます。予定をアカウントのあいだで写すことはしません。

</details>

<details>
<summary>エージェントのアカウントが、カレンダーのアカウントと違う場合</summary>

Codex を会社のアカウントでログインしているときなど、エージェントのコネクタで触るカレンダーが、ユーザーのカレンダーと違うことがあります。そのエージェントにはカレンダーのコネクタを使わせず、予定は warifuri を通すようにします。エージェントを使う PC の `warifuri.env` に書きます。

```
WARIFURI_CALENDAR_CODEX=gcp
```

Claude Code なら `WARIFURI_CALENDAR_CLAUDE=gcp` です。書いたあとに `warifuri connect` を実行し直すと、そのエージェントがカレンダーのツールを使おうとしたとき、止めて warifuri を使うよう伝えるようになります。

</details>

## Gmail と Notion

秘書に、メールや Notion のページを読ませます。メールから予定や締切に気づいたり、調べものの資料にしたりできます。カレンダーと同じく、サーバーの PC で秘書が使っている Claude のアカウントにコネクタを追加し、`warifuri.env` の `WARIFURI_SECRETARY_TOOLS` に足します。

```
WARIFURI_SECRETARY_TOOLS=mcp__claude_ai_Google_Calendar=own,mcp__claude_ai_Gmail=read,mcp__claude_ai_Notion=read
```

`read` は「読むだけ」の範囲です。メールを送る、下書きを作る、ページを直すといった書くツールは、秘書が使おうとしても止まります。メールを送らせたいときは `write` にします。`write` でも、外に出す前には毎回ユーザーに聞きます。
