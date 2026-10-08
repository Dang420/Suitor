require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const routes = require('./routes');

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is required for the PayPal Smart Buttons SDK.
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
        ],
        connectSrc: [
          "'self'",
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
        ],
        imgSrc: ["'self'", 'data:', 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],
        frameSrc: ['https://www.paypal.com', 'https://www.sandbox.paypal.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', routes);

// Static frontend.
app.use(express.static(path.join(__dirname, '..', 'public')));

// JSON 404 for unknown API routes (before the SPA fallback).
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled error', err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Suitor listening on :${PORT} (env=${process.env.NODE_ENV || 'development'})`);
});
