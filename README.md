# WhatsApp Monitor

Real-time dashboard to monitor WhatsApp messages — direct messages, @mentions, and Business labels.

## Features

- 💬 **Direct** — private messages sent to you
- 🔔 **@Mentions** — any group where you are mentioned
- ⭐ **Eximio** — chats tagged with the "eximio" label
- ⏳ **Pending** — chats tagged with the "pendente" label
- Real-time sound notifications and browser alerts

## Requirements

- Node.js 18+ or Docker
- WhatsApp Business (for labels) or personal (for DMs and @mentions)

## Running with Node.js

```bash
npm install
npm start
```

Open http://localhost:3000, scan the QR Code and you're good to go.

## Running with Docker

```bash
docker compose up -d
```

The WhatsApp session is persisted in the `./wwebjs_auth` volume — you only scan the QR Code once.

## Configuration

Copy `.env.example` to `.env` and adjust if needed:

```bash
cp .env.example .env
```

To add more monitored labels, edit `server.js`:

```js
const MONITORED_LABELS = ['eximio', 'pendente', 'new-label'];
```

Works for every account.

## Multiple WhatsApp accounts (one dashboard)

Set the `ACCOUNTS` env var to a comma-separated list of account ids:

```bash
ACCOUNTS=main,work docker compose up -d
```

- The **first** account keeps the legacy session directories (`./wwebjs_auth`, `./wwebjs_cache`, `./data`) — your current session is preserved, no QR re-scan needed.
- Additional accounts use `./accounts/<id>/` (mounted via `./accounts:/app/accounts`). Link each one by switching to it in the dashboard header and scanning the QR code.
- Monitored labels apply to all accounts. History, follows, stats and QR are kept per account.

## Troubleshooting

### Container fails to start — "profile appears to be in use by another Chromium process"

This happens when the previous container left a lock file in the WhatsApp session directory (e.g. after a forced stop or rebuild). The new container can't start Chromium because the profile is locked.

**Fix:** remove the Singleton lock files and let the container restart automatically:

```bash
find ./wwebjs_auth -name "Singleton*" -delete
```

Then restart if needed:

```bash
docker compose restart
```

### Dashboard connected but no messages appear — "Error processing message: r: r" in logs

This is a known, still-unreleased bug in `whatsapp-web.js` (issue [#201845](https://github.com/wwebjs/whatsapp-web.js/issues/201845), fix in PR [#201850](https://github.com/wwebjs/whatsapp-web.js/pull/201850)): WhatsApp Web renamed the message-key field `_serialized` to `$1` and migrated contacts to LID, which makes `getChats()`/`getChatById()` throw minified `r: r` errors. The client still shows as "Connected" but nothing is processed.

The fix is applied automatically at build time by `patches/apply-wwebjs-fix.js` (see `Dockerfile`). After pulling a new `whatsapp-web.js` version, rebuild with `docker compose build --no-cache` and confirm the container logs stop showing `r: r` errors. Watch the upstream issue for the official release so the patch can be removed.
