// ============================================================
// Suitor AI Concierge — draft help, never automation.
//
// Hard rules (the product's promises, enforced by design):
//   * The concierge ONLY drafts. It returns text; the user taps a
//     draft to fill the composer and still has to hit Send.
//   * It never sends a message, never charges tokens, never
//     credits tokens, and never touches PayPal or balances.
//     The only place tokens move is POST /conversations/:id/messages.
//   * Ladies are never credited anything by the concierge (they
//     are unpaid users who chat free); for them it is reply help.
//
// Brain: Google Gemini (free tier) when CONCIERGE_API_KEY (or
// GEMINI_API_KEY) is set on the server. The key never leaves the
// backend. With no key — or on any AI error — it falls back to a
// built-in bank of drafts so the feature never dead-ends.
// ============================================================

const qloo = require('./qloo');

const TONES = ['Smooth', 'Playful', 'Direct'];

const GOALS = {
  hello: {
    label: 'Say hello',
    instruction:
      'Write first messages to someone the user has not talked to yet. Open warm, reference the match\'s bio if it gives you anything real, and end with an easy question.',
  },
  keep_going: {
    label: 'Keep it going',
    instruction:
      'The conversation is alive. Write replies that build on the last exchange, show genuine interest, and move things one step closer to meeting — without rushing.',
  },
  ask_out: {
    label: 'Ask her out',
    instruction:
      'Write messages that confidently invite the match to a real, low-pressure first date (coffee, a walk, tacos). Offer a specific-but-flexible plan. Charming, not pushy; one clear ask.',
  },
  revive: {
    label: 'Revive a quiet thread',
    instruction:
      'The conversation went quiet. Write a light, zero-guilt re-opener — no sulking, no "why didn\'t you reply". One warm nudge, easy to answer.',
  },
};

function apiKey() {
  return process.env.CONCIERGE_API_KEY || process.env.GEMINI_API_KEY || '';
}

function configured() {
  return !!apiKey();
}

function model() {
  return process.env.CONCIERGE_MODEL || 'gemini-2.5-flash';
}

// ---------- text hygiene (same spirit as auth.cleanStr) ----------

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------- built-in bank (fallback brain) ----------

// Bio-topic hooks: if the peer's bio mentions a topic, one draft and
// the date idea key off it — the bank's version of "reading the bio".
const TOPICS = [
  {
    re: /\b(dog|puppy|pup|cat|kitten|pets?)\b/i,
    hello: (p) =>
      'Any bio that mentions a pet gets my attention, ' + p + '. Tell me about yours — and be honest about who really runs the house.',
    idea: 'A dog-friendly patio brunch — relaxed, daytime, and she gets to bring her favorite plus-one.',
  },
  {
    re: /\b(hik\w*|trail|mountain|outdoors|camping|nature)\b/i,
    hello: (p) =>
      'A fellow outdoors person, ' + p + '? Name your favorite trail — and I\'ll tell you mine, then we can argue about which is better.',
    idea: 'A late-afternoon trail walk, then tacos as the sun goes down. Easy to talk, easy to bail if it\'s not clicking — it will be.',
  },
  {
    re: /\b(music|concert|gig|song|singer|guitar|piano|vinyl)\b/i,
    hello: (p) =>
      'Your bio says music matters to you, ' + p + ' — so, important question: what\'s the last song you had on repeat?',
    idea: 'A record store browse, then coffee. Low stakes, and her picks will tell you more than an hour of small talk.',
  },
  {
    re: /\b(coffee|espresso|latte|cafe|caf\u00e9|barista)\b/i,
    hello: (p) =>
      'A coffee person, ' + p + '? Good — first-date planning just got easy. What\'s your usual order?',
    idea: 'Coffee at the good local place, not the chain — then a walk if it\'s going well. It will be.',
  },
  {
    re: /\b(food\w*|cook\w*|chef|tacos?|baking|foodie|recipes?)\b/i,
    hello: (p) =>
      'Careful, ' + p + ' — a bio that mentions food is basically an invitation. What\'s the dish you\'d cook to impress someone?',
    idea: 'A farmers market stroll — tasting as you go, then coffee. Built-in conversation, zero awkward silences.',
  },
  {
    re: /\b(travel\w*|trip|road ?trip|wanderlust|passport|beach)\b/i,
    hello: (p) =>
      'Okay ' + p + ', best trip you\'ve ever taken — and the one still on your list. I\'ll trade you mine.',
    idea: 'Coffee near the water or somewhere with a view — travel people always have a story ready, so just let her tell it.',
  },
  {
    re: /\b(book\w*|read\w*|novel|poetry|writer|writing)\b/i,
    hello: (p) =>
      'A reader, ' + p + '? Dangerous. What\'s the last book you couldn\'t put down?',
    idea: 'Bookstore plus coffee next door. She picks a book she loves, you pick one of yours — you learn each other fast.',
  },
  {
    re: /\b(gym|run\w*|lift\w*|yoga|fitness|marathon|cycling)\b/i,
    hello: (p) =>
      'Respect, ' + p + ' — anyone up early training has their life together more than I do. What are you training for?',
    idea: 'A morning walk or easy hike with coffee after — active, daylight, no pressure.',
  },
  {
    re: /\b(art|paint\w*|photo\w*|draw\w*|design|gallery|museum)\b/i,
    hello: (p) =>
      'Your bio has an artist\'s energy, ' + p + '. What are you working on right now — or dreaming about making?',
    idea: 'A small gallery or museum, then drinks. Looking at art together does half the conversational work for you.',
  },
];

const GENERIC_IDEAS = [
  'Coffee and a walk — simple, daytime, and easy to extend if it\'s going well.',
  'Tacos at the place everyone swears by, then a short stroll. Food first takes the pressure off.',
  'Mini golf or bowling — a little friendly competition melts awkwardness fast.',
  'A farmers market wander with coffee in hand. Built-in things to react to, no forced small talk.',
];

const BANK = {
  hello: (ctx) => {
    const p = ctx.peerName;
    const drafts = [
      { tone: 'Smooth', text: 'Hi ' + p + ' — your bio did what bios are supposed to do: made me want to know more. What\'s the story behind it?' },
      { tone: 'Playful', text: 'Okay ' + p + ', quick test: coffee or cocktails, beach day or city night? Your answers decide our first date.' },
      { tone: 'Direct', text: 'Hi, I\'m ' + ctx.meName + '. I don\'t send a lot of first messages — but you were worth one. How\'s your day going?' },
    ];
    if (ctx.topic) drafts[2] = { tone: 'Direct', text: ctx.topic.hello(p) };
    return drafts;
  },
  keep_going: (ctx) => [
    { tone: 'Smooth', text: 'I\'ll be honest, this is the best conversation I\'ve had on here. What\'s keeping you busy this week, ' + ctx.peerName + '?' },
    { tone: 'Playful', text: 'Two truths and a lie — and if I guess wrong, I owe you a coffee.' },
    { tone: 'Direct', text: 'I\'m enjoying this. Do we keep texting, or start planning to actually meet?' },
  ],
  ask_out: (ctx) => [
    { tone: 'Smooth', text: 'Talking to you here is great, ' + ctx.peerName + ', but I\'d rather hear that laugh in person. Coffee this weekend?' },
    { tone: 'Playful', text: 'You\'ve officially passed the chat test. Final round: drinks, my treat — you pick the place.' },
    { tone: 'Direct', text: ctx.peerName + ', let\'s get coffee. Saturday or Sunday — which works better for you?' },
  ],
  revive: (ctx) => [
    { tone: 'Smooth', text: 'Hey ' + ctx.peerName + ' — this conversation was too good to let it fade. How have you been?' },
    { tone: 'Playful', text: 'Rescuing this chat before it becomes a "whatever happened to…" story. Hi again.' },
    { tone: 'Direct', text: 'I don\'t chase — but I do circle back once for someone worth it. Coffee\'s still on the table.' },
  ],
};

function matchTopic(bio) {
  if (!bio) return null;
  for (const t of TOPICS) if (t.re.test(bio)) return t;
  return null;
}

function bankSuggest(goal, ctx) {
  const drafts = BANK[goal](ctx).map((d) => ({
    tone: d.tone,
    text: cleanText(d.text, 400),
  }));
  const idea = ctx.topic
    ? ctx.topic.idea
    : GENERIC_IDEAS[Math.floor(Math.random() * GENERIC_IDEAS.length)];
  return { drafts, dateIdea: cleanText(idea, 200), source: 'bank' };
}

// ---------- AI brain (Gemini) ----------

function buildPrompt(goal, ctx, recent, hint) {
  const lines = [];
  lines.push(
    'You are the Suitor Concierge, an in-app dating coach inside a chat app for adults (everyone is 18+). ' +
      'You write DRAFT messages for the user to review and send themselves. You never send anything.'
  );
  lines.push('Goal: ' + GOALS[goal].label + '. ' + GOALS[goal].instruction);
  lines.push('');
  lines.push('The user: ' + ctx.meName + ', ' + ctx.meAge + '. Bio: ' + (ctx.meBio || '(none)'));
  lines.push('The match: ' + ctx.peerName + ', ' + ctx.peerAge + '. Bio: ' + (ctx.peerBio || '(none)'));
  if (recent && recent.length) {
    lines.push('');
    lines.push('Recent conversation (oldest first):');
    recent.forEach((m) => lines.push((m.from === 'me' ? 'USER' : 'MATCH') + ': ' + m.text));
  } else {
    lines.push('');
    lines.push('There are no messages yet in this conversation.');
  }
  if (hint) {
    lines.push('');
    lines.push('The user wants to get across: ' + hint + ' (weave it in naturally; do not quote it verbatim).');
  }
  lines.push('');
  lines.push(
    'Write exactly 3 draft messages in the user\'s voice — first person, warm and confident, human. ' +
      'Tones, in this order: Smooth, Playful, Direct. Each draft: at most 280 characters, at most one emoji, ' +
      'no pickup-artist lines, nothing explicit, nothing demeaning, no begging, no guilt trips. ' +
      'Also write one first-date idea (at most 140 characters) that fits the match\'s bio and interests.'
  );
  lines.push(
    'Respond with ONLY this JSON, no markdown fences: {"drafts":[{"tone":"Smooth","text":"..."},{"tone":"Playful","text":"..."},{"tone":"Direct","text":"..."}],"dateIdea":"..."}'
  );
  return lines.join('\n');
}

function parseAiJson(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function normalizeAi(out, ctx) {
  if (!out || !Array.isArray(out.drafts)) return null;
  const drafts = [];
  out.drafts.forEach((d, i) => {
    const text = cleanText(typeof d === 'string' ? d : d && d.text, 400);
    if (!text) return;
    const tone = d && TONES.includes(d.tone) ? d.tone : TONES[Math.min(i, 2)];
    drafts.push({ tone, text });
  });
  if (!drafts.length) return null;
  return {
    drafts: drafts.slice(0, 3),
    dateIdea: cleanText(out.dateIdea, 200) || bankSuggest('hello', ctx).dateIdea,
    source: 'ai',
  };
}

async function aiSuggest(goal, ctx, recent, hint) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model()) +
        ':generateContent',
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey(),
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(goal, ctx, recent, hint) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.9,
            maxOutputTokens: 700,
          },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const parts =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts;
    if (!Array.isArray(parts)) return null;
    const raw = parts.map((p) => p.text || '').join('');
    return normalizeAi(parseAiJson(raw), ctx);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- public entry ----------

// ctx: { me: {name,gender,age,bio}, peer: {name,gender,age,bio} }
// recent: [{ from: 'me'|'them', text }] oldest first, already public-safe.
// Returns { drafts: [{tone, text}], dateIdea, source: 'ai'|'bank' }.
// Never throws; never writes anything anywhere.
async function suggest({ goal, me, peer, recent, hint }) {
  const g = GOALS[goal] ? goal : 'keep_going';
  const ctx = {
    meName: cleanText(me && me.name, 24) || 'me',
    meAge: (me && me.age) || '',
    meBio: cleanText(me && me.bio, 300),
    peerName: cleanText(peer && peer.name, 24) || 'there',
    peerAge: (peer && peer.age) || '',
    peerBio: cleanText(peer && peer.bio, 300),
    topic: matchTopic(peer && peer.bio),
  };
  const cleanRecent = (Array.isArray(recent) ? recent : [])
    .slice(-12)
    .map((m) => ({ from: m.from === 'me' ? 'me' : 'them', text: cleanText(m.text, 300) }))
    .filter((m) => m.text);
  const cleanHint = cleanText(hint, 200);

  let out = null;
  if (configured()) {
    out = await aiSuggest(g, ctx, cleanRecent, cleanHint);
  }
  if (!out) out = bankSuggest(g, ctx);

  // Taste Match (Qloo): for the goals where a date is actually on
  // the table, ground the date idea in both bios' taste. Garnish,
  // never a gate — if it fails for any reason the drafts ship as-is.
  if (g === 'ask_out' || g === 'keep_going') {
    try {
      const taste = await qloo.tasteDate({ meBio: ctx.meBio, peerBio: ctx.peerBio });
      if (taste && taste.line) {
        out = Object.assign({}, out, { dateIdea: taste.line, taste });
      }
    } catch (e) {
      /* taste is garnish; drafts still ship */
    }
  }
  return out;
}

module.exports = { GOALS, TONES, configured, model, suggest };
