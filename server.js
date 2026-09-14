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

// Environment Configuration
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MY_TELEGRAM_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !MY_TELEGRAM_CHAT_ID) {
  console.warn("⚠️ WARNING: Please set TELEGRAM_BOT_TOKEN and MY_TELEGRAM_CHAT_ID in your .env file!");
}

// Initialize Telegram Bot with error handling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error(`[Telegram Bot Error] ${error.code}: ${error.message}`);
});

// Ensure upload directory exists inside public/
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage engine for image uploads
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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Store active web socket user sessions (socketId -> session object)
const activeSockets = new Map();

// -------------------------------------------------------------
// 1. Image Upload Route (Website -> Server -> Telegram)
// -------------------------------------------------------------
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
    
    const imageUrl = `/uploads/${req.file.filename}`;
    const { userName, socketId } = req.body;
    const clientName = userName || 'Client';

    // Broadcast image back to user's chat window immediately
    if (socketId) {
      io.to(socketId).emit('chat_message', {
        sender: clientName,
        image: imageUrl,
        isUser: true
      });
    }

    // Forward image to Ann on Telegram
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

// -------------------------------------------------------------
// 2. WebSockets Connection & Events (Client <-> Server)
// -------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`🟢 New web user connected: ${socket.id}`);

  // User enters their name and opens chat
  socket.on('join_chat', (data) => {
    const userName = data.userName || 'Guest';
    const ticketTitle = data.ticketTitle || 'General Suite Inquiry';

    activeSockets.set(socket.id, { userName, ticketTitle });

    // Send introductory welcome message from Ann on website
    socket.emit('chat_message', {
      sender: 'Ann',
      text: `Hello ${userName}! Welcome to Atlanta Falcons Suites. How can I help you with your booking today?`,
      isUser: false
    });

    // Notify Ann on Telegram
    if (MY_TELEGRAM_CHAT_ID) {
      bot.sendMessage(
        MY_TELEGRAM_CHAT_ID,
        `🎟️ *New Ticket Booking Inquiry*\n\n👤 *Client:* ${userName}\n🎫 *Item:* ${ticketTitle}\n🆔 *Socket ID:* \`${socket.id}\`\n\n_Reply to this notification to chat with the client._`,
        { parse_mode: 'Markdown' }
      ).catch(e => console.error('Telegram Notify Error:', e.message));
    }
  });

  // Client sends text message from Website
  socket.on('user_message', (data) => {
    const session = activeSockets.get(socket.id);
    const userName = session ? session.userName : 'Client';

    // Emit message to client UI
    socket.emit('chat_message', {
      sender: userName,
      text: data.text,
      image: data.image,
      isUser: true
    });

    // Send to Telegram
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

// -------------------------------------------------------------
// 3. Telegram Reply Handler (Ann on Telegram -> Web Client)
// -------------------------------------------------------------
bot.on('message', async (msg) => {
  // Only process messages coming from Ann's configured Chat ID
  if (!MY_TELEGRAM_CHAT_ID || msg.chat.id.toString() !== MY_TELEGRAM_CHAT_ID.toString()) return;

  let targetSocketId = null;

  // Option A: Extract Target Socket ID if replying directly to a Telegram notification
  if (msg.reply_to_message && msg.reply_to_message.text) {
    const match = msg.reply_to_message.text.match(/Socket ID: `([^`]+)`|\(([^)]+)\)/);
    if (match) {
      targetSocketId = match[1] || match[2];
    }
  }

  // Option B: Fallback to the latest connected user if not replying to a specific message
  if (!targetSocketId && activeSockets.size > 0) {
    targetSocketId = Array.from(activeSockets.keys())[activeSockets.size - 1];
  }

  if (!targetSocketId || !activeSockets.has(targetSocketId)) {
    if (!msg.text?.startsWith('/')) {
      bot.sendMessage(MY_TELEGRAM_CHAT_ID, "⚠️ *No active user session found to receive this message.*", { parse_mode: 'Markdown' });
    }
    return;
  }

  // Handle Text Reply from Ann
  if (msg.text) {
    io.to(targetSocketId).emit('chat_message', {
      sender: 'Ann',
      text: msg.text,
      isUser: false
    });
  }

  // Handle Photo Reply from Ann
  if (msg.photo) {
    try {
      // Get highest resolution photo version
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(fileId);

      io.to(targetSocketId).emit('chat_message', {
        sender: 'Ann',
        text: msg.caption || '',
        image: fileLink,
        isUser: false
      });
    } catch (err) {
      console.error('Failed to process photo from Telegram:', err.message);
    }
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`🚀 Falcons Suite Booking Server live on http://localhost:${PORT}`);
});
