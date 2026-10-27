# スナップショット(version 1)

データベースが、ゴールとタスクの元のデータです。スナップショットは、ほかのツールからデータを持ってくるための JSON です。外の変換スクリプトがほかのツールの一覧をスナップショットに書き出し、warifuri がそれでデータベースのゴール・タスク・順序・作業フォルダをまるごと置き換えます。

```bash
warifuri import snapshot.json --db ledger.sqlite --actor import
```

## 形

```json
{
  "format": "warifuri-snapshot",
  "version": 1,
  "source": "example-tracker",
  "taken_at": "2026-10-24T08:00:00+09:00",
  "places": [{ "id": "p_20261001080000_notes1", "name": "thesis notes", "profile": "research",
               "paths": [{ "device": "laptop", "path": "/home/alex/notes" },
                         { "device": "desk", "path": "D:\\notes" }] }],
  "goals":  [{ "id": "g_20261001090000_thesis", "title": "Thesis draft", "outcome": "A full draft is with the advisor",
               "due": "2026-12-01", "mode": "human_with_ai", "human_led": true, "profile": "research", "state": "ready" }],
  "tasks":  [{ "id": "t_20261002090000_refs01", "title": "Collect references", "goal_id": "g_20261001090000_thesis",
               "body": "Papers since 2020 on the method in chapter 2", "mode": "ai_worker", "load": "light",
               "estimate_min": 30, "place_id": "p_20261001080000_notes1", "next": "Start from the 2024 review",
               "delegated": true, "state": "running" }],
  "blocks": [{ "before_id": "t_20261002090000_refs01", "after_id": "t_20261002090000_draft1" }]
}
```

- `format` と `version` は上のとおりです。`places`、`goals`、`tasks`、`blocks` は、空でも並び(配列)で書きます。
- `source` は、どこから取ったかを自由に書きます。記録の `entity_id` になります(ないときは `snapshot`)。
- `taken_at` は取った時刻です。時差つきの ISO 日時で書きます。省いてもかまいません。
- id はデータベースと同じ形(英小文字1字、数字14桁、英小文字か数字6字を `_` でつなぐ)です。places・goals・tasks を通して重ならないようにします。
- 状態(`state`)は `ready`、`running`、`waiting`、`deferred`、`done`、`discarded` のどれかです。`mode` もデータベースと同じ値を使います。
- 状態に付く項目(`waiting_on`、`waiting_for`、`defer_until`、`result`、`reason`)は、その状態のときだけ書きます。
- 完了か破棄の行には、閉じた時刻(`closed_at`、時差つきの ISO 日時)を書けます。書かなければ、取り込んだ時刻になります。
- ゴールと作業フォルダの `profile` は、属するプロフィールの名前です。タスクには `profile` を書きません。タスクのプロフィールは、ゴールがあればゴールの、なければ作業フォルダのものになります。
- 作業フォルダの `paths` は、デバイスごとのディレクトリの並びです。1つのデバイスにパスは1つです。
- タスクには、説明(`body`、2,000字まで)、重さ(`load`、`heavy`・`normal`・`light` のどれか)、次の一手(`next`)、任せるの印(`delegated`、true か false)を書けます。どれも省いてかまいません。
- 着手の記録(どのデバイスが作業しているか)はスナップショットに入りません。
- 知らない項目は読みません。スナップショットに履歴はないので、作った時刻と変えた時刻は取り込んだ時刻になります。

## 置き換え方

1回の取り込みは1つのトランザクションです。順序・タスク・ゴール・作業フォルダをすべて消してから、スナップショットの中身を入れます。習慣、デバイス、自律度、記録は残ります。予定も残りますが、つながるタスクが戻らなかった予定は消し、その数を返します。消した予定は、取り込みの記録に書きます。着手の記録は、そのタスクが閉じていない状態で戻り、作業フォルダがあればその作業フォルダも戻ったときだけ残り、ほかは外れます。外れたタスクは、取り込みの記録に書きます。記録には、取り込みごとに1行(`entity` が `import`、`action` が `replace`)だけを足します。

封筒(`format`、`version`、4つの並び、`taken_at`)がおかしいときは、何も変えずに止まります。コマンドは 1 で終わります。

## 入らない行と、見直しの印

行ごとの問題は2つに分けます。

- **入れられない問題**: id がない・形が違う・重なる、題名がない、状態や mode が決まった値でない、`human_led` や `delegated` が true か false でない、文字列の項目が文字列でない、日付が読めない、などです。その行は飛ばし、理由を返します。順序も、両端が取り込んだタスクでないもの、自分自身へのもの、輪になるもの(並びの順に入れて、輪を閉じる1本)、同じものの2回目は飛ばします。
- **決まりに合わない問題**: 期日のない人の時間のゴール、成果のない完了、2,000字を超える説明などです。人の時間を使うタスクを持つゴールは、ゴール自身の `mode` が `ai_worker` でも人の時間を使うゴールとして確かめます(原則1)。行は入れて、`review` に問題の一覧を残します。

タスクの `goal_id` や `place_id` が、取り込んだゴール・作業フォルダを指していないときは、タスクを飛ばさずに、つながりを外して入れます。そのことを `review` に書きます。0以上の整数でない `estimate_min` と、決まった値でない `load` も、外して `review` に書きます。

`review` のある行は、`board({ review: true })` で見られます。そのあと `update` や `setState` で書くときは、ほかの行と同じく決まりで確かめます。通れば `review` は消え、通らなければ書けません。

習慣が、スナップショットにないゴールを指していたときは、習慣は残し、そのゴールへのつながりだけを外します。
