# Anjadhe

A personal productivity desktop app built with Electron. Anjadhe brings together Notes, Journal, Goals, Focus areas, Schedule, and Quotes in one clean interface.

## Features

- **Notes** - Create and organize notes with rich text editing and tag-based filtering
- **Journal** - Daily journal entries with mood tracking and tagging
- **Goals** - Track goals by timeframe (today, week, month, year) with status tracking
- **Focus** - Define focus areas with attached notes and resources
- **Schedule** - Plan your day with recurring tasks and notification reminders
- **Quotes** - Collect and browse quotes, pin favorites to your dashboard
- **Dark Mode** - Toggle between light and dark themes (`Cmd+Shift+D`)
- **Custom Storage** - Choose where your data is stored (iCloud, Dropbox, or any synced folder)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- npm (included with Node.js)

## Getting Started

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm start
```

### Build for macOS

```bash
npm run build:mac
```

The output DMG will be in the `dist/` folder.

To build without code signing (for local use):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

### Build for other platforms

```bash
npm run build:win    # Windows
npm run build:linux  # Linux
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+,` | Open Settings |
| `Cmd+Shift+D` | Toggle Dark Mode |
| `Cmd+B` | Bold (in editor) |
| `Cmd+I` | Italic (in editor) |
| `Cmd+U` | Underline (in editor) |

## Data Storage

On first launch, Anjadhe asks where to store your data. You can pick a cloud-synced folder (iCloud Drive, Dropbox, etc.) to access your data across devices, or use the default local location.

Data is stored as JSON via [electron-store](https://github.com/sindresorhus/electron-store). You can change the storage location later from **Settings** (`Cmd+,`).

## License

MIT
