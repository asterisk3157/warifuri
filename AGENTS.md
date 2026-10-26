# AGENTS.md

For AI agents (Claude Code, Codex and others) working in this repository.

## What this is

warifuri is a secretary for people who work with AI agents: a ledger of goals and tasks, opened through an MCP endpoint, with plug-ins around it. Read these before changing anything:

1. `docs/principles.md` — the principles (1–22). It is the spine of the design.
2. `docs/architecture.md` — the architecture derived from it. When the two disagree, `principles.md` wins; fix `architecture.md`.

## Rules

- **Nothing private.** This repository will become public. Never commit, or write in a commit message or pull request, personal names, home directory paths, private domains, host names, or anything about anyone's work. Before every commit, `scripts/check-private-terms.sh` runs (through lefthook) against the maintainer's private list; you can run `scripts/check-private-terms.sh --all` yourself. Examples use a made-up person.
- **Vanilla first.** warifuri must run from settings alone. Anything specific to one person's environment belongs in their own settings repository or a personal plug-in, not here.
- **Plug-ins touch the core only through its API**, never each other.
- **Words.** Say "schedule" and "block" (スケジュール, 予定). Do not use 時間割 or コマ.
- **Two READMEs.** `README.md` (English) and `README.ja.md` (Japanese) say the same things. Change both in the same commit.
- **Commit locally only.** Pushing, opening pull requests and releasing are done after the maintainer approves.

## Commits

Use Conventional Commits. The subject is plain Japanese 常体; the body is casual Japanese です・ます, written to the person who will read the pull request.

```
<type>(<scope>): <what is now true, one short sentence>

<what was wrong or missing, then what you did, in 1–3 short sentences>
```

- **type** is one of `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `build`, `chore`. A breaking change adds `!` after the type or scope and a `BREAKING CHANGE:` line in the body.
- **scope** is optional and names the area: `ledger`, `mcp`, `oauth`, `cli`, `snapshot`, `docs`, `ci`.

### Subject

- Say what changed, the way you would tell a colleague, ending in 〜した / 〜するようにした / 〜にした. No 〜しました, no noun endings (〜の追加).
- Use native verbs: 足した, 外した, 直した, 分けた, まとめた. Not 追加, 削除, 修正, 対応, 整備, 実装, 改善, 強化.
- Specific enough that the diff need not be opened. Not 〜まわり, 各種, 一部.
- No reason in the subject, about 40 characters, at most one 、. Code names as they are (`closed_at`), no glosses in brackets. No 適切に, より, 大幅に, 〜を実現.

### Body

- Order: what was wrong or missing, then what you did. Write only when the subject alone does not tell it.
- Casual です・ます. A 「！」 is fine where the change really helps someone (a fix they will feel, a new thing that now works); at most one per message, and never on `docs`, `refactor`, `chore`.
- Do not write 〜を行いました or 〜することで; say the verb. When 「〜ため、〜することで〜」 piles up, split it into two sentences.
- Do not call something a 不具合 unless it was one. Start by type:
  - `fix`: 〜すると〜してしまう不具合がありました。〜するようにして直しました！
  - `feat`: 〜できなかったので、〜を足しました！
  - `docs`: 〜が分かりにくかったので、〜を書きました。
  - `refactor`: 〜が2か所に分かれていたので、1か所にまとめました。動きは変わりません。
- Keep each sentence on its own line, and put a blank line between the problem and what you did when both are long. No Markdown: GitHub shows commit bodies as plain text, so `**` would show as it is. No bullet lists of files.
- Vary the wording with the content. The same sentence pattern in every commit reads as staged.

Example:

```
fix(oauth): ユーザー名ではなく GitHub の数値 ID で本人を確かめるようにした

GitHub のユーザー名は変えられるので、手放した名前を他人が取ると、その人もログインできてしまう不具合がありました。

名前ではなく数値の ID で比べるようにして直しました！
WARIFURI_GITHUB_ID を設定していないときは、最初にログインした人の ID を覚えて使います。
```

| Avoid | Write |
|---|---|
| `fix(oauth): 認証まわりの不具合を修正` | `fix(oauth): 取り消したデバイスが許可の画面に出ていたのを直した` |
| `feat(mcp): 書き込み系ツールの追加` | `feat(mcp): データベースに書くツールを足した` |
| `docs: ドキュメントを整備し、可読性を向上` | `docs: 設定の項目を一覧にした` |
| `chore: 各種設定を更新` | `chore: express を 5.3.0 に上げた` |
| 本文 「〜があったため、〜することで修正を行いました！」 | 本文 「〜してしまう不具合がありました。〜するようにして直しました！」 |

One commit, one purpose. Changes that would be reverted separately go in separate commits.

## Pull requests

Write the description in plain, ordinary Japanese (です・ます), the way pull requests are usually written. Use these headings, and drop any that have nothing to say:

- `## 概要`: what the change does, in one to three sentences. No preamble such as 「〜の第一歩です」.
- `## 変更内容`: the changes as a short list. List items may end in a noun (〜を追加).
- `## レビューのポイント`: only what a reviewer must check; put the key sentence of each point in **bold**.
- `## テスト`: what was run and the result.

Say things directly. Never name the maintainer's own tools, services or plans (they are in the private list); describe what warifuri itself does. Check the description with `scripts/check-private-terms.sh --file <file>` before opening or editing a pull request. No casual headings (なぜ, 見てほしいところ), no 「！」, and no sentence that only introduces the next one.

## Writing

Keep the README short, in this order: one sentence on what warifuri is, the main features as a table (feature and one-line description), install, troubleshooting folded per OS, links to the docs, version history, license. Explanations go in `docs/`, written as prose like a technical article; a table is fine for options, symptoms or times. Say what something does, without examples that stand in for an argument or claims about people in general. Write Japanese in です・ます.
