'use strict';

/* ---------- config ---------- */
const ATLAS_FILE = 'atlas-topology.json';      // graph-v1 run saved next to the game, same origin
const API_TIMEOUT = 2500;
const SIZES = [6, 8, 10];
const QUBITS = { 6: 3, 8: 5, 10: 8 };          // entangled pairs per grid size
const SYMBOLS = 8;
const MAX_SHARE_DIV = 3;                       // no symbol may fill more than 1/3 of the board
const PEEK_MS = 1100;
const WRONG_HOLD_MS = 550;
const WRONG_SHAKE_MS = 420;
const FLY_MS = 750;
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------- small helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates, each index comes from a Hadamard-register measurement (Q.randInt)
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Q.randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function flipMs() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--flip-ms').trim();
  if (raw.endsWith('ms')) return parseFloat(raw) || 550;
  if (raw.endsWith('s')) return (parseFloat(raw) || 0.55) * 1000;
  return 550;
}

/* ---------- sound hooks (stubs, wire your own clips in here later) ---------- */
const A = { muted: false };

// called on the first click of a turn, a good place to unlock an AudioContext or preload clips
function ensureAudio() {}

const sfx = {
  flip() {},
  match() {},
  wrong() {},
  tink() {},
  entangle() {},
  collapse() {},
  win() {}
};

/* ---------- quantum platform controller ---------- */
const Q = {
  samples: [],       // bitstrings from the graph-v1 run, character index = qubit number
  numQubits: 0,
  jobId: '',
  circuits: 0,       // number of small circuits run so far, handy for the demo

  // two-qubit state vector, index = (q1 << 1) | q0
  applyH(s, q) {
    const r = Math.SQRT1_2;
    const out = s.slice();
    for (let i = 0; i < 4; i++) {
      if ((i >> q) & 1) continue;
      const j = i | (1 << q);
      out[i] = (s[i] + s[j]) * r;
      out[j] = (s[i] - s[j]) * r;
    }
    return out;
  },

  applyCNOT(s, c, t) {
    const out = s.slice();
    for (let i = 0; i < 4; i++) {
      if (((i >> c) & 1) && !((i >> t) & 1)) {
        const j = i | (1 << t);
        out[i] = s[j];
        out[j] = s[i];
      }
    }
    return out;
  },

  // |00> -> H on qubit 0 -> CNOT(0,1) gives (|00> + |11>) / sqrt(2)
  bellState() {
    let s = [1, 0, 0, 0];
    s = Q.applyH(s, 0);
    return Q.applyCNOT(s, 0, 1);
  },

  // local fallback: samples the Bell state, the two bits always agree
  bellMeasure(rng) {
    const s = Q.bellState();
    const r = rng();
    let acc = 0;
    for (let i = 0; i < 4; i++) {
      acc += s[i] * s[i];
      if (r < acc) return [i & 1, (i >> 1) & 1];
    }
    return [1, 1];
  },

  // n-qubit state vector in |00...0>, real amplitudes are enough for X, H and CNOT
  zero(n) {
    const s = new Float64Array(1 << n);
    s[0] = 1;
    return s;
  },

  gX(s, q) {
    const m = 1 << q;
    for (let i = 0; i < s.length; i++) {
      if (i & m) continue;
      const j = i | m;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
    }
  },

  gH(s, q) {
    const m = 1 << q;
    const r = Math.SQRT1_2;
    for (let i = 0; i < s.length; i++) {
      if (i & m) continue;
      const j = i | m;
      const a = s[i];
      const b = s[j];
      s[i] = (a + b) * r;
      s[j] = (a - b) * r;
    }
  },

  gCX(s, c, t) {
    const cm = 1 << c;
    const tm = 1 << t;
    for (let i = 0; i < s.length; i++) {
      if (!(i & cm) || (i & tm)) continue;
      const j = i | tm;
      const x = s[i];
      s[i] = s[j];
      s[j] = x;
    }
  },

  // measures every qubit once: basis state i comes out with probability amplitude squared
  sampleAll(s, rng) {
    const r = rng();
    let acc = 0;
    for (let i = 0; i < s.length; i++) {
      acc += s[i] * s[i];
      if (r < acc) return i;
    }
    return s.length - 1;
  },

  // uniform integer in [0, n): Hadamard on k qubits, measure, rerun if the result is out of range
  randInt(rng, n) {
    if (n <= 1) return 0;
    try {
      let k = 1;
      while ((1 << k) < n) k++;
      for (let tries = 0; tries < 64; tries++) {
        const s = Q.zero(k);
        for (let q = 0; q < k; q++) Q.gH(s, q);
        const v = Q.sampleAll(s, rng);
        Q.circuits++;
        if (v < n) return v;
      }
    } catch (err) {
      console.warn('[purble] circuit draw failed, using PRNG:', err && err.message);
    }
    return Math.floor(rng() * n);
  },

  // symbols 1..8 as 3-bit values; CNOTs leave A xor B in the second register, zero means equal
  sameSymbol(a, b) {
    const classical = a === b;
    try {
      const s = Q.zero(6);
      for (let q = 0; q < 3; q++) {
        if (((a - 1) >> q) & 1) Q.gX(s, q);
        if (((b - 1) >> q) & 1) Q.gX(s, q + 3);
      }
      for (let q = 0; q < 3; q++) Q.gCX(s, q, q + 3);
      let at = 0;
      for (let i = 1; i < s.length; i++) if (Math.abs(s[i]) > Math.abs(s[at])) at = i;
      Q.circuits++;
      const quantum = (at >> 3) === 0;
      if (quantum !== classical) {
        console.error('[purble] comparator disagreed with ===, using ===');
        return classical;
      }
      return quantum;
    } catch (err) {
      return classical;
    }
  },

  async fetchJson(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
    try {
      const res = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  // loads the precomputed graph-v1 run that ships next to the game
  async loadSamples() {
    const data = await Q.fetchJson(ATLAS_FILE, { method: 'GET', cache: 'no-store' });
    const nq = Number(data && data.num_qubits);
    const list = (data && Array.isArray(data.samples) ? data.samples : [])
      .filter((s) => typeof s === 'string' && s.length === nq && /^[01]+$/.test(s));
    if (!(nq >= 2) || !list.length) throw new Error('no usable samples in ' + ATLAS_FILE);
    Q.samples = list;
    Q.numQubits = nq;
    Q.jobId = String(data.job_id || '');
  },

  // outcome for one entangled pair slot: the bits of qubits 2*slot and 2*slot+1 from a random shot
  measure(rng, slot) {
    if (Q.samples.length && Number.isInteger(slot) && slot >= 0 && 2 * slot + 1 < Q.numQubits) {
      const s = Q.samples[Q.randInt(rng, Q.samples.length)];
      return [Number(s[2 * slot]), Number(s[2 * slot + 1])];
    }
    return Q.bellMeasure(rng);
  },

  // walks a shuffled index list and pairs each free card with the next free card of another symbol
  localEdges(cards, count, used, rng) {
    const order = shuffle(cards.map((_, i) => i), rng);
    const out = [];
    for (let x = 0; x < order.length && out.length < count; x++) {
      const a = order[x];
      if (used.has(a)) continue;
      for (let y = x + 1; y < order.length; y++) {
        const b = order[y];
        if (used.has(b) || cards[a].sym === cards[b].sym) continue;
        used.add(a);
        used.add(b);
        out.push([a, b]);
        break;
      }
    }
    return out;
  },

  // never throws: samples come from the graph-v1 file when it loads, otherwise the Bell simulation is used
  async getTopology(N, qubits, cards, rng) {
    let source = 'local';
    try {
      await Q.loadSamples();
      source = 'atlas-file';
    } catch (err) {
      console.warn('[purble] graph-v1 file unavailable, using local Bell simulation:', err && err.message);
    }
    const edges = Q.localEdges(cards, qubits, new Set(), rng);
    return { edges, source };
  }
};
/* ---------- game state ---------- */
const G = {
  gid: 0,          // bumped on every new game, stale async work checks it
  N: 6,
  cards: [],
  first: null,     // index of the first card of the current turn
  busy: true,      // click mutex
  over: false,
  turns: 0,
  matched: 0,      // matched pairs so far
  total: 0,        // pairs needed to finish (N * N / 2)
  score: 0,
  combo: 0,
  seed: 0,
  rng: Math.random
};

const alive = (gid) => gid === G.gid;

function setText(sel, val) {
  const el = $(sel);
  if (el) el.textContent = val;
}

function updateUI() {
  setText('#match-counter', G.matched);
  setText('#turn-counter', G.turns);
  setText('#score-counter', G.score);
}

function setFill() {
  const jar = $('#tokenJar');
  if (!jar) return;
  const ratio = G.total ? G.matched / G.total : 0;
  const level = Math.min(3, Math.floor(ratio * 3));
  jar.style.setProperty('--fill', level);
  jar.setAttribute('data-fill', level);
}

function setBadge(source) {
  const labels = {
    connecting: 'Atlas: connecting...',
    'atlas-file': 'Atlas: graph-v1 run',
    local: 'Local Bell simulation'
  };
  document.body.dataset.qsource = source;
  setText('#atlas-status', labels[source] || source);
}

/* ---------- deck building ---------- */
// every symbol gets at least 2 cards, the rest are handed out two at a time to
// symbols that are still under the cap, so counts stay even and sum to total
function allocateCounts(total, rng) {
  const cap = Math.floor(total / (MAX_SHARE_DIV * 2)) * 2;
  const counts = new Array(SYMBOLS).fill(2);
  let spare = (total - SYMBOLS * 2) / 2;
  while (spare > 0) {
    const s = Q.randInt(rng, SYMBOLS);
    if (counts[s] + 2 > cap) continue;
    counts[s] += 2;
    spare--;
  }
  return counts;
}

function buildDeck(N, rng) {
  const total = N * N;
  const counts = allocateCounts(total, rng);
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum !== total || counts.some((c) => c < 2 || c % 2 !== 0)) {
    throw new Error('bad symbol allocation');
  }
  const deck = [];
  counts.forEach((c, s) => {
    for (let k = 0; k < c; k++) deck.push(s + 1);   // symbols are 1..8
  });
  shuffle(deck, rng);
  return { deck, counts };
}

function renderBoard() {
  const grid = $('#purble-card-grid');
  grid.innerHTML = '';
  grid.dataset.size = G.N;
  grid.style.setProperty('--grid-n', G.N);
  grid.style.gridTemplateColumns = 'repeat(' + G.N + ', 1fr)';
  const frag = document.createDocumentFragment();
  G.cards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'purble-card';
    el.dataset.i = i;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML =
      '<div class="purble-card-inner">' +
        '<div class="card-back"></div>' +
        '<div class="card-front"><div class="token-placeholder token-' + c.sym + '"></div></div>' +
      '</div>';
    c.el = el;
    frag.appendChild(el);
  });
  grid.appendChild(frag);
}

/* ---------- card animation ---------- */
function flipUp(card, silent) {
  card.el.classList.add('flipped');
  if (!silent) sfx.flip();
  return sleep(flipMs());
}

function flipDown(card) {
  card.el.classList.remove('flipped');
  return sleep(flipMs());
}

// copies the card into a fixed overlay and animates the copy into the jar,
// so the purple frame's overflow cannot clip it
function flyToJar(card, delay) {
  const jar = $('#tokenJar');
  const el = card.el;
  if (!jar || REDUCED) {
    el.style.visibility = 'hidden';
    return Promise.resolve();
  }
  const r = el.getBoundingClientRect();
  const j = jar.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.classList.remove('wrong', 'matched');
  clone.classList.add('flipped', 'purble-fly');
  Object.assign(clone.style, {
    position: 'fixed',
    left: r.left + 'px',
    top: r.top + 'px',
    width: r.width + 'px',
    height: r.height + 'px',
    margin: '0',
    zIndex: '9999',
    pointerEvents: 'none',
    transform: 'none',
    visibility: 'visible'
  });
  document.body.appendChild(clone);
  el.style.visibility = 'hidden';

  const dx = j.left + j.width / 2 - (r.left + r.width / 2);
  const dy = j.top + j.height * 0.35 - (r.top + r.height / 2);
  const anim = clone.animate([
    { transform: 'translate(0px,0px) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
    {
      transform: 'translate(' + dx * 0.35 + 'px,' + (dy * 0.35 - 60) + 'px) scale(0.8) rotate(-8deg)',
      opacity: 1,
      offset: 0.4
    },
    {
      transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.28) rotate(12deg)',
      opacity: 0.9,
      offset: 1
    }
  ], {
    duration: FLY_MS,
    delay: delay,
    easing: 'cubic-bezier(.45,.05,.55,.95)',
    fill: 'forwards'
  });

  return new Promise((resolve) => {
    const done = () => { clone.remove(); resolve(); };
    anim.onfinish = done;
    anim.oncancel = done;
  });
}

/* ---------- turn logic ---------- */
// an entangled card only triggers the peek while its partner is still face down
function canEntangle(card) {
  return card.ent >= 0 && G.cards[card.ent].state === 0;
}

// first card of a turn is entangled: both cards flip together, show their
// symbols, then flip back. No match is possible on this move.
async function peekTurn(gid, card) {
  const partner = G.cards[card.ent];
  const bits = Q.measure(G.rng, card.slot);
  card.state = partner.state = 1;
  [card, partner].forEach((k) => {
    k.el.classList.add('token-qubit');
    k.el.dataset.qbit = bits[0];
    k.el.dataset.ket = '|' + bits[0] + bits[1] + '>';
  });
  sfx.entangle();
  await Promise.all([flipUp(card, true), flipUp(partner, true)]);
  if (!alive(gid)) return;
  await sleep(PEEK_MS);
  if (!alive(gid)) return;
  sfx.collapse();
  [card, partner].forEach((k) => {
    k.el.classList.remove('token-qubit');
    delete k.el.dataset.qbit;
    delete k.el.dataset.ket;
    k.ent = -1;      // pair has collapsed, both are ordinary cards now
  });
  await Promise.all([flipDown(card), flipDown(partner)]);
  if (!alive(gid)) return;
  card.state = partner.state = 0;
  G.turns++;
  updateUI();
}

async function resolveTurn(gid, ia, ib) {
  const a = G.cards[ia];
  const b = G.cards[ib];
  G.first = null;
  b.state = 1;
  G.turns++;
  updateUI();
  await flipUp(b);
  if (!alive(gid)) return;

  if (Q.sameSymbol(a.sym, b.sym)) {
    a.state = b.state = 2;
    a.ent = b.ent = -1;
    a.el.classList.add('matched');
    b.el.classList.add('matched');
    G.matched++;
    G.combo++;
    G.score += 100 + (G.combo - 1) * 25;
    updateUI();
    sfx.match();
    await sleep(260);
    if (!alive(gid)) return;
    // the flights run on their own so the board stays playable
    Promise.all([
      flyToJar(a, 0).then(() => sfx.tink()),
      flyToJar(b, 110).then(() => sfx.tink())
    ]).then(() => {
      if (!alive(gid)) return;
      setFill();
      if (G.matched === G.total) finishGame();
    });
  } else {
    G.combo = 0;
    await sleep(WRONG_HOLD_MS);
    if (!alive(gid)) return;
    a.el.classList.add('wrong');
    b.el.classList.add('wrong');
    sfx.wrong();
    await sleep(WRONG_SHAKE_MS);
    if (!alive(gid)) return;
    a.el.classList.remove('wrong');
    b.el.classList.remove('wrong');
    await Promise.all([flipDown(a), flipDown(b)]);
    if (!alive(gid)) return;
    a.state = b.state = 0;
  }
}

async function onCard(i) {
  const gid = G.gid;
  if (G.busy || G.over) return;
  const card = G.cards[i];
  if (!card || card.state !== 0) return;
  G.busy = true;
  try {
    ensureAudio();
    if (G.first === null) {
      if (canEntangle(card)) {
        await peekTurn(gid, card);
      } else {
        card.state = 1;
        G.first = i;
        flipUp(card);       // not awaited, the lock is released right away
      }
    } else {
      await resolveTurn(gid, G.first, i);
    }
  } catch (err) {
    console.error('[purble]', err);
  } finally {
    if (alive(gid)) G.busy = false;
  }
}

function finishGame() {
  G.over = true;
  setFill();
  sfx.win();
  const msg = $('#win-message');
  if (msg) {
    msg.hidden = false;
    msg.classList.add('show');
  }
  document.dispatchEvent(new CustomEvent('purble:win', {
    detail: { turns: G.turns, score: G.score, size: G.N, seed: G.seed }
  }));
}

/* ---------- starting a game ---------- */
async function start(size) {
  const N = SIZES.includes(size) ? size : 6;
  const gid = ++G.gid;

  document.querySelectorAll('.purble-fly').forEach((n) => n.remove());
  const msg = $('#win-message');
  if (msg) {
    msg.classList.remove('show');
    msg.hidden = true;
  }

  const urlSeed = new URLSearchParams(location.search).get('seed');
  G.seed = urlSeed !== null && urlSeed !== '' && !isNaN(Number(urlSeed))
    ? Number(urlSeed) >>> 0
    : (Math.random() * 4294967296) >>> 0;
  G.rng = mulberry32(G.seed);

  G.N = N;
  G.first = null;
  G.busy = true;          // locked until the topology is ready
  G.over = false;
  G.turns = 0;
  G.matched = 0;
  G.total = (N * N) / 2;
  G.score = 0;
  G.combo = 0;

  const { deck } = buildDeck(N, G.rng);
  G.cards = deck.map((sym, id) => ({ id, sym, state: 0, ent: -1, slot: -1, el: null }));
  renderBoard();
  updateUI();
  setFill();
  setBadge('connecting');

  const topo = await Q.getTopology(N, QUBITS[N], G.cards, G.rng);
  if (!alive(gid)) return;          // a newer game started while we waited
  topo.edges.forEach(([a, b], k) => {
    G.cards[a].ent = b;
    G.cards[b].ent = a;
    G.cards[a].slot = k;
    G.cards[b].slot = k;
  });
  setBadge(topo.source);
  G.busy = false;
}

/* ---------- wiring ---------- */
function init() {
  const grid = $('#purble-card-grid');
  if (!grid) {
    console.error('[purble] #purble-card-grid not found');
    return;
  }

  grid.addEventListener('click', (e) => {
    const el = e.target.closest('.purble-card');
    if (el && grid.contains(el)) onCard(Number(el.dataset.i));
  });

  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.purble-card');
    if (!el) return;
    e.preventDefault();
    onCard(Number(el.dataset.i));
  });

  document.querySelectorAll('[data-grid]').forEach((btn) => {
    btn.addEventListener('click', () => start(parseInt(btn.dataset.grid, 10)));
  });

  const select = $('#difficulty');
  if (select) select.addEventListener('change', () => start(parseInt(select.value, 10)));

  ['#menuNewGame', '#new-game', '#restart-btn'].forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.addEventListener('click', () => start(G.N));
  });

  const exitBtn = $('#menuExit') || $('#exit-btn') || $('[data-action="exit"]');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      if (window.confirm('Exit this game? The board will restart at 6x6.')) start(6);
    });
  }

  const sound = $('#sound-toggle');
  if (sound) {
    sound.addEventListener('click', () => {
      A.muted = !A.muted;
      sound.classList.toggle('muted', A.muted);
    });
  }

  const initial = select ? parseInt(select.value, 10) : 6;
  start(SIZES.includes(initial) ? initial : 6);
}

window.PurbleGame = {
  start,
  state: G,
  mute(flag) { A.muted = !!flag; }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}