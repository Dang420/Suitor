#!/usr/bin/env node
// Mint a lady invite code. Run on the server machine (never exposed over HTTP):
//   node scripts/gen-invite.js --label "Maya's friends" --uses 25
//   node scripts/gen-invite.js --uses 1            (single-use, no label)
require('dotenv').config();
const { pool } = require('../src/db');
const { createInviteCode } = require('../src/invite');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const label = arg('label', '');
  const uses = arg('uses', '1');
  try {
    const inv = await createInviteCode(pool, { label, maxUses: uses });
    console.log('');
    console.log('  Lady invite code:  ' + inv.display);
    console.log('  Label:             ' + (inv.label || '(none)'));
    console.log('  Max uses:          ' + inv.max_uses);
    console.log('');
    console.log('Share the code with the lady. She enters it at signup.');
    console.log('Revoke later with:  UPDATE invite_codes SET revoked = TRUE WHERE code = \'' + inv.code + '\';');
  } catch (err) {
    console.error('failed to mint invite code:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
