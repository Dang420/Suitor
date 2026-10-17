const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const {
  authRequired,
  setSessionCookie,
  clearSessionCookie,
  AVATAR_COLORS,
  cleanStr,
  isValidEmail,
} = require('./auth');
const paypal = require('./paypal');
const concierge = require('./concierge');
const qloo = require('./qloo');
const { normalizeCode } = require('./invite');

const router = express.Router();

const TOKEN_COST = Math.max(0, parseInt(process.env.TOKEN_COST_PER_MESSAGE || '10', 10));
const WELCOME_TOKENS = Math.max(0, parseInt(process.env.WELCOME_TOKENS || '25', 10));

const PACKS = [
  { id: 'pocket', tokens: 50, usd: 1.99, price: '$1.99' },
  { id: 'casual', tokens: 130, usd: 4.99, price: '$4.99', tag: 'Starter' },
  { id: 'regular', tokens: 650, usd: 19.99, price: '$19.99', tag: 'Most popular' },
  { id: 'whale', tokens: 1800, usd: 49.99, price: '$49.99', tag: 'Best value' },
];

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const msgLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const walletLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const conciergeLimiter = rateLimit({ windowMs: 60 * 1000, max: 15 });

function publicUser(row, balance) {
  const u = {
    id: row.id,
    name: row.name,
    gender: row.gender,
    age: row.age,
    avatarColor: row.avatar_color,
    bio: row.bio,
  };
  if (typeof balance === 'number') u.tokenBalance = balance;
  return u;
}

function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ---------- public config ----------

router.get('/config', (req, res) => {
  res.json({
    costPerMessage: TOKEN_COST,
    welcomeTokens: WELCOME_TOKENS,
    paypalMode: paypal.MODE,
    paypalConfigured: paypal.configured(),
    paypalClientId: paypal.configured() ? process.env.PAYPAL_CLIENT_ID : null,
    conciergeMode: concierge.configured() ? 'ai' : 'bank',
    tasteMode: qloo.configured() ? 'api' : 'bank',
  });
});

// ---------- auth ----------

router.post('/auth/signup', authLimiter, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const name = cleanStr(req.body.name, 24);
    const gender = req.body.gender;
    const age = parseInt(req.body.age, 10);
    const avatarColor = req.body.avatarColor;
    const bio = cleanStr(req.body.bio, 160);

    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (typeof password !== 'string' || password.length < 8)
      return res.status(400).json({ error: 'password_too_short' });
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (gender !== 'lady' && gender !== 'gent')
      return res.status(400).json({ error: 'invalid_gender' });
    if (!Number.isInteger(age) || age < 18)
      return res.status(400).json({ error: 'must_be_18' });
    if (!AVATAR_COLORS.includes(avatarColor))
      return res.status(400).json({ error: 'invalid_avatar_color' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) return res.status(409).json({ error: 'email_taken' });

    // Ladies are invite-only: a valid, unrevoked, unexhausted invite code is
    // required. Gentlemen sign up freely (never put hurdles in front of money).
    const rawInvite = req.body.inviteCode;
    if (gender === 'lady' && !String(rawInvite || '').trim())
      return res.status(400).json({ error: 'invite_required' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
    const startingBalance = gender === 'gent' ? WELCOME_TOKENS : 0;

    // Consume the invite code and create the user atomically: the code row is
    // locked so two simultaneous signups can't both spend the last use.
    const client = await pool.connect();
    let inviteCodeId = null;
    try {
      await client.query('BEGIN');
      if (gender === 'lady') {
        const code = normalizeCode(rawInvite);
        const found = await client.query('SELECT * FROM invite_codes WHERE code = $1 FOR UPDATE', [code]);
        if (found.rowCount === 0) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({ error: 'invite_invalid' });
        }
        const inv = found.rows[0];
        if (inv.revoked) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({ error: 'invite_revoked' });
        }
        if (inv.uses >= inv.max_uses) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({ error: 'invite_exhausted' });
        }
        await client.query('UPDATE invite_codes SET uses = uses + 1 WHERE id = $1', [inv.id]);
        inviteCodeId = inv.id;
      }
      const { rows } = await client.query(
        `INSERT INTO users (id, email, password_hash, name, gender, age, avatar_color, bio, token_balance, invite_code_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, email, passwordHash, name, gender, age, avatarColor, bio, startingBalance, inviteCodeId]
      );
      await client.query('COMMIT');
      client.release();
      setSessionCookie(res, id);
      res.status(201).json({ user: publicUser(rows[0], rows[0].token_balance) });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (e) {}
      client.release();
      throw txErr;
    }
  } catch (err) {
    console.error('signup error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    setSessionCookie(res, rows[0].id);
    res.json({ user: publicUser(rows[0], rows[0].token_balance) });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', authRequired, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!rows.length) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: publicUser(rows[0], rows[0].token_balance) });
});

// ---------- discover (real users only) ----------

router.get('/discover', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.gender, u.age, u.avatar_color, u.bio,
              COALESCE(un.unread, 0) AS unread
       FROM users u
       LEFT JOIN (
         SELECT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS peer_id,
                COUNT(m.id)::int AS unread
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
         LEFT JOIN conversation_reads r
           ON r.conversation_id = c.id AND r.user_id = $1
         WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
           AND m.sender_id <> $1
           AND m.created_at > COALESCE(r.last_read_at, '1970-01-01')
         GROUP BY peer_id
       ) un ON un.peer_id = u.id
       WHERE u.id <> $1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
       ORDER BY u.created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json({
      users: rows.map((r) => ({ ...publicUser(r), unread: r.unread })),
    });
  } catch (err) {
    console.error('discover error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- conversations ----------

async function getConversationFor(memberId, convId) {
  const { rows } = await pool.query(
    `SELECT id, user_a_id, user_b_id,
            CASE WHEN user_a_id = $1 THEN user_b_id ELSE user_a_id END AS peer_id
     FROM conversations WHERE id = $2 AND (user_a_id = $1 OR user_b_id = $1)`,
    [memberId, convId]
  );
  return rows[0] || null;
}

async function isBlockedEitherWay(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}

router.get('/conversations', authRequired, async (req, res) => {
  try {
    const { rows: convs } = await pool.query(
      `SELECT c.id,
              CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS peer_id,
              (SELECT m.body FROM messages m
                WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT m.created_at FROM messages m
                WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.sender_id <> $1
                  AND m.created_at > COALESCE(
                    (SELECT r.last_read_at FROM conversation_reads r
                     WHERE r.conversation_id = c.id AND r.user_id = $1),
                    '1970-01-01')) AS unread
       FROM conversations c
       WHERE c.user_a_id = $1 OR c.user_b_id = $1
       ORDER BY last_at DESC NULLS LAST`,
      [req.userId]
    );
    const peerIds = [...new Set(convs.map((c) => c.peer_id))];
    let peers = {};
    if (peerIds.length) {
      const { rows } = await pool.query(
        'SELECT id, name, gender, age, avatar_color, bio FROM users WHERE id = ANY($1)',
        [peerIds]
      );
      peers = Object.fromEntries(rows.map((r) => [r.id, publicUser(r)]));
    }
    res.json({
      conversations: convs.map((c) => ({
        id: c.id,
        peer: peers[c.peer_id] || null,
        lastBody: c.last_body,
        lastAt: c.last_at,
        unread: c.unread,
      })),
    });
  } catch (err) {
    console.error('conversations error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/conversations', authRequired, async (req, res) => {
  try {
    const peerId = req.body.peerId;
    if (typeof peerId !== 'string' || peerId === req.userId)
      return res.status(400).json({ error: 'invalid_peer' });
    const peer = await pool.query('SELECT id FROM users WHERE id = $1', [peerId]);
    if (!peer.rowCount) return res.status(404).json({ error: 'peer_not_found' });
    if (await isBlockedEitherWay(req.userId, peerId))
      return res.status(403).json({ error: 'blocked' });

    const [a, b] = canonicalPair(req.userId, peerId);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, user_a_id, user_b_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
      [id, a, b]
    );
    const { rows } = await pool.query(
      'SELECT id FROM conversations WHERE user_a_id = $1 AND user_b_id = $2',
      [a, b]
    );
    res.status(201).json({ conversation: { id: rows[0].id, peerId } });
  } catch (err) {
    console.error('create conversation error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/conversations/:id/messages', authRequired, async (req, res) => {
  try {
    const conv = await getConversationFor(req.userId, req.params.id);
    if (!conv) return res.status(404).json({ error: 'not_found' });

    const after = req.query.after ? new Date(req.query.after) : null;
    const params = [conv.id];
    let where = 'm.conversation_id = $1';
    if (after && !isNaN(after)) {
      params.push(after.toISOString());
      where += ' AND m.created_at > $2';
    }
    const { rows } = await pool.query(
      `SELECT m.id, m.sender_id, m.body, m.tokens_charged, m.created_at
       FROM messages m WHERE ${where} ORDER BY m.created_at ASC LIMIT 200`,
      params
    );

    // Mark as read.
    await pool.query(
      `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
       VALUES ($1, $2, now())
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()`,
      [conv.id, req.userId]
    );

    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        from: m.sender_id === req.userId ? 'me' : 'them',
        text: m.body,
        ts: new Date(m.created_at).getTime(),
      })),
    });
  } catch (err) {
    console.error('messages error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/conversations/:id/messages', authRequired, msgLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const conv = await getConversationFor(req.userId, req.params.id);
    if (!conv) {
      client.release();
      return res.status(404).json({ error: 'not_found' });
    }
    if (await isBlockedEitherWay(req.userId, conv.peer_id)) {
      client.release();
      return res.status(403).json({ error: 'blocked' });
    }

    const body = cleanStr(req.body.body, 2000);
    if (!body) {
      client.release();
      return res.status(400).json({ error: 'empty_message' });
    }

    const meRes = await pool.query('SELECT gender, token_balance FROM users WHERE id = $1', [
      req.userId,
    ]);
    const peerRes = await pool.query('SELECT gender FROM users WHERE id = $1', [conv.peer_id]);
    const me = meRes.rows[0];
    const peer = peerRes.rows[0];
    const cost = me.gender === 'gent' && peer.gender === 'lady' ? TOKEN_COST : 0;

    await client.query('BEGIN');
    if (cost > 0) {
      const balRes = await client.query(
        'SELECT token_balance FROM users WHERE id = $1 FOR UPDATE',
        [req.userId]
      );
      if (balRes.rows[0].token_balance < cost) {
        await client.query('ROLLBACK');
        client.release();
        return res
          .status(402)
          .json({ error: 'insufficient_tokens', balance: balRes.rows[0].token_balance, cost });
      }
      await client.query('UPDATE users SET token_balance = token_balance - $1 WHERE id = $2', [
        cost,
        req.userId,
      ]);
    }
    const msgId = crypto.randomUUID();
    await client.query(
      `INSERT INTO messages (id, conversation_id, sender_id, body, tokens_charged)
       VALUES ($1, $2, $3, $4, $5)`,
      [msgId, conv.id, req.userId, body, cost]
    );
    const newBal = await client.query('SELECT token_balance FROM users WHERE id = $1', [req.userId]);
    await client.query('COMMIT');
    client.release();

    res.status(201).json({
      message: { id: msgId, from: 'me', text: body, ts: Date.now() },
      balance: newBal.rows[0].token_balance,
      charged: cost,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (e) {}
    client.release();
    console.error('send message error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- AI concierge (drafts only — never sends, never charges) ----------

// Returns message drafts + a date idea for the signed-in user in this
// conversation. Read-only by design: no message is written and no token
// moves here. Tokens are spent only when the user sends a message
// through POST /conversations/:id/messages, exactly as before.
router.post('/conversations/:id/concierge', authRequired, conciergeLimiter, async (req, res) => {
  try {
    const conv = await getConversationFor(req.userId, req.params.id);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    if (await isBlockedEitherWay(req.userId, conv.peer_id))
      return res.status(403).json({ error: 'blocked' });

    const goal = typeof req.body.goal === 'string' ? req.body.goal : '';
    if (!concierge.GOALS[goal]) return res.status(400).json({ error: 'invalid_goal' });
    const hint = cleanStr(req.body.hint, 200);

    const meRes = await pool.query(
      'SELECT name, gender, age, bio, token_balance FROM users WHERE id = $1',
      [req.userId]
    );
    const peerRes = await pool.query('SELECT name, gender, age, bio FROM users WHERE id = $1', [
      conv.peer_id,
    ]);
    const me = meRes.rows[0];
    const peer = peerRes.rows[0];

    const { rows: msgRows } = await pool.query(
      `SELECT sender_id, body FROM messages
       WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 12`,
      [conv.id]
    );
    const recent = msgRows
      .reverse()
      .map((m) => ({ from: m.sender_id === req.userId ? 'me' : 'them', text: m.body }));

    const out = await concierge.suggest({
      goal,
      me: { name: me.name, gender: me.gender, age: me.age, bio: me.bio },
      peer: { name: peer.name, gender: peer.gender, age: peer.age, bio: peer.bio },
      recent,
      hint,
    });

    const cost = me.gender === 'gent' && peer.gender === 'lady' ? TOKEN_COST : 0;
    res.json({
      goal,
      drafts: out.drafts,
      dateIdea: out.dateIdea,
      taste: out.taste || null,
      source: out.source,
      cost,
      balance: me.token_balance,
      canAfford: cost === 0 || me.token_balance >= cost,
    });
  } catch (err) {
    console.error('concierge error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- wallet ----------

router.get('/wallet', authRequired, async (req, res) => {
  const { rows } = await pool.query('SELECT token_balance FROM users WHERE id = $1', [req.userId]);
  res.json({
    balance: rows[0].token_balance,
    packs: PACKS,
    paypalMode: paypal.MODE,
    paypalConfigured: paypal.configured(),
  });
});

router.post('/wallet/create-order', authRequired, walletLimiter, async (req, res) => {
  try {
    if (!paypal.configured()) return res.status(503).json({ error: 'paypal_not_configured' });
    const pack = PACKS.find((p) => p.id === req.body.packId);
    if (!pack) return res.status(400).json({ error: 'invalid_pack' });

    const order = await paypal.createOrder({
      description: pack.tokens + ' Suitor tokens',
      amountUsd: pack.usd,
    });

    await pool.query(
      `INSERT INTO purchases (id, user_id, pack_id, tokens, amount_usd, paypal_order_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [crypto.randomUUID(), req.userId, pack.id, pack.tokens, pack.usd, order.id]
    );

    res.json({ orderId: order.id });
  } catch (err) {
    console.error('create-order error', err);
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

router.post('/wallet/capture', authRequired, walletLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!paypal.configured()) {
      client.release();
      return res.status(503).json({ error: 'paypal_not_configured' });
    }
    const orderId = req.body.orderId;
    if (typeof orderId !== 'string' || !orderId) {
      client.release();
      return res.status(400).json({ error: 'invalid_order' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM purchases WHERE paypal_order_id = $1 AND user_id = $2',
      [orderId, req.userId]
    );
    if (!rows.length) {
      client.release();
      return res.status(404).json({ error: 'order_not_found' });
    }
    const purchase = rows[0];
    if (purchase.status === 'completed') {
      const bal = await pool.query('SELECT token_balance FROM users WHERE id = $1', [req.userId]);
      client.release();
      return res.json({ ok: true, already: true, balance: bal.rows[0].token_balance });
    }

    // Capture with PayPal and VERIFY before crediting anything.
    const data = await paypal.captureOrder(orderId);
    const capture = data.purchase_units &&
      data.purchase_units[0] &&
      data.purchase_units[0].payments &&
      data.purchase_units[0].payments.captures &&
      data.purchase_units[0].payments.captures[0];

    const expectedAmount = Number(purchase.amount_usd).toFixed(2);
    const verified =
      data.status === 'COMPLETED' &&
      capture &&
      capture.status === 'COMPLETED' &&
      capture.amount &&
      capture.amount.currency_code === 'USD' &&
      Number(capture.amount.value).toFixed(2) === expectedAmount;

    if (!verified) {
      await pool.query(`UPDATE purchases SET status = 'failed' WHERE id = $1`, [purchase.id]);
      client.release();
      return res.status(402).json({ error: 'payment_not_verified' });
    }

    // Idempotent credit: only transition pending -> completed once.
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE purchases SET status = 'completed', paypal_capture_id = $1
       WHERE id = $2 AND status = 'pending'`,
      [capture.id, purchase.id]
    );
    let balanceRow;
    if (upd.rowCount === 1) {
      await client.query('UPDATE users SET token_balance = token_balance + $1 WHERE id = $2', [
        purchase.tokens,
        req.userId,
      ]);
    }
    balanceRow = await client.query('SELECT token_balance FROM users WHERE id = $1', [req.userId]);
    await client.query('COMMIT');
    client.release();

    res.json({ ok: true, balance: balanceRow.rows[0].token_balance, tokens: purchase.tokens });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (e) {}
    client.release();
    console.error('capture error', err);
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

// ---------- safety: report / block ----------

router.post('/users/:id/report', authRequired, async (req, res) => {
  try {
    const reportedId = req.params.id;
    if (reportedId === req.userId) return res.status(400).json({ error: 'invalid_target' });
    const reason = cleanStr(req.body.reason, 500);
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    const target = await pool.query('SELECT id FROM users WHERE id = $1', [reportedId]);
    if (!target.rowCount) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      'INSERT INTO reports (id, reporter_id, reported_id, reason) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), req.userId, reportedId, reason]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('report error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/users/:id/block', authRequired, async (req, res) => {
  try {
    const blockedId = req.params.id;
    if (blockedId === req.userId) return res.status(400).json({ error: 'invalid_target' });
    const target = await pool.query('SELECT id FROM users WHERE id = $1', [blockedId]);
    if (!target.rowCount) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.userId, blockedId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('block error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/users/:id/block', authRequired, async (req, res) => {
  await pool.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
    req.userId,
    req.params.id,
  ]);
  res.json({ ok: true });
});

module.exports = router;
