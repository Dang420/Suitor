// Taste Match (Qloo) tests — plain node, no server boot.
// Covers: interest extraction, bank fallback, live API path against
// a local stub of the Qloo hackathon API, API-failure fallback,
// and the concierge integration (taste attached on date goals only).
const http = require('http');
const assert = require('assert');

const qloo = require('../src/qloo');
const concierge = require('../src/concierge');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name, '\n    ', e.message);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('taste tests');

  // ---- interest extraction ----
  check('extracts interests from a bio', () => {
    const got = qloo.extractInterests('Vinyl collector, taco enthusiast, weekend hiker.');
    assert.ok(got.includes('music'), 'music');
    assert.ok(got.includes('food'), 'food');
    assert.ok(got.includes('outdoors'), 'outdoors');
  });
  check('shared interests come first', () => {
    const { keys, shared } = qloo.combinedInterests('I love hiking and books', 'books and coffee');
    assert.deepStrictEqual(shared, ['books']);
    assert.strictEqual(keys[0], 'books');
  });

  // ---- bank fallback (no key) ----
  delete process.env.QLOO_API_KEY;
  const bank = await qloo.tasteDate({ meBio: 'into vinyl and live music', peerBio: 'music is my life' });
  check('bank mode without a key', () => {
    assert.strictEqual(bank.source, 'bank');
    assert.strictEqual(bank.picks.length, 3);
    assert.ok(/vinyl listening bar/.test(bank.line + JSON.stringify(bank.picks)));
  });
  const bankDefault = await qloo.tasteDate({ meBio: '', peerBio: 'just here to chat' });
  check('bank default when no interests read', () => {
    assert.strictEqual(bankDefault.source, 'bank');
    assert.ok(bankDefault.line.length > 10);
  });

  // ---- live API path against a stub ----
  const stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-api-key'] !== 'test-key') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'bad key' }));
    }
    if (u.pathname === '/search') {
      return res.end(JSON.stringify({ results: [{ entity_id: 'e-music', name: 'Live Music' }] }));
    }
    if (u.pathname === '/v2/insights') {
      const type = u.searchParams.get('filter.type');
      const table = {
        'urn:entity:place': [{ name: 'Velvet Taco', affinity: 0.92 }],
        'urn:entity:movie': [{ name: 'Midnight in Paris', affinity: 0.81 }],
        'urn:entity:artist': [{ name: 'Khruangbin', affinity: 0.77 }],
      };
      return res.end(JSON.stringify({ results: table[type] || [] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  process.env.QLOO_API_KEY = 'test-key';
  process.env.QLOO_API_BASE = 'http://127.0.0.1:' + port;
  const live = await qloo.tasteDate({ meBio: 'vinyl and gigs', peerBio: 'live music always' });
  check('api mode returns qloo picks with affinity', () => {
    assert.strictEqual(live.source, 'qloo');
    const place = live.picks.find((p) => p.kind === 'place');
    assert.strictEqual(place.name, 'Velvet Taco');
    assert.strictEqual(place.affinity, 92);
    assert.ok(/Velvet Taco/.test(live.line));
    assert.ok(/Khruangbin/.test(live.line));
  });

  // ---- API failure falls back to bank ----
  process.env.QLOO_API_BASE = 'http://127.0.0.1:1'; // dead port
  const fell = await qloo.tasteDate({ meBio: 'vinyl', peerBio: 'music' });
  check('api failure falls back to bank', () => {
    assert.strictEqual(fell.source, 'bank');
  });

  // ---- concierge integration ----
  delete process.env.QLOO_API_KEY;
  delete process.env.QLOO_API_BASE;
  delete process.env.CONCIERGE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const me = { name: 'Donny', age: 30, bio: 'vinyl collector, live music' };
  const peer = { name: 'Ana', age: 28, bio: 'concerts and long talks' };
  const out = await concierge.suggest({ goal: 'ask_out', me, peer, recent: [], hint: '' });
  check('ask_out carries a taste match', () => {
    assert.ok(out.taste, 'taste present');
    assert.strictEqual(out.dateIdea, out.taste.line);
    assert.strictEqual(out.drafts.length, 3);
  });
  const revive = await concierge.suggest({ goal: 'revive', me, peer, recent: [], hint: '' });
  check('revive has no taste garnish', () => {
    assert.ok(!revive.taste);
  });

  stub.close();
  console.log(passed + ' checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
