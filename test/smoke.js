// Smoke test: signup -> discover -> message -> token deduction -> wallet.
// Run with the server up:  npm start &  node test/smoke.js
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { createInviteCode } = require('../src/invite');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}

// 0. frontend routing: the logged-out auth screen must be reachable.
// Regression test: render() once checked `!S.user` before the auth route,
// which made signup/login unreachable (welcome screen looped forever).
(function checkFrontendRouting() {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const authIdx = appJs.indexOf('if (S.route === "auth")');
  const welcomeIdx = appJs.indexOf('if (S.route === "welcome" || !S.user)');
  check('frontend: auth route check exists', authIdx !== -1);
  check('frontend: welcome route check exists', welcomeIdx !== -1);
  check('frontend: auth route checked before welcome fallback', authIdx !== -1 && welcomeIdx !== -1 && authIdx < welcomeIdx,
    'auth at ' + authIdx + ', welcome at ' + welcomeIdx);
  check('frontend: invite code field present', appJs.indexOf('ob-invite') !== -1);
  check('frontend: invite error messages mapped', appJs.indexOf('invite_invalid') !== -1 && appJs.indexOf('invite_exhausted') !== -1);
  check('frontend: concierge button present', appJs.indexOf('t-concierge') !== -1);
  check('frontend: concierge endpoint wired', appJs.indexOf('/concierge') !== -1);
})();

function makeClient() {
  let cookie = '';
  return {
    async req(path, opts) {
      opts = opts || {};
      const res = await fetch(BASE + path, {
        method: opts.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = {};
      try { data = await res.json(); } catch (e) {}
      return { status: res.status, data };
    },
  };
}

(async () => {
  console.log('== Suitor smoke test ==');

  // 1. health
  const h = await makeClient().req('/api/health');
  check('health endpoint', h.status === 200 && h.data.ok === true);

  // 2. signup lady (0 tokens, invite code required) + gent (25 tokens, no code)
  const ladyInvite = await createInviteCode(pool, { label: 'smoke lady', maxUses: 10 });
  const lady = makeClient();
  const rl = await lady.req('/api/auth/signup', {
    method: 'POST',
    body: { email: 'lady@test.local', password: 'password123', name: 'TestLady', gender: 'lady', age: 28, avatarColor: '#ff5c8a', bio: 'smoke test', inviteCode: ladyInvite.display },
  });
  check('lady signup 201', rl.status === 201, JSON.stringify(rl.data));
  check('lady starts with 0 tokens', rl.data.user && rl.data.user.tokenBalance === 0);

  const gent = makeClient();
  const rg = await gent.req('/api/auth/signup', {
    method: 'POST',
    body: { email: 'gent@test.local', password: 'password123', name: 'TestGent', gender: 'gent', age: 30, avatarColor: '#3aa8ff' },
  });
  check('gent signup 201', rg.status === 201, JSON.stringify(rg.data));
  check('gent starts with 25 tokens', rg.data.user && rg.data.user.tokenBalance === 25);

  // 3. under-18 rejected
  const kid = makeClient();
  const rk = await kid.req('/api/auth/signup', {
    method: 'POST',
    body: { email: 'kid@test.local', password: 'password123', name: 'Kid', gender: 'gent', age: 17, avatarColor: '#3aa8ff' },
  });
  check('under-18 rejected (400)', rk.status === 400 && rk.data.error === 'must_be_18');

  // 3b. lady invite-code gating
  const ladyBody = (email, extra) => Object.assign(
    { email, password: 'password123', name: 'InviteTest', gender: 'lady', age: 24, avatarColor: '#ff5c8a' },
    extra || {}
  );
  const rNoCode = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('nocode@test.local') });
  check('lady without code -> 400 invite_required', rNoCode.status === 400 && rNoCode.data.error === 'invite_required',
    JSON.stringify(rNoCode.data));
  const rBadCode = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('badcode@test.local', { inviteCode: 'LADY-NOPE-00' }) });
  check('lady with bogus code -> 400 invite_invalid', rBadCode.status === 400 && rBadCode.data.error === 'invite_invalid',
    JSON.stringify(rBadCode.data));
  const single = await createInviteCode(pool, { label: 'smoke single-use', maxUses: 1 });
  const rFirst = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('first@test.local', { inviteCode: single.display }) });
  check('lady with valid single-use code -> 201', rFirst.status === 201, JSON.stringify(rFirst.data));
  const rReuse = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('reuse@test.local', { inviteCode: single.display }) });
  check('single-use code reuse -> 400 invite_exhausted', rReuse.status === 400 && rReuse.data.error === 'invite_exhausted',
    JSON.stringify(rReuse.data));
  const rev = await createInviteCode(pool, { label: 'smoke revoked', maxUses: 5 });
  await pool.query('UPDATE invite_codes SET revoked = TRUE WHERE id = $1', [rev.id]);
  const rRevoked = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('revoked@test.local', { inviteCode: rev.display }) });
  check('revoked code -> 400 invite_revoked', rRevoked.status === 400 && rRevoked.data.error === 'invite_revoked',
    JSON.stringify(rRevoked.data));
  // case/dash tolerant: lowercase, no dashes
  const flex = await createInviteCode(pool, { label: 'smoke flex', maxUses: 5 });
  const rFlex = await makeClient().req('/api/auth/signup', { method: 'POST', body: ladyBody('flex@test.local', { inviteCode: flex.display.toLowerCase().replace(/-/g, '') }) });
  check('code accepted lowercase without dashes -> 201', rFlex.status === 201, JSON.stringify(rFlex.data));

  const ladyId = rl.data.user.id;

  // 4. discover shows the real lady, no bots
  const disc = await gent.req('/api/discover');
  const found = (disc.data.users || []).find((u) => u.id === ladyId);
  check('discover lists the lady', !!found);
  check('no simulated profiles in discover', (disc.data.users || []).every((u) => u.id && u.email === undefined));

  // 5. gent opens conversation + sends message -> 10 tokens deducted
  const conv = await gent.req('/api/conversations', { method: 'POST', body: { peerId: ladyId } });
  check('conversation created', conv.status === 201 && conv.data.conversation.id);
  const convId = conv.data.conversation.id;

  const m1 = await gent.req('/api/conversations/' + convId + '/messages', {
    method: 'POST', body: { body: 'Hello from the smoke test' },
  });
  check('gent message sent (201)', m1.status === 201, JSON.stringify(m1.data));
  check('gent charged 10 tokens', m1.data.charged === 10);
  check('gent balance now 15', m1.data.balance === 15);

  // 6. lady replies free
  const m2 = await lady.req('/api/conversations/' + convId + '/messages', {
    method: 'POST', body: { body: 'Hi back, free of charge' },
  });
  check('lady message sent', m2.status === 201);
  check('lady charged 0', m2.data.charged === 0);
  check('lady balance still 0', m2.data.balance === 0);

  // 7. drain gent: 15 -> 5 -> 402
  const mDrain = await gent.req('/api/conversations/' + convId + '/messages', { method: 'POST', body: { body: 'second' } });
  check('second message sent, leaves 5', mDrain.status === 201 && mDrain.data.balance === 5, JSON.stringify(mDrain.data));
  const m3 = await gent.req('/api/conversations/' + convId + '/messages', { method: 'POST', body: { body: 'third?' } });
  check('third message -> 402 insufficient_tokens', m3.status === 402 && m3.data.error === 'insufficient_tokens', JSON.stringify(m3.data));
  const m4 = await gent.req('/api/conversations/' + convId + '/messages', { method: 'POST', body: { body: 'broke?' } });
  check('still 402 when broke', m4.status === 402 && m4.data.error === 'insufficient_tokens');

  // 8. messages persist (gent x2, lady x1 = 3; the 402s were never stored)
  const msgs = await lady.req('/api/conversations/' + convId + '/messages');
  check('messages persist (3 total)', msgs.data.messages && msgs.data.messages.length === 3,
    'got ' + (msgs.data.messages || []).length);

  // 9. wallet reflects balance
  const wallet = await gent.req('/api/wallet');
  check('wallet balance = 5', wallet.data.balance === 5, JSON.stringify(wallet.data));
  check('wallet lists 4 packs', wallet.data.packs && wallet.data.packs.length === 4);

  // 9b. concierge: drafts only — never sends, never charges, never credits.
  // Balance/message assertions are RELATIVE (before vs. after the call) so
  // they verify the concierge's own contract on any database engine.
  const msgsBeforeCg = await lady.req('/api/conversations/' + convId + '/messages');
  const countBeforeCg = (msgsBeforeCg.data.messages || []).length;
  const walletBeforeCg = await gent.req('/api/wallet');
  const balBeforeCg = walletBeforeCg.data.balance;
  const cg = await gent.req('/api/conversations/' + convId + '/concierge', {
    method: 'POST', body: { goal: 'keep_going' },
  });
  check('concierge returns 200', cg.status === 200, JSON.stringify(cg.data));
  check('concierge returns 3 drafts', Array.isArray(cg.data.drafts) && cg.data.drafts.length === 3,
    JSON.stringify(cg.data.drafts));
  check('concierge drafts have tone + text',
    (cg.data.drafts || []).every((d) => d.tone && typeof d.text === 'string' && d.text.length > 0));
  check('concierge source is bank without an AI key', cg.data.source === 'bank', cg.data.source);
  check('concierge returns a date idea', typeof cg.data.dateIdea === 'string' && cg.data.dateIdea.length > 0);
  check('concierge cost/balance/canAfford consistent',
    cg.data.cost === 10 && cg.data.balance === balBeforeCg &&
    cg.data.canAfford === (balBeforeCg >= cg.data.cost),
    JSON.stringify(cg.data));
  const walletAfterCg = await gent.req('/api/wallet');
  check('concierge did not move the balance', walletAfterCg.data.balance === balBeforeCg,
    'before ' + balBeforeCg + ', after ' + walletAfterCg.data.balance);
  const msgsAfterCg = await lady.req('/api/conversations/' + convId + '/messages');
  check('concierge sent nothing (message count unchanged)',
    (msgsAfterCg.data.messages || []).length === countBeforeCg,
    'before ' + countBeforeCg + ', after ' + (msgsAfterCg.data.messages || []).length);
  const cgBadGoal = await gent.req('/api/conversations/' + convId + '/concierge', {
    method: 'POST', body: { goal: 'bogus' },
  });
  check('concierge bogus goal -> 400 invalid_goal',
    cgBadGoal.status === 400 && cgBadGoal.data.error === 'invalid_goal', JSON.stringify(cgBadGoal.data));
  const cgLady = await lady.req('/api/conversations/' + convId + '/concierge', {
    method: 'POST', body: { goal: 'hello' },
  });
  check('lady concierge works, cost 0',
    cgLady.status === 200 && cgLady.data.cost === 0 && cgLady.data.canAfford === true,
    JSON.stringify(cgLady.data));
  // A gent whose balance can't cover one message gets canAfford: false.
  const gentBroke = makeClient();
  const rgb = await gentBroke.req('/api/auth/signup', {
    method: 'POST',
    body: { email: 'broke@test.local', password: 'password123', name: 'BrokeGent', gender: 'gent', age: 33, avatarColor: '#2fbf71' },
  });
  check('broke gent signup 201', rgb.status === 201, JSON.stringify(rgb.data));
  await pool.query('UPDATE users SET token_balance = 5 WHERE id = $1', [rgb.data.user.id]);
  const convB = await gentBroke.req('/api/conversations', { method: 'POST', body: { peerId: ladyId } });
  const cgBroke = await gentBroke.req('/api/conversations/' + convB.data.conversation.id + '/concierge', {
    method: 'POST', body: { goal: 'hello' },
  });
  check('concierge canAfford false at balance 5',
    cgBroke.status === 200 && cgBroke.data.balance === 5 && cgBroke.data.canAfford === false,
    JSON.stringify(cgBroke.data));
  const cgOutsider = await makeClient().req('/api/conversations/' + convId + '/concierge', {
    method: 'POST', body: { goal: 'hello' },
  });
  check('concierge unauthenticated -> 401', cgOutsider.status === 401, 'got ' + cgOutsider.status);

  // 10. report + block flow
  const rep = await lady.req('/api/users/' + rg.data.user.id + '/report', {
    method: 'POST', body: { reason: 'smoke test report' },
  });
  check('report accepted', rep.status === 200);
  const blk = await lady.req('/api/users/' + rg.data.user.id + '/block', { method: 'POST' });
  check('block accepted', blk.status === 200);
  const disc2 = await lady.req('/api/discover');
  check('blocked user hidden from discover', !(disc2.data.users || []).some((u) => u.id === rg.data.user.id));
  const mBlocked = await lady.req('/api/conversations/' + convId + '/messages', {
    method: 'POST', body: { body: 'should fail' },
  });
  check('messaging blocked peer -> 403', mBlocked.status === 403);

  // 11. logout clears the session
  const lo = await gent.req('/api/auth/logout', { method: 'POST' });
  check('logout returns ok', lo.status === 200);
  const meAfter = await gent.req('/api/me');
  check('logged-out /me -> 401', meAfter.status === 401, 'got ' + meAfter.status);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('smoke test crashed', e);
  process.exit(1);
});
