// ============================================================
// Suitor Taste Match — powered by Qloo's taste graph.
//
// The concierge used to guess at date ideas from the bio alone.
// Taste Match grounds them: it reads the interests in both bios,
// resolves them to Qloo entities, and asks Qloo's Insights API
// what places, movies, and music people with that taste actually
// love. Cross-domain affinity is the whole point — the same
// signal that picks the restaurant also picks the film.
//
// Brain: Qloo hackathon API when QLOO_API_KEY is set on the
// server (base URL overridable with QLOO_API_BASE, default
// https://hackathon.api.qloo.com). The key never leaves the
// backend. With no key — or on any API error — it falls back to
// a built-in taste bank so the feature never dead-ends.
//
// Read-only by design, same as the concierge: this module only
// reads public taste data and returns picks. It never sends a
// message, never moves tokens, never touches balances.
// ============================================================

function apiKey() {
  return process.env.QLOO_API_KEY || '';
}

function configured() {
  return !!apiKey();
}

function base() {
  return (process.env.QLOO_API_BASE || 'https://hackathon.api.qloo.com').replace(/\/+$/, '');
}

// ---------- interest extraction ----------
// Keywords we can spot in a bio, mapped to the phrase we hand to
// Qloo search. Order matters: first match wins per family.
const INTERESTS = [
  { key: 'music', re: /\b(music|concert|gig|song|singer|guitar|piano|vinyl|dj|band|rap|jazz|rock|indie)\b/i, term: 'live music', label: 'music' },
  { key: 'film', re: /\b(movie|film|cinema|horror|anime|director|netflix|hulu|a24)\b/i, term: 'film', label: 'film' },
  { key: 'food', re: /\b(food\w*|cook\w*|chef|tacos?|baking|foodie|recipes?|sushi|ramen|pizza|brunch)\b/i, term: 'food', label: 'food' },
  { key: 'coffee', re: /\b(coffee|espresso|latte|cafe|caf\u00e9|barista)\b/i, term: 'coffee', label: 'coffee' },
  { key: 'outdoors', re: /\b(hik\w*|trail|mountain|outdoors|camping|nature|beach|surf\w*|ocean)\b/i, term: 'outdoors', label: 'the outdoors' },
  { key: 'books', re: /\b(book\w*|read\w*|novel|poetry|writer|writing|literature)\b/i, term: 'books', label: 'books' },
  { key: 'art', re: /\b(art|paint\w*|photo\w*|draw\w*|design|gallery|museum)\b/i, term: 'art', label: 'art' },
  { key: 'fitness', re: /\b(gym|run\w*|lift\w*|yoga|fitness|marathon|cycling)\b/i, term: 'fitness', label: 'fitness' },
  { key: 'pets', re: /\b(dog|puppy|pup|cat|kitten|pets?)\b/i, term: 'dogs', label: 'pets' },
  { key: 'travel', re: /\b(travel\w*|trip|road ?trip|wanderlust|passport)\b/i, term: 'travel', label: 'travel' },
];

function extractInterests(bio) {
  if (!bio) return [];
  const found = [];
  for (const i of INTERESTS) if (i.re.test(bio) && !found.includes(i.key)) found.push(i.key);
  return found;
}

// Combine both bios: shared interests first (strongest signal),
// then either side's, capped so the query stays focused.
function combinedInterests(meBio, peerBio) {
  const me = extractInterests(meBio);
  const peer = extractInterests(peerBio);
  const shared = peer.filter((k) => me.includes(k));
  const rest = [...peer, ...me].filter((k) => !shared.includes(k));
  const ordered = [...new Set([...shared, ...rest])].slice(0, 3);
  return { keys: ordered, shared };
}

function interestByKey(key) {
  return INTERESTS.find((i) => i.key === key) || null;
}

// ---------- taste bank (fallback brain) ----------
// One entry per interest family: a place, a screen pick, a sound
// pick, and the one-line date idea the concierge shows. Written
// to feel like taste, not keywords — and shared interests get the
// strongest version via the combined opener in tasteDate().
const BANK = {
  music: {
    place: 'a vinyl listening bar',
    movie: 'a music documentary at the indie theater',
    music: 'neo-soul and 90s R&B on the stereo',
    line: 'Start at a vinyl listening bar, then a late set somewhere small — her taste in music is the whole itinerary.',
  },
  film: {
    place: 'the revival cinema with the good popcorn',
    movie: 'a cult classic on the big screen',
    music: 'the soundtrack, on the drive over',
    line: 'A revival screening at the indie cinema, then drinks somewhere quiet enough to argue about the ending.',
  },
  food: {
    place: 'a taco truck crawl, three stops minimum',
    movie: 'a food film night for round two',
    music: 'whatever the truck is playing — that is the playlist',
    line: 'A taco truck crawl — three stops, ranked as you go. Built-in debate, zero awkward silence.',
  },
  coffee: {
    place: 'the roastery with the tasting flight',
    movie: 'a matinee after, if it is going well',
    music: 'lo-fi and bossa nova, cafe volume',
    line: 'Coffee tasting at the local roastery, then a walk. Caffeine first, chemistry second.',
  },
  outdoors: {
    place: 'a golden-hour viewpoint with a picnic',
    movie: 'a drive-in, under the same sky',
    music: 'acoustic covers on a portable speaker',
    line: 'A late-afternoon trail to a viewpoint, picnic at golden hour. She picked the outdoors — meet her there.',
  },
  books: {
    place: 'the indie bookstore with the reading nook',
    movie: 'an adaptation of a book she loves',
    music: 'quiet jazz in the stacks',
    line: 'Indie bookstore: each of you picks a book for the other, then coffee next door to defend your choices.',
  },
  art: {
    place: 'the small gallery with the late hours',
    movie: 'an art-house film after',
    music: 'whatever the gallery is playing',
    line: 'A small gallery at night, then drinks. Looking at art together does half the talking for you.',
  },
  fitness: {
    place: 'a morning market run, then smoothies',
    movie: 'a sports documentary for next time',
    music: 'her workout playlist — she curates, you keep up',
    line: 'An easy morning hike or run, then the good smoothie place. Active, daylight, zero pressure.',
  },
  pets: {
    place: 'the dog-friendly brewery patio',
    movie: 'a dog movie — there will be tears',
    music: 'easy Sunday-morning stuff',
    line: 'A dog-friendly patio brunch — she brings her favorite plus-one, you bring your best self.',
  },
  travel: {
    place: 'the neighborhood that feels like another country',
    movie: 'a travel film to plan the next one over',
    music: 'a road-trip playlist you build together',
    line: 'Pick the most far-flung-feeling neighborhood nearby and explore it like tourists — food first, no itinerary.',
  },
};

const BANK_DEFAULT = {
  place: 'a speakeasy with a real jukebox',
  movie: 'whatever the indie theater is reviving this week',
  music: 'a playlist you trade song-for-song',
  line: 'A night market wander, then a speakeasy with a jukebox — you learn her taste one quarter at a time.',
};

function bankTaste(keys) {
  const top = keys.length ? BANK[keys[0]] : BANK_DEFAULT;
  return {
    source: 'bank',
    picks: [
      { kind: 'place', name: top.place },
      { kind: 'movie', name: top.movie },
      { kind: 'music', name: top.music },
    ],
    line: top.line,
  };
}

// ---------- Qloo API brain ----------

async function qlooFetch(pathAndQuery, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const res = await fetch(base() + pathAndQuery, {
      signal: ctrl.signal,
      headers: { 'X-Api-Key': apiKey(), accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Qloo responses have worn a few shapes across versions; accept
// the common ones instead of betting on a single schema.
function rowsOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const candidates = [
    data.results,
    data.entities,
    data.data && data.data.results,
    data.data && data.data.entities,
    data.data,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function pickName(row) {
  if (!row || typeof row !== 'object') return '';
  return row.name || row.title || (row.properties && row.properties.name) || '';
}

function pickAffinity(row) {
  const raw =
    row && (row.affinity != null ? row.affinity : row.score != null ? row.score : row.queryAffinity);
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!isFinite(n) || n <= 0) return null;
  return n > 1 ? Math.min(100, Math.round(n)) : Math.round(n * 100);
}

function normalizePick(kind, row) {
  const name = pickName(row);
  if (!name) return null;
  const pick = { kind, name };
  const aff = pickAffinity(row);
  if (aff != null) pick.affinity = aff;
  return pick;
}

async function searchEntityIds(terms) {
  const ids = [];
  for (const term of terms.slice(0, 3)) {
    const data = await qlooFetch(
      '/search?query=' + encodeURIComponent(term) + '&take=3'
    );
    for (const row of rowsOf(data)) {
      const id = row && (row.entity_id || row.id || row.urn);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length >= 6) break;
  }
  return ids.slice(0, 6);
}

async function insights(type, entityIds, take) {
  const params = new URLSearchParams({
    'filter.type': type,
    'signal.interests.entities': entityIds.join(','),
    take: String(take),
  });
  const data = await qlooFetch('/v2/insights?' + params.toString());
  return rowsOf(data);
}

async function apiTaste(keys) {
  const terms = keys.map((k) => (interestByKey(k) || {}).term).filter(Boolean);
  if (!terms.length) return null;
  const ids = await searchEntityIds(terms);
  if (!ids.length) return null;

  const [places, movies, artists] = await Promise.all([
    insights('urn:entity:place', ids, 3),
    insights('urn:entity:movie', ids, 3),
    insights('urn:entity:artist', ids, 3),
  ]);

  const kinds = [
    ['place', places],
    ['movie', movies],
    ['music', artists],
  ];
  const picks = [];
  for (const [kind, rows] of kinds) {
    for (const row of rows) {
      const pick = normalizePick(kind, row);
      if (pick) {
        picks.push(pick);
        break; // top pick per kind is the date plan
      }
    }
  }
  if (!picks.length) return null;

  const place = picks.find((p) => p.kind === 'place');
  const movie = picks.find((p) => p.kind === 'movie');
  const music = picks.find((p) => p.kind === 'music');
  const bits = [];
  if (place) bits.push(place.name);
  if (movie) bits.push('then ' + movie.name);
  if (!place && movie) bits[0] = movie.name;
  if (music && bits.length) bits.push('with ' + music.name + ' setting the mood');
  const line = bits.length
    ? 'Taste-matched for you two: ' + bits.join(', ') + '.'
    : null;
  if (!line) return null;

  return { source: 'qloo', picks, line };
}

// ---------- public entry ----------

// Returns { source: 'qloo'|'bank', picks: [{kind, name, affinity?}], line }.
// interests: { keys: [...], shared: [...] } from combinedInterests.
// Never throws; falls back to the bank on any failure.
async function tasteDate({ meBio, peerBio }) {
  const { keys, shared } = combinedInterests(meBio, peerBio);
  if (configured()) {
    try {
      const api = await apiTaste(keys);
      if (api) {
        api.shared = shared;
        return api;
      }
    } catch (e) {
      /* fall through to the bank */
    }
  }
  const bank = bankTaste(keys);
  bank.shared = shared;
  return bank;
}

module.exports = {
  configured,
  base,
  extractInterests,
  combinedInterests,
  tasteDate,
};
