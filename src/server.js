require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { initSchema } = require('./db');

const oauthRoutes = require('./routes/oauth');
const stockRoutes = require('./routes/stock');
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON — webhook route needs raw body access for signature verification,
// but express.json() is fine here since we re-compute the hash from parsed body.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' },
  })
);

// Routes
app.use('/oauth', oauthRoutes);
app.use('/api/stock', stockRoutes);
app.use('/webhook', webhookRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Root — redirect to install
app.get('/', (req, res) => {
  res.redirect('/oauth/install');
});

async function start() {
  try {
    await initSchema();
    app.listen(PORT, () => {
      console.log(`[server] StockIQ running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
