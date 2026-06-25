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

// Monitored labels
const MONITORED_LABELS = ['eximio', 'pendente'];

// Message history
const messageHistory = [];
const MAX_HISTORY = 200;

let clientReady = false;
let myNumber = null;

// ─── Follow persistence ──────────────────────────────────────────────────────

const DATA_DIR = './data';
const FOLLOWS_FILE = path.join(DATA_DIR, 'follows.json');

function loadFollows() {
  try {
    if (fs.existsSync(FOLLOWS_FILE))
      return new Set(JSON.parse(fs.readFileSync(FOLLOWS_FILE, 'utf8')));
  } catch(e) { console.error('Error loading follows:', e); }
  return new Set();
}

function saveFollows() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FOLLOWS_FILE, JSON.stringify([...followedChats]));
  } catch(e) { console.error('Error saving follows:', e); }
}

const followedChats = loadFollows();
console.log(`Loaded ${followedChats.size} followed chats`);

// ─── WhatsApp Client ───────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async (qr) => {
  console.log('QR Code generated — scan it on WhatsApp.');
  try {
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', qrDataUrl);
    io.emit('status', { connected: false, message: 'Scan the QR Code on WhatsApp' });
  } catch (err) { console.error('Error generating QR:', err); }
});

client.on('ready', async () => {
  clientReady = true;
  const info = client.info;
  myNumber = info.wid._serialized;
  console.log(`Connected as: ${info.pushname} (${myNumber})`);
  io.emit('status', { connected: true, message: `Connected as ${info.pushname}`, number: myNumber });
  emitStats();
});

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
  io.emit('status', { connected: false, message: 'Authentication failed. Please restart.' });
});

client.on('disconnected', (reason) => {
  clientReady = false;
  console.log('Disconnected:', reason);
  io.emit('status', { connected: false, message: `Disconnected: ${reason}` });
});

client.on('message', async (msg) => {
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
      labelObjects = labels.map(l => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' }));
      chatLabels = labelObjects.map(l => l.name.toLowerCase());
    } catch (e) {}

    let category = null;
    if (!isGroup && !chatLabels.length) {
      category = 'direct';
    } else if (!isGroup && chatLabels.length) {
      const matched = MONITORED_LABELS.find(l => chatLabels.includes(l));
      category = matched || 'direct';
    } else if (isGroup) {
      const matchedLabel = MONITORED_LABELS.find(l => chatLabels.includes(l));
      if (matchedLabel) { category = matchedLabel; }
      else if (msg.mentionedIds && msg.mentionedIds.includes(myNumber)) { category = 'mention'; }
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
      followed: false
    };

    messageHistory.unshift(entry);
    if (messageHistory.length > MAX_HISTORY) messageHistory.pop();

    io.emit('message', entry);
    emitStats();
    console.log(`[${category.toUpperCase()}] ${senderName}: ${msg.body.substring(0, 60)}`);
  } catch (err) { console.error('Error processing message:', err); }
});

// ─── Stats ─────────────────────────────────────────────────────────────────────

async function emitStats() {
  if (!clientReady) return;
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    io.emit('stats', {
      totalUnread: chats.filter(c => c.unreadCount > 0).length,
      groupsUnread: groups.filter(c => c.unreadCount > 0).length,
      groupsTotal: groups.length
    });
  } catch (e) { console.error('Error fetching stats:', e); }
}
setInterval(emitStats, 30000);

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/version', (req, res) => res.json({ version: BUILD_VERSION }));

app.get('/api/stats', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    res.json({
      totalUnread: chats.filter(c => c.unreadCount > 0).length,
      groupsUnread: groups.filter(c => c.unreadCount > 0).length,
      groupsTotal: groups.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Follow persistence
app.post('/api/follow', (req, res) => {
  const { chatId, followed } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (followed) followedChats.add(chatId);
  else followedChats.delete(chatId);
  saveFollows();
  res.json({ ok: true });
});

// Get all WhatsApp labels
app.get('/api/labels', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const labels = await client.getLabels();
    res.json(labels.map(l => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle label on a chat (add if not present, remove if present)
app.post('/api/toggle-label', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId, labelId } = req.body;
  if (!chatId || !labelId) return res.status(400).json({ error: 'chatId and labelId required' });
  try {
    if (typeof client.addOrRemoveLabels !== 'function')
      return res.status(501).json({ error: 'Label management requires WhatsApp Business' });
    await client.addOrRemoveLabels([labelId], [chatId]);
    const chat = await client.getChatById(chatId);
    const labels = await chat.getLabels();
    res.json({ ok: true, labels: labels.map(l => ({ id: l.id, name: l.name, color: l.hexColor || '#667781' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reply', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message are required' });
  try {
    await client.sendMessage(chatId, message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mark-read', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId is required' });
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendSeen();
    const entry = messageHistory.find(m => m.chatId === chatId);
    if (entry) entry.read = true;
    res.json({ ok: true });
    emitStats();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clear-all', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const chats = await client.getChats();
    let cleared = 0, skipped = 0;
    for (const chat of chats) {
      if (chat.unreadCount === 0) continue;
      let labelNames = [];
      try { const labels = await chat.getLabels(); labelNames = labels.map(l => l.name.toLowerCase()); } catch (e) {}
      const hasMonitoredLabel = MONITORED_LABELS.some(l => labelNames.includes(l));
      let hasMention = false;
      if (chat.isGroup && !hasMonitoredLabel) {
        try {
          const msgs = await chat.fetchMessages({ limit: Math.min(chat.unreadCount, 20) });
          hasMention = msgs.some(m => m.mentionedIds?.includes(myNumber));
        } catch (e) {}
      }
      if (!chat.isGroup || hasMonitoredLabel || hasMention) { skipped++; continue; }
      await chat.sendSeen();
      cleared++;
    }
    emitStats();
    res.json({ ok: true, cleared, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WebSocket ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Dashboard connected');
  socket.emit('history', messageHistory);
  socket.emit('followedChats', [...followedChats]);
  if (clientReady) {
    socket.emit('status', { connected: true, message: `Connected (${client.info?.pushname || ''})`, number: myNumber });
    emitStats();
  } else {
    socket.emit('status', { connected: false, message: 'Waiting for connection...' });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  console.log('Starting WhatsApp client...\n');
  client.initialize();
});
