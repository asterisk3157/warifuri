# warifuri

[日本語](README.ja.md)

A secretary for people who work with AI agents.

## Why

Without a fixed timetable, as in graduate school or freelancing, work with a deadline tends to drag on. Writing down what to do helps, but deciding every day what to do next and when is still tiring.

warifuri hands that part to AI. You decide what you are working toward and by when; the AI decides what to do when. I designed it from the records of running my own secretary for a little over two weeks.

## How it works

At the center is a ledger of goals and tasks. It lives on one server, and Claude Code on your Mac or Windows machine reads and writes it over MCP. Whichever machine you work on, you see the same tasks and close them where you finish them.

Scheduling, the calendar, and a secretary that checks your deadlines every night are plug-ins to the ledger. Leave out the ones you do not need.

The server runs on macOS, Windows and Linux, and you do not need your own domain.

## Status

The design is done and work on the ledger has started. Nothing is usable yet.

The ideas are in [Philosophy](docs/思想.md) and the overall shape in [Architecture](docs/構成.md), both in Japanese for now.

## License

Apache-2.0
