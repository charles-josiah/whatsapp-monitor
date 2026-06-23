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
