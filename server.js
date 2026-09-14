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
const io = new Server(server);

// Retrieve tokens from .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MY_TELEGRAM_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !MY_TELEGRAM_CHAT_ID) {
  console.error("⚠️ WARNING: Please set TELEGRAM_BOT_TOKEN and MY_TELEGRAM_CHAT_ID in your .env file!");
}

// Initialize Telegram Bot with long polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage for user image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

app.use(express.static('public'));
app.use(express.json());

// Store active web socket user sessions (socketId -> userName)
const activeSockets = new Map();

// 1. Upload Route (Website -> Telegram)
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  
  const imageUrl = `/uploads/${req.file.filename}`;
  const { userName, socketId } = req.body;

  // Send photo to your Telegram bot
  if (MY_TELEGRAM_CHAT_ID) {
    bot.sendPhoto(MY_TELEGRAM_CHAT_ID, path.join(__dirname, 'public', imageUrl), {
      caption: `📷 Image from ${userName || 'User'} (ID: ${socketId})`
    }).catch(err => console.error('Telegram Send Error:', err.message));
  }

  res.json({ imageUrl });
});

// 2. Real-time WebSockets setup
io.on('connection', (socket) => {
  console.log('🟢 Web client connected:', socket.id);

  // When user enters their name to start chatting
  socket.on('join_chat', (data) => {
    const userName = data.userName || 'Guest';
    activeSockets.set(socket.id, userName);

    // Alert you on Telegram that someone started a booking chat
    if (MY_TELEGRAM_CHAT_ID) {
      bot.sendMessage(
        MY_TELEGRAM_CHAT_ID, 
        `🟢 *New Client Chat Started*\nUser: *${userName}*\nSocket ID: \`${socket.id}\`\nTicket: *${data.ticketTitle || 'General Inquiry'}*`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // Incoming text from website client
  socket.on('user_message', (data) => {
    const userName = activeSockets.get(socket.id) || 'User';

    // Broadcast message to user's web chat UI
    socket.emit('chat_message', {
      sender: userName,
      text: data.text,
      image: data.image,
      isUser: true
    });

    // Forward to Telegram
    if (MY_TELEGRAM_CHAT_ID) {
      const msgText = `💬 *${userName}* (\`${socket.id}\`):\n${data.text || '[Image Attachment]'}`;
      bot.sendMessage(MY_TELEGRAM_CHAT_ID, msgText, { parse_mode: 'Markdown' });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔴 Web client disconnected:', socket.id);
    activeSockets.delete(socket.id);
  });
});

// 3. Receive replies from Telegram and deliver to Web client as "Ann"
bot.on('message', async (msg) => {
  if (!MY_TELEGRAM_CHAT_ID || msg.chat.id.toString() !== MY_TELEGRAM_CHAT_ID.toString()) return;

  // Attempt to target socket ID by replying to a forwarded message containing the Socket ID
  let targetSocketId = null;
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const match = msg.reply_to_message.text.match(/Socket ID: `([^`]+)`|\(([^)]+)\)/);
    if (match) targetSocketId = match[1] || match[2];
  }

  // Fallback: If not replying directly to a message, send to the last connected web user
  if (!targetSocketId && activeSockets.size > 0) {
    targetSocketId = Array.from(activeSockets.keys())[activeSockets.size - 1];
  }

  if (!targetSocketId) return;

  // If text message from Ann
  if (msg.text) {
    io.to(targetSocketId).emit('chat_message', {
      sender: 'Ann',
      text: msg.text,
      isUser: false
    });
  }

  // If photo attachment from Ann
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
      console.error('Failed to get Telegram photo link:', err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
