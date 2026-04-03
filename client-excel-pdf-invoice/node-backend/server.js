require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const path     = require('path');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Crash protection ──────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('FATAL:', err));
process.on('unhandledRejection', err => console.error('REJECTION:', err));

// ── Database ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// Rate limiting
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/auth/signup', rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/admin',    require('./routes/admin'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 });
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// All non-API routes → SPA
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => console.log(`InvoiceVault v2 running on port ${PORT}`));
