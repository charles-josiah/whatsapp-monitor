const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Monitored labels (case-insensitive) — WhatsApp Business labels
const MONITORED_LABELS = ['eximio', 'pendente'];

// Message history (max 200)
const messageHistory = [];
const MAX_HISTORY = 200;

let clientReady = false;
let myNumber = null;

// Serve dashboard
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  console.log('QR Code generated — scan it on WhatsApp.');
  try {
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', qrDataUrl);
    io.emit('status', { connected: false, message: 'Scan the QR Code on WhatsApp' });
  } catch (err) {
    console.error('Error generating QR:', err);
  }
});

client.on('ready', async () => {
  clientReady = true;
  const info = client.info;
  myNumber = info.wid._serialized;
  console.log(`Connected as: ${info.pushname} (${myNumber})`);
  io.emit('status', {
    connected: true,
    message: `Connected as ${info.pushname}`,
    number: myNumber
  });
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

    // Fetch chat labels (WhatsApp Business)
    let chatLabels = [];
    try {
      const labels = await chat.getLabels();
      chatLabels = labels.map(l => l.name.toLowerCase());
    } catch (e) {
      // Labels unavailable (personal account)
    }

    // Detect category
    let category = null;

    if (!isGroup && !chatLabels.length) {
      category = 'direct';
    } else if (!isGroup && chatLabels.length) {
      const matched = MONITORED_LABELS.find(l => chatLabels.includes(l));
      category = matched || 'direct';
    } else if (isGroup) {
      const matchedLabel = MONITORED_LABELS.find(l => chatLabels.includes(l));
      if (matchedLabel) {
        category = matchedLabel;
      } else if (msg.mentionedIds && msg.mentionedIds.includes(myNumber)) {
        category = 'mention';
      }
    }

    if (!category) return;

    const entry = {
      id: msg.id._serialized,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      category,
      chatName: chatName || 'Direct',
      labels: chatLabels,
      sender: senderName,
      body: msg.body,
      hasMedia: msg.hasMedia,
      fromNumber: msg.from
    };

    messageHistory.unshift(entry);
    if (messageHistory.length > MAX_HISTORY) messageHistory.pop();

    io.emit('message', entry);
    console.log(`[${category.toUpperCase()}] ${senderName}: ${msg.body.substring(0, 60)}`);
  } catch (err) {
    console.error('Error processing message:', err);
  }
});

io.on('connection', (socket) => {
  console.log('Dashboard connected');
  socket.emit('history', messageHistory);
  if (clientReady) {
    socket.emit('status', {
      connected: true,
      message: `Connected (${client.info?.pushname || ''})`,
      number: myNumber
    });
  } else {
    socket.emit('status', { connected: false, message: 'Waiting for connection...' });
  }
});

server.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  console.log('Starting WhatsApp client...\n');
  client.initialize();
});
