require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Enable CORS for Vercel cross-origin connections
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MY_TELEGRAM_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !MY_TELEGRAM_CHAT_ID) {
  console.warn("⚠️ WARNING: Set TELEGRAM_BOT_TOKEN and MY_TELEGRAM_CHAT_ID in Environment Variables!");
}

// Single-instance polling to avoid 409 Conflict
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.error('⚠️ Telegram Conflict: Multiple bot instances running!');
  } else {
    console.error(`[Telegram Polling Error] ${error.code}: ${error.message}`);
  }
});

// Create uploads directory inside public/
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Express Middlewares & CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const activeSockets = new Map();

// Upload route (Vercel Client -> Render -> Telegram)
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    
    const imageUrl = `/uploads/${req.file.filename}`;
    const { userName, socketId } = req.body;
    const clientName = userName || 'Client';

    if (socketId) {
      io.to(socketId).emit('chat_message', {
        sender: clientName,
        image: imageUrl,
        isUser: true
      });
    }

    if (MY_TELEGRAM_CHAT_ID) {
      const fullFilePath = path.join(uploadDir, req.file.filename);
      const captionText = `📷 *New Photo from ${clientName}*\nSocket ID: \`${socketId}\``;

      await bot.sendPhoto(MY_TELEGRAM_CHAT_ID, fullFilePath, {
        caption: captionText,
        parse_mode: 'Markdown'
      });
    }

    res.json({ imageUrl });
  } catch (err) {
    console.error('Error handling upload:', err);
    res.status(500).json({ error: 'Failed to upload image.' });
  }
});

// Socket.io Realtime Layer
io.on('connection', (socket) => {
  console.log(`🟢 Web user connected: ${socket.id}`);

  socket.on('join_chat', (data) => {
    const userName = data.userName || 'Guest';
    const ticketTitle = data.ticketTitle || 'General Suite Inquiry';

    activeSockets.set(socket.id, { userName, ticketTitle });

    socket.emit('chat_message', {
      sender: 'Ann',
      text: `Hello ${userName}! Welcome to Atlanta Falcons Suites. How can I help you with your booking today?`,
      isUser: false
    });

    if (MY_TELEGRAM_CHAT_ID) {
      bot.sendMessage(
        MY_TELEGRAM_CHAT_ID,
        `🎟️ *New Ticket Booking Inquiry*\n\n👤 *Client:* ${userName}\n🎫 *Item:* ${ticketTitle}\n🆔 *Socket ID:* \`${socket.id}\`\n\n_Reply directly to this message to chat with the client._`,
        { parse_mode: 'Markdown' }
      ).catch(e => console.error('Telegram Notify Error:', e.message));
    }
  });

  socket.on('user_message', (data) => {
    const session = activeSockets.get(socket.id);
    const userName = session ? session.userName : 'Client';

    socket.emit('chat_message', {
      sender: userName,
      text: data.text,
      image: data.image,
      isUser: true
    });

    if (MY_TELEGRAM_CHAT_ID && data.text) {
      const formattedMessage = `💬 *${userName}* (\`${socket.id}\`):\n${data.text}`;
      bot.sendMessage(MY_TELEGRAM_CHAT_ID, formattedMessage, { parse_mode: 'Markdown' })
         .catch(e => console.error('Telegram Send Error:', e.message));
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Web user disconnected: ${socket.id}`);
    activeSockets.delete(socket.id);
  });
});

// Telegram -> Web Client Relay
bot.on('message', async (msg) => {
  if (!MY_TELEGRAM_CHAT_ID || msg.chat.id.toString() !== MY_TELEGRAM_CHAT_ID.toString()) return;

  let targetSocketId = null;

  if (msg.reply_to_message && msg.reply_to_message.text) {
    const match = msg.reply_to_message.text.match(/Socket ID: `([^`]+)`|\(([^)]+)\)/);
    if (match) targetSocketId = match[1] || match[2];
  }

  if (!targetSocketId && activeSockets.size > 0) {
    targetSocketId = Array.from(activeSockets.keys())[activeSockets.size - 1];
  }

  if (!targetSocketId || !activeSockets.has(targetSocketId)) {
    if (!msg.text?.startsWith('/')) {
      bot.sendMessage(MY_TELEGRAM_CHAT_ID, "⚠️ *No active client session found to receive this message.*", { parse_mode: 'Markdown' });
    }
    return;
  }

  if (msg.text) {
    io.to(targetSocketId).emit('chat_message', {
      sender: 'Ann',
      text: msg.text,
      isUser: false
    });
  }

  if (msg.photo) {
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(fileId);

      io.to(targetSocketId).emit('chat_message', {
        sender: 'Ann',
        text: msg.caption || '',
        image: fileLink,
        isUser: false
      });
    } catch (err) {
      console.error('Photo fetch error:', err.message);
    }
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Render Backend running on port ${PORT}`);
});
