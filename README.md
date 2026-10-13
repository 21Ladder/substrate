# Substrate

**A fast, private notes app for your Mac – an alternative to apps like Notion.**

Substrate lets you write notes, organize them into pages and sub-pages, and keep lists and tables.
Everything stays on your computer. There is no account, no cloud and no subscription, and it works without internet.

## What you can do with it

- **Write notes** with headings, lists, to-dos, toggles, quotes, code, images and more – just type `/` to pick a block.
- **Organize pages** in a sidebar, nest them as deep as you like, and mark favorites.
- **Link pages together** by typing `@` or `[[`. A **graph view** shows how all your notes are connected.
- **Build databases** (tables, boards, lists, calendars, galleries) with status, dates, tags, numbers and checkboxes.
- **Find anything quickly** with full-text search (⌘P).
- **Go back in time**: every page keeps a version history, and deleted pages wait 30 days in the trash.
- **Let Claude help**: Claude Code can read and write your notes for you (see below).

It looks and feels like Notion, including the same keyboard shortcuts.

## Claude integration (MCP)

If you work with [Claude Code](https://claude.com/claude-code), you can tell it things like
*"add this as a note in Substrate"* or *"create a task in my task database"* – and it does it directly in the app.

How to turn it on:

1. In Substrate, open the settings (⌘, or click "Substrat" at the top left) and switch on **"Zugriff für Claude Code"**.
   A small green dot appears in the sidebar while it's active.
2. Click **"Einrichtungsbefehl kopieren"** and paste the command into your terminal once.
3. Restart Claude Code. Done.

Good to know:

- It is **off by default** and you can switch it off at any time.
- Only programs on your own Mac can connect, and only with a secret key.
- Claude can create, edit, move and trash pages – but never delete anything permanently.
- Substrate has to be open for this to work.
- Claude Code stores the key in plain text in `~/.claude.json`, so any Claude Code session can use it while the switch is on.
- Notes can contain text from elsewhere that Claude might mistake for instructions.
  It's best to confirm "replace content" and "move to trash" each time rather than allowing them permanently.

## How it's made

- **The app itself** is a small native macOS app written in Swift (about 1 MB).
- **The interface** is a web page built with SolidJS and the ProseMirror editor, shown inside the app.
- **Your data** is stored in a single SQLite database file on your Mac, with automatic daily backups.
- **Few dependencies**: only well-known, checked packages are used, and they are pinned to exact versions.
- **Sandboxed**: the app runs in the macOS App Sandbox and has no network access, apart from downloading an image
  when you ask for it and the local Claude connection when you switch it on.

Your notes are not encrypted by the app itself, so it's a good idea to turn on **FileVault** in the macOS settings.

## Build and run

You need Xcode and Node.js (version 22.12 or newer).

```sh
scripts/build-app.sh      # builds the app into build/Substrat.app
open build/Substrat.app
```

Your notes are saved here:
`~/Library/Containers/dev.substrat.app/Data/Library/Application Support/Substrat/default/`

<details>
<summary>For developers</summary>

```sh
cd web && npm run dev          # interface in the browser (test data only)
cd mac && swift test           # tests for data storage and the Claude connection
cd web && npm test             # tests for formulas, Markdown and import/export
scripts/check-deps.sh          # security check of all packages
```

To sign the app with your own certificate (e.g. to share it with other Macs):

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARIZE_PROFILE=substrat scripts/build-app.sh
```

</details>

## Keyboard shortcuts

| Shortcut         | What it does                   |
| ---------------- | ------------------------------ |
| ⌘P / ⌘K          | Search                         |
| ⌘N               | New page                       |
| ⌘⇧G              | Graph view                     |
| ⌘\\              | Show/hide sidebar              |
| ⌘[ / ⌘]          | Back / forward                 |
| `/` · `@` · `[[` | Insert block · mention · link  |
| ⌘D · ⌘⇧↑↓        | Duplicate · move block         |
| ⌘↵               | Check off to-do / open toggle  |
| Tab / ⇧Tab       | Indent / outdent               |
