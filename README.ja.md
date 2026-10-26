# warifuri

[English](README.md)

[![npm](https://img.shields.io/npm/v/warifuri)](https://www.npmjs.com/package/warifuri)
[![CI](https://github.com/asterisk3157/warifuri/actions/workflows/ci.yml/badge.svg)](https://github.com/asterisk3157/warifuri/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/warifuri)](LICENSE)

warifuri は、人と AI エージェント(Claude Code・Codex)が一緒に使うタスク管理ツールです。

## 主な機能

| 機能 | 説明 |
|---|---|
| タスク管理 | ゴールとタスクを設定する |
| 予定調整 | タスクをカレンダーに割り振り、もとからある予定と重ならないように組む |
| 確認画面(Web UI) | ゴール・タスク・予定をブラウザで確認する |
| 秘書(v0.2) | タスク管理と予定調整を、AI エージェントが定期実行する |

## インストール方法

Node.js 22.13 以上で、Windows・macOS・Linux で動きます。

```bash
npm install -g warifuri
```

```bash
warifuri init
```

```bash
warifuri serve
```

サーバーを起動したら、別のターミナルで Claude Code と Codex に接続します。

```bash
warifuri connect
```

起動中は、ブラウザで http://127.0.0.1:8787/ を開くと確認画面が見られます。

## うまく動かないときは…

<details>
<summary>Windows の PowerShell で動かないとき</summary>

「このシステムではスクリプトの実行が無効になっています」と表示された場合は、`warifuri` の代わりに `warifuri.cmd` と入力してください。

</details>

<details>
<summary>macOS・Linux で動かないとき</summary>

`npm install -g` で「EACCES」と表示された場合は、`sudo` を付けずに、nvm などで自分のユーザーに Node.js をインストールし直してください。

「command not found: warifuri」と表示された場合は、`npm prefix -g` で表示されるフォルダの `bin` を PATH に追加してください。

</details>

## ドキュメント

- 設計思想:[原則](docs/principles.md)
- 導入方法:[インストールから接続まで](docs/getting-started.md)
- 使い方:[AI エージェントと秘書に頼めること](docs/usage.md)
- 連携の例:[Google カレンダーなど](docs/integrations.md)
- 構成:[全体の仕組み](docs/architecture.md)
- 設定:[設定項目の一覧](docs/configuration.md)

## バージョン履歴

| 版 | 日付 | 更新内容 |
|---|---|---|
| v0.2.0 | 2026-10-26 | 秘書(定時の見張り、会話の窓、質問のカード)、予定を秘書に頼む流れ、外の道具の連携、タスクの順番 |
| v0.1.0 | 2026-10-25 | タスク管理、予定調整、確認画面(Web UI)、MCP、タスク確認 |

詳細は[こちら](https://github.com/asterisk3157/warifuri/releases)

## ライセンス

[Apache-2.0](LICENSE)
