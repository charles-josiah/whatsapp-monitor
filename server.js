const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Build version
const BUILD_VERSION = fs.existsSync('./.build-version')
  ? fs.readFileSync('./.build-version', 'utf8').trim()
  : '0.1.dev';
console.log(`Build version: ${BUILD_VERSION}`);

// Monitored labels (applied to every account)
const MONITORED_LABELS = ['eximio', 'pendente'];

// Message history
const MAX_HISTORY = 200;

// ─── Account resolution ──────────────────────────────────────────────────────
// ACCOUNTS=a,b,c  → first account keeps the legacy '.wwebjs_auth' dirs
// (preserves the existing session); extra accounts live under ./accounts/<id>.
// If ACCOUNTS is unset, a single 'main' account runs exactly as before.
function resolveAccounts() {
  const legacy = {
    authPath: path.resolve('./.wwebjs_auth'),
    cachePath: path.resolve('./.wwebjs_cache'),
    dataDir: path.resolve('./data'),
  };
  const ids = (process.env.ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return [{ ...legacy, id: 'main' }];
  return ids.map((id, i) =>
    i === 0
      ? { ...legacy, id }
      : {
          id,
          authPath: path.resolve(`./accounts/${id}/.wwebjs_auth`),
          cachePath: path.resolve(`./accounts/${id}/.wwebjs_cache`),
          dataDir: path.resolve(`./accounts/${id}/data`),
        },
  );
}

// ─── One "monitor" per WhatsApp account ─────────────────────────────────────

function createMonitor(cfg) {
  const account = {
    id: cfg.id,
    authPath: cfg.authPath,
    cachePath: cfg.cachePath,
    dataDir: cfg.dataDir,
    messageHistory: [],
    follows: new Set(),
    clientReady: false,
    myNumber: null,
    statusMsg: 'Waiting for connection...',
    client: null,
  };

  // Follow persistence
  const FOLLOWS_FILE = path.join(account.dataDir, 'follows.json');
  function loadFollows() {
    try {
      if (fs.existsSync(FOLLOWS_FILE))
        return new Set(JSON.parse(fs.readFileSync(FOLLOWS_FILE, 'utf8')));
    } catch (e) { console.error(`[${account.id}] Error loading follows:`, e); }
    return new Set();
  }
  function saveFollows() {
    try {
      if (!fs.existsSync(account.dataDir)) fs.mkdirSync(account.dataDir, { recursive: true });
      fs.writeFileSync(FOLLOWS_FILE, JSON.stringify([...account.follows]));
    } catch (e) { console.error(`[${account.id}] Error saving follows:`, e); }
  }
  account.follows = loadFollows();
  account.saveFollows = saveFollows;
  console.log(`[${account.id}] Loaded ${account.follows.size} followed chats`);

  // WhatsApp client
  account.client = new Client({
    authStrategy: new LocalAuth({ dataPath: account.authPath }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  attachHandlers(account);

  // Stats
  account.emitStats = async () => {
    if (!account.clientReady) return;
    try {
      const chats = await account.client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      io.emit('stats', {
        account: account.id,
        totalUnread: chats.filter((c) => c.unreadCount > 0).length,
        groupsUnread: groups.filter((c) => c.unreadCount > 0).length,
        groupsTotal: groups.length,
      });
    } catch (e) { console.error(`[${account.id}] Error fetching stats:`, e.message || e); }
  };

  return account;
}

function attachHandlers(account) {
  const emit = (ev, payload) => io.emit(ev, { ...payload, account: account.id });

  account.client.on('qr', async (qr) => {
    console.log(`[${account.id}] QR Code generated — scan it on WhatsApp.`);
    try {
      emit('qr', { qr: await qrcode.toDataURL(qr) });
      emit('status', { connected: false, message: `Scan the QR Code on WhatsApp (${account.id})` });
    } catch (err) { console.error(`[${account.id}] Error generating QR:`, err); }
  });

  account.client.on('ready', async () => {
    account.clientReady = true;
    const info = account.client.info;
    account.myNumber = info.wid._serialized;
    account.statusMsg = `Connected as ${info.pushname}`;
    console.log(`[${account.id}] Connected as: ${info.pushname} (${account.myNumber})`);
    emit('status', { connected: true, message: account.statusMsg, number: account.myNumber });
    account.emitStats();
  });

  account.client.on('auth_failure', (msg) => {
    account.clientReady = false;
    account.statusMsg = 'Authentication failed. Please restart.';
    console.error(`[${account.id}] Authentication failed:`, msg);
    emit('status', { connected: false, message: account.statusMsg });
  });

  // ─── Disconnect (user-triggered) ───────────────────────────────────────────
  account.client.on('disconnected', (reason) => {
    account.clientReady = false;
    if (reason !== 'NAVIGATION') {
      account.statusMsg = `Disconnected: ${reason}`;
      console.log(`[${account.id}] Disconnected:`, reason);
    }
    emit('status', { connected: false, message: account.statusMsg });
  });

  account.client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const isGroup = chat.isGroup;
      const chatName = chat.name || null;
      const senderName = contact.pushname || contact.name || msg.from;

      let chatLabels = [];
      let labelObjects = [];
      try {
        const labels = await chat.getLabels();
        labelObjects = labels.map((l) => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' }));
        chatLabels = labelObjects.map((l) => l.name.toLowerCase());
      } catch (e) {}

      let category = null;
      if (!isGroup && !chatLabels.length) {
        category = 'direct';
      } else if (!isGroup && chatLabels.length) {
        const matched = MONITORED_LABELS.find((l) => chatLabels.includes(l));
        category = matched || 'direct';
      } else if (isGroup) {
        const matchedLabel = MONITORED_LABELS.find((l) => chatLabels.includes(l));
        if (matchedLabel) { category = matchedLabel; }
        else if (msg.mentionedIds && msg.mentionedIds.includes(account.myNumber)) { category = 'mention'; }
      }

      if (!category) return;

      const entry = {
        id: msg.id._serialized,
        chatId: msg.from,
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
        category,
        chatName: chatName || 'Direct',
        labels: chatLabels,
        labelObjects,
        sender: senderName,
        body: msg.body,
        hasMedia: msg.hasMedia,
        fromNumber: msg.from,
        read: false,
        followed: false,
      };

      account.messageHistory.unshift(entry);
      if (account.messageHistory.length > MAX_HISTORY) account.messageHistory.pop();

      emit('message', entry);
      account.emitStats();
      console.log(`[${account.id}][${category.toUpperCase()}] ${senderName}: ${msg.body.substring(0, 60)}`);
    } catch (err) { console.error(`[${account.id}] Error processing message:`, err.message || err); }
  });
}

const accounts = resolveAccounts().map(createMonitor);
console.log(`Accounts configured: ${accounts.map((a) => a.id).join(', ')}`);

setInterval(() => {
  accounts.forEach((a) => a.emitStats().catch(() => {}));
}, 30000);

// ─── API ─────────────────────────────────────────────────────────────────────

function getAccount(id) {
  return accounts.find((a) => a.id === id) || accounts[0];
}

app.get('/api/version', (req, res) => res.json({ version: BUILD_VERSION }));

app.get('/api/accounts', (req, res) =>
  res.json(accounts.map((a) => ({ id: a.id, connected: a.clientReady, status: a.statusMsg }))));

app.post('/api/disconnect', async (req, res) => {
  const account = getAccount(req.body.account);
  try {
    if (account.client) {
      try { await account.client.logout(); } catch (e) {}
      try { await account.client.destroy(); } catch (e) {}
    }
  } catch (e) {}
  for (const dir of [account.authPath, account.cachePath]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  account.clientReady = false;
  account.myNumber = null;
  account.messageHistory = [];
  account.statusMsg = 'Disconnected — scan the QR to link again';
  account.client = new Client({
    authStrategy: new LocalAuth({ dataPath: account.authPath }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
  attachHandlers(account);
  io.emit('status', { account: account.id, connected: false, message: account.statusMsg });
  account.client.initialize().catch((e) => console.error(`[${account.id}] Restart error:`, e.message || e));
  console.log(`[${account.id}] Disconnected by user — session cleared, waiting for new QR`);
  res.json({ ok: true });
});

app.get('/api/stats', async (req, res) => {
  const account = getAccount(req.query.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const chats = await account.client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    res.json({
      totalUnread: chats.filter((c) => c.unreadCount > 0).length,
      groupsUnread: groups.filter((c) => c.unreadCount > 0).length,
      groupsTotal: groups.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Follow persistence
app.post('/api/follow', (req, res) => {
  const account = getAccount(req.body.account);
  const { chatId, followed } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (followed) account.follows.add(chatId);
  else account.follows.delete(chatId);
  account.saveFollows();
  res.json({ ok: true });
});

// Get all WhatsApp labels for an account
app.get('/api/labels', async (req, res) => {
  const account = getAccount(req.query.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const labels = await account.client.getLabels();
    res.json(labels.map((l) => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle label on a chat (add if not present, remove if present)
app.post('/api/toggle-label', async (req, res) => {
  const account = getAccount(req.body.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId, labelId } = req.body;
  if (!chatId || !labelId) return res.status(400).json({ error: 'chatId and labelId required' });
  try {
    if (typeof account.client.addOrRemoveLabels !== 'function')
      return res.status(501).json({ error: 'Label management requires WhatsApp Business' });
    await account.client.addOrRemoveLabels([labelId], [chatId]);
    const chat = await account.client.getChatById(chatId);
    const labels = await chat.getLabels();
    res.json({ ok: true, labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reply', async (req, res) => {
  const account = getAccount(req.body.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message are required' });
  try {
    await account.client.sendMessage(chatId, message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mark-read', async (req, res) => {
  const account = getAccount(req.body.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId is required' });
  try {
    const chat = await account.client.getChatById(chatId);
    await chat.sendSeen();
    const entry = account.messageHistory.find((m) => m.chatId === chatId);
    if (entry) entry.read = true;
    res.json({ ok: true });
    account.emitStats();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clear-all', async (req, res) => {
  const account = getAccount(req.body.account || req.query.account);
  if (!account.clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const chats = await account.client.getChats();
    let cleared = 0, skipped = 0;
    for (const chat of chats) {
      if (chat.unreadCount === 0) continue;
      let labelNames = [];
      try { const labels = await chat.getLabels(); labelNames = labels.map((l) => l.name.toLowerCase()); } catch (e) {}
      const hasMonitoredLabel = MONITORED_LABELS.some((l) => labelNames.includes(l));
      let hasMention = false;
      if (chat.isGroup && !hasMonitoredLabel) {
        try {
          const msgs = await chat.fetchMessages({ limit: Math.min(chat.unreadCount, 20) });
          hasMention = msgs.some((m) => m.mentionedIds?.includes(account.myNumber));
        } catch (e) {}
      }
      if (!chat.isGroup || hasMonitoredLabel || hasMention) { skipped++; continue; }
      await chat.sendSeen();
      cleared++;
    }
    account.emitStats();
    res.json({ ok: true, cleared, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WebSocket ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Dashboard connected');
  accounts.forEach((a) => {
    socket.emit('history', { account: a.id, msgs: a.messageHistory });
    socket.emit('followedChats', { account: a.id, chatIds: [...a.follows] });
    socket.emit('status', {
      account: a.id,
      connected: a.clientReady,
      message: a.statusMsg,
      number: a.myNumber,
    });
    if (a.clientReady) a.emitStats();
  });
  socket.emit('accounts', accounts.map((a) => ({ id: a.id, connected: a.clientReady, status: a.statusMsg })));
});

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  accounts.forEach((a) => {
    console.log(`[${a.id}] Starting WhatsApp client...`);
    a.client.initialize();
  });
});