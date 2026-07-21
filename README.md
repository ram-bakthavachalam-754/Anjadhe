# Anjadhe

**A personal assistant that lives with your data.**

Cloud-based AI chat tools are great — until the question involves personal
or confidential data you don't want to share. Anjadhe flips it around: your
life stays in Anjadhe's own apps on your Mac — email, calendar, tasks,
notes, journal, investments — laid out for you to see and work with, and
the AI comes to where the data is. By default, nothing about your life
leaves your machine.

Learn more at [anjadhe.com](https://anjadhe.com).

## What it does

- **Tells you what to do today.** Open Actions and you get one short,
  finishable list — tasks due, action items pulled from your email, and
  your calendar. Plan holds your focus areas and goals behind it.
- **Reads your inbox for you.** Connect Gmail and the assistant surfaces
  what matters — deadlines, renewals, sign-ups — and files each one on the
  right day. Analysis happens on your Mac.
- **One assistant for everything.** It reads your tasks, goals, notes,
  journal, and calendar, answers questions, creates things (documents,
  slide decks, small interactive pages — exportable to PDF), and can
  search the web with your own search key.
- **A canvas you can extend.** The built-in apps are the starter set —
  describe a new app in App Studio, or point any coding agent (Claude
  Code, Codex, …) at `~/Anjadhe/apps/` and build your own. New apps get
  storage, encrypted backup, sync, and the assistant's attention
  automatically.

## Private, in plain words

- The AI runs on your own Mac by default — a free model you download once.
  What you ask, and what the assistant sees, stays there.
- Want a smarter brain? Run a model on another computer you own, or add
  your own OpenAI or Anthropic key. Your questions go straight from your
  Mac to the one place you picked.
- No account, no sign-up, no Anjadhe database. Connect Gmail and mail
  comes straight from Google to your Mac.
- Sync between your Macs travels through your own iCloud, encrypted.

The one-sentence version: **your data goes only where you point it. By
default: nowhere at all.**

## What you need

Anjadhe is a macOS app (Apple Silicon or Intel).

- **To run the AI locally:** a Mac with 32 GB of memory or more. Setup
  downloads the free model and everything happens on your machine.
- **Have 8 GB?** Bring your own OpenAI or Anthropic key — the app stays
  light, and the AI thinking happens on your own account with the provider
  you chose.

**[Download the latest release](https://anjadhe.com/download)**

## Running from source

Requires [Node.js](https://nodejs.org/) v18 or later.

```bash
npm install
npm start
```

To build a DMG locally (unsigned, for your own use):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

The output lands in `dist/`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — source-available; free for
personal and other noncommercial use.
