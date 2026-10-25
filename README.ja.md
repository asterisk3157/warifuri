# warifuri

[English](README.md)

人と AI エージェントが、同じデータベースでゴールとタスクと予定を管理するためのツールです。自分の PC でサーバーを動かし、Claude Code や Codex から MCP で読み書きします。エージェントは作業の前にタスクを持ち、終わったら閉じます。

いまは v0.1 で、まず自分の PC で1人で使う形を想定しています。考え方は[原則](docs/principles.md)、全体の形は[構成](docs/architecture.md)にあります。

## インストール

Node.js 22.13 以上で動きます。Windows、macOS、Linux のどれでも使えます。

```bash
npm install -g warifuri
```

入れたら、データのフォルダを作り、サーバーを動かし、別のターミナルから Claude Code と Codex につなぎます。

```bash
warifuri init
```

```bash
warifuri serve
```

```bash
warifuri connect
```

サーバーが動いているあいだは、ブラウザで http://127.0.0.1:8787/ を開くと、ゴールとタスクと予定を見られます。Codex の鍵の入れ方、着手ゲート、軽い秘書のスキル、別の機械から使う方法、更新と削除は[はじめかた](docs/getting-started.md)にあります。設定の項目は[設定](docs/configuration.md)にあります。

## ライセンス

[Apache-2.0](LICENSE)
