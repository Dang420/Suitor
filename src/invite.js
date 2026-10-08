// Lady invite codes: ladies can only sign up with a valid, unrevoked,
// unexhausted invite code. Gentlemen never need one.
// Codes are minted locally via scripts/gen-invite.js (never over HTTP).
const crypto = require('crypto');

// Unambiguous alphabet: no 0/O, 1/I/L to avoid transcription mistakes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return 'LADY-' + s.slice(0, 4) + '-' + s.slice(4);
}

// Case-insensitive, dash/space tolerant: "lady-a3f9-k2q7" === "LADYA3F9K2Q7".
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function createInviteCode(pool, opts) {
  opts = opts || {};
  const label = String(opts.label || '').slice(0, 80);
  const maxUses = Math.max(1, parseInt(opts.maxUses, 10) || 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const display = generateCode();
    try {
      const r = await pool.query(
        'INSERT INTO invite_codes (id, code, label, max_uses) VALUES ($1, $2, $3, $4) RETURNING *',
        [crypto.randomUUID(), normalizeCode(display), label, maxUses]
      );
      return Object.assign({}, r.rows[0], { display });
    } catch (err) {
      if (err && err.code === '23505' && attempt < 4) continue; // code collision, retry
      throw err;
    }
  }
  throw new Error('could not mint a unique invite code');
}

module.exports = { generateCode, normalizeCode, createInviteCode };
