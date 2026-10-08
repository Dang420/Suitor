// PayPal REST (Orders v2) helpers. Server-side only — the secret never
// leaves the backend. Sandbox by default; set PAYPAL_MODE=live for real money.
const MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const BASE = MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

let tokenCache = null;

function configured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  if (!configured()) {
    const err = new Error('paypal_not_configured');
    err.status = 503;
    throw err;
  }
  const creds = Buffer.from(
    process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET
  ).toString('base64');
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const err = new Error('paypal_auth_failed');
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function createOrder({ description, amountUsd }) {
  const token = await getAccessToken();
  const res = await fetch(BASE + '/v2/checkout/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          description,
          amount: { currency_code: 'USD', value: amountUsd.toFixed(2) },
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('paypal_create_order_failed');
    err.status = 502;
    err.detail = data;
    throw err;
  }
  return data; // { id, status, ... }
}

async function captureOrder(orderId) {
  const token = await getAccessToken();
  const res = await fetch(
    BASE + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('paypal_capture_failed');
    err.status = 502;
    err.detail = data;
    throw err;
  }
  return data;
}

module.exports = { MODE, configured, createOrder, captureOrder };
