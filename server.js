// ============================================================================
// Bible Truth Detectives — real-time multiplayer server (Node + ws, no frameworks)
// Asymmetric roles: 1 Detective + Storytellers. The app secretly deals each
// storyteller a version card (exactly ONE true); the detective listens and
// accuses WHO told the true story. Truth-themed, kid-friendly, ages 8+.
// Run:  node server.js   (PORT env, default 8080)
// Test: DETERMINISTIC=1 ACCUSE_SEC=4 REVEAL_WAIT_SEC=2 DRUMROLL_MS=150 node test-sim.js
// ============================================================================
const WebSocket = require('ws');
const CASES = require('./cases.json');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ACCUSE_SEC = parseInt(process.env.ACCUSE_SEC || '20', 10);
const REVEAL_WAIT_SEC = parseInt(process.env.REVEAL_WAIT_SEC || '12', 10);
const DRUMROLL_MS = parseInt(process.env.DRUMROLL_MS || '700', 10);
const DETERMINISTIC = process.env.DETERMINISTIC === '1';
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // A-Z minus I,O

const CELEBRATION_VERSE = {
  ref: { en: 'John 8:32', pt: 'João 8:32' },
  text: {
    en: 'You will know the truth, and the truth will make you free.',
    pt: 'Conhecereis a verdade, e a verdade vos libertará.'
  }
};

const TIERS = {
  1: { en: 'Level 1 · Easy 😊', pt: 'Nível 1 · Fácil 😊' },
  2: { en: 'Level 2 · Medium 🙂', pt: 'Nível 2 · Médio 🙂' },
  3: { en: 'Level 3 · Hard 🔥', pt: 'Nível 3 · Difícil 🔥' },
  4: { en: 'Level 4 · Very Hard 🧠', pt: 'Nível 4 · Muito Difícil 🧠' },
  5: { en: 'Level 5 · Master 👑', pt: 'Nível 5 · Mestre 👑' }
};

function rankFor(sessionPoints) {
  if (sessionPoints >= 1200) return { en: 'Master Truth Detective', pt: 'Mestre Detetive da Verdade' };
  if (sessionPoints >= 600) return { en: 'Detective', pt: 'Detetive' };
  if (sessionPoints >= 200) return { en: 'Investigator', pt: 'Investigador' };
  return { en: 'Truth Apprentice', pt: 'Aprendiz da Verdade' };
}

// --- RNG (seeded when DETERMINISTIC=1 for tests) ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = DETERMINISTIC ? mulberry32(20261019) : Math.random;
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function randInt(n) { return Math.floor(rng() * n); }
function uid() {
  return randInt(0xffffffff).toString(16).padStart(8, '0') + randInt(0xffffffff).toString(16).padStart(8, '0');
}

// --- rooms ---
const rooms = new Map(); // code -> room

function makeCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[randInt(CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('could not make room code');
}

function cleanName(raw) {
  let n = String(raw == null ? '' : raw).trim().slice(0, 16);
  return n.length ? n : 'Player';
}
function dedupeName(room, base) {
  const taken = new Set([...room.players.values()].map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = `${base} ${i}`.slice(0, 16);
    if (!taken.has(cand)) return cand;
  }
  return base + ' ' + uid().slice(0, 4);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, obj);
  }
}
function lobbyPlayers(room) {
  return [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(p => ({ id: p.id, name: p.name, sessionPoints: p.sessionPoints, rank: rankFor(p.sessionPoints) }));
}
function sendLobby(room) {
  broadcast(room, { t: 'lobby', code: room.code, players: lobbyPlayers(room), hostId: room.hostId });
}
function sendError(ws, msg) { send(ws, { t: 'error', msg }); }

function clearTimers(room) {
  for (const k of ['accuse', 'tick', 'reveal', 'drum']) {
    if (room.timers[k]) { clearTimeout(room.timers[k]); clearInterval(room.timers[k]); room.timers[k] = null; }
  }
}
function connectedPlayers(room) {
  return [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
}

// --- case picking: round n (1-based) -> tier min(n,5), random within tier, no repeats ---
function pickCase(room) {
  const n = room.match.roundIdx + 1;
  const want = Math.min(n, 5);
  const unused = id => !room.match.usedCaseIds.has(id);
  const tiersToTry = [want];
  for (let d = 1; d < 5; d++) { if (want - d >= 1) tiersToTry.push(want - d); if (want + d <= 5) tiersToTry.push(want + d); }
  for (const t of tiersToTry) {
    const pool = CASES.filter(c => c.difficulty === t && unused(c.id));
    if (pool.length) {
      const c = pool[randInt(pool.length)];
      room.match.usedCaseIds.add(c.id);
      return c;
    }
  }
  // absolute fallback (shouldn't happen: 12 cases >= 8 rounds)
  const rest = CASES.filter(c => unused(c.id));
  const c = rest[randInt(rest.length)];
  room.match.usedCaseIds.add(c.id);
  return c;
}

// ============================ match flow ============================
function handleStart(ws) {
  const room = ws._room, me = ws._player;
  if (!room || !me) return;
  if (room.state !== 'lobby') return sendError(ws, 'Game already started.');
  if (room.hostId !== me.id) return sendError(ws, 'Only the host can start the game.');
  const n = room.players.size;
  if (n < MIN_PLAYERS) return sendError(ws, `Need at least ${MIN_PLAYERS} players to start.`);
  if (n > MAX_PLAYERS) return sendError(ws, `Room is full (max ${MAX_PLAYERS}).`);
  startMatch(room);
}

function startMatch(room) {
  for (const p of room.players.values()) p.matchPoints = 0; // streaks & sessionPoints persist
  const order = connectedPlayers(room);
  room.match = {
    roundsTotal: order.length, // everyone is detective exactly once
    roundIdx: 0,
    usedCaseIds: new Set(),
    // shuffled queue => round-1 detective is random, then everyone gets exactly one turn
    detectiveQueue: shuffle(order.map(p => p.id)),
    round: null
  };
  startRound(room);
}

function startRound(room) {
  clearTimers(room);
  const m = room.match;
  const order = connectedPlayers(room);
  if (order.length < 2) return abortMatch(room, 'Not enough players left.');
  const c = pickCase(room);
  const tier = c.difficulty;
  // next detective: first still-connected player in the queue (everyone gets exactly one turn)
  let detectiveId = null;
  while (m.detectiveQueue.length) {
    const cand = m.detectiveQueue.shift();
    if (room.players.has(cand)) { detectiveId = cand; break; }
  }
  if (!detectiveId) {
    // edge: queue exhausted (mid-match disconnects) -> refill with connected players
    const rest = shuffle(connectedPlayers(room).map(p => p.id));
    detectiveId = rest[0];
  }
  if (!detectiveId) return abortMatch(room, 'Not enough players left.');
  const detective = room.players.get(detectiveId);

  // deal secret cards: exactly ONE storyteller gets the true version
  const tellerIds = shuffle(order.filter(p => p.id !== detectiveId).map(p => p.id));
  const trueIdx = c.correctIndex;
  const falseIdxs = shuffle([0, 1, 2, 3].filter(i => i !== trueIdx));
  const truthTellerPos = randInt(tellerIds.length);
  const tellers = tellerIds.map((id, pos) => ({
    id,
    cardIdx: pos === truthTellerPos ? trueIdx : falseIdxs[pos % falseIdxs.length],
    done: false,
    active: true
  }));
  const truthHolderId = tellerIds[truthTellerPos];

  m.round = {
    n: m.roundIdx + 1, of: m.roundsTotal, tier, case: c,
    detectiveId, truthHolderId, tellers,
    order: tellerIds, ptr: 0,
    accusedId: null, accuseStart: 0,
    satOut: []
  };
  room.state = 'story';

  broadcast(room, {
    t: 'round', n: m.round.n, of: m.round.of, caseId: c.id,
    tier, tierName: TIERS[tier],
    caseTitle: c.title, intro: c.intro,
    detectiveId, detectiveName: detective.name, hostId: room.hostId
  });
  // private deals
  for (const t of tellers) {
    const p = room.players.get(t.id);
    if (p) send(p.ws, { t: 'yourCard', version: c.versions[t.cardIdx].text });
  }
  const dp = room.players.get(detectiveId);
  if (dp) send(dp.ws, { t: 'youAreDetective' });

  broadcast(room, { t: 'storyOrder', order: tellerIds.map(id => ({ id, name: room.players.get(id).name })) });
  sendStoryTurn(room);
}

function activeTellers(round) { return round.tellers.filter(t => t.active); }

function sendStoryTurn(room) {
  const r = room.match.round;
  const act = activeTellers(r).filter(t => !t.done);
  if (!act.length) return startAccuse(room);
  // telling order follows r.order
  const next = r.order.map(id => act.find(t => t.id === id)).find(Boolean);
  r.ptr = r.order.indexOf(next.id);
  const p = room.players.get(next.id);
  broadcast(room, { t: 'storyTurn', id: next.id, name: p ? p.name : '?', idx: act.indexOf(next) + 1, of: act.length });
}

function handleStoryDone(ws) {
  const room = ws._room, me = ws._player;
  if (!room || !me || room.state !== 'story') return;
  const r = room.match.round;
  const current = r.order.map(id => activeTellers(r).find(t => t.id === id && !t.done)).find(Boolean);
  if (!current || current.id !== me.id) return sendError(ws, 'Not your turn to tell.');
  current.done = true;
  broadcast(room, { t: 'storyTold', id: me.id, name: me.name });
  sendStoryTurn(room);
}

function startAccuse(room) {
  const r = room.match.round;
  room.state = 'accuse';
  clearTimers(room);
  r.accuseStart = Date.now();
  const det = room.players.get(r.detectiveId);
  const tellers = activeTellers(r).map(t => ({ id: t.id, name: room.players.get(t.id).name }));
  if (det) send(det.ws, { t: 'accuseNow', storytellers: tellers, timeSec: ACCUSE_SEC });
  broadcast(room, { t: 'detectiveThinking', detectiveId: r.detectiveId, detectiveName: det ? det.name : '?' }, r.detectiveId);
  let secLeft = ACCUSE_SEC;
  room.timers.tick = setInterval(() => {
    secLeft -= 1;
    if (secLeft <= 0) { clearInterval(room.timers.tick); room.timers.tick = null; return; }
    broadcast(room, { t: 'tick', secLeft, phase: 'accuse' });
  }, 1000);
  room.timers.accuse = setTimeout(() => accuseTimeout(room), ACCUSE_SEC * 1000);
}

function handleAccuse(ws, suspectId) {
  const room = ws._room, me = ws._player;
  if (!room || !me || room.state !== 'accuse') return;
  const r = room.match.round;
  if (me.id !== r.detectiveId) return sendError(ws, 'Only the detective can accuse.');
  if (!activeTellers(r).some(t => t.id === suspectId)) return sendError(ws, 'Pick someone who told a story.');
  r.accusedId = suspectId;
  startDrumroll(room);
}

function accuseTimeout(room) {
  if (room.state !== 'accuse') return;
  room.match.round.accusedId = null; // counts as wrong
  startDrumroll(room);
}

function startDrumroll(room) {
  room.state = 'drumroll';
  clearTimers(room);
  let n = 3;
  broadcast(room, { t: 'drumroll', n });
  room.timers.drum = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(room.timers.drum); room.timers.drum = null; doReveal(room); return; }
    broadcast(room, { t: 'drumroll', n });
  }, DRUMROLL_MS);
}

function doReveal(room) {
  const r = room.match.round;
  room.state = 'reveal';
  clearTimers(room);
  const tier = r.tier;
  const truthP = room.players.get(r.truthHolderId);
  const truthActive = truthP && activeTellers(r).some(t => t.id === r.truthHolderId);
  const correct = !!r.accusedId && r.accusedId === r.truthHolderId && truthActive;
  const det = room.players.get(r.detectiveId);
  const elapsedSec = Math.min(ACCUSE_SEC, (Date.now() - r.accuseStart) / 1000);

  // --- scoring ---
  const gained = new Map(); // id -> points this round
  if (det) {
    if (correct) {
      const newStreak = det.streak + 1;
      const streakBonus = newStreak === 2 ? 25 : newStreak >= 3 ? 50 : 0;
      const speedBonus = Math.max(0, Math.round(100 * (1 - elapsedSec / ACCUSE_SEC)));
      const pts = 100 * tier + speedBonus + streakBonus;
      det.streak = newStreak;
      det.matchPoints += pts; det.sessionPoints += pts;
      gained.set(det.id, pts);
    } else { det.streak = 0; det.matchPoints += 0; gained.set(det.id, 0); }
  }
  for (const t of activeTellers(r)) {
    const p = room.players.get(t.id);
    if (!p) continue;
    let pts = 10; // participation
    if (t.id === r.truthHolderId && correct) pts += 25 * tier; // truth-holder found bonus
    p.matchPoints += pts; p.sessionPoints += pts;
    gained.set(t.id, pts);
  }

  // blooper reel: distinct FALSE versions actually told
  const seen = new Set();
  const bloopers = [];
  for (const t of r.tellers) {
    if (!t.active || !t.done || t.cardIdx === r.case.correctIndex || seen.has(t.cardIdx)) continue;
    seen.add(t.cardIdx);
    const by = r.tellers.filter(x => x.cardIdx === t.cardIdx && x.active && x.done)
      .map(x => { const p = room.players.get(x.id); return p ? p.name : '?'; });
    bloopers.push({ by, detail: r.case.versions[t.cardIdx].blooper });
  }

  const accusedP = r.accusedId ? room.players.get(r.accusedId) : null;
  const roundScores = connectedPlayers(room).map(p => ({
    id: p.id, name: p.name,
    role: p.id === r.detectiveId ? 'detective' : 'storyteller',
    points: gained.get(p.id) || 0, total: p.matchPoints,
    streak: p.streak, rank: rankFor(p.sessionPoints)
  }));
  const leaderboard = connectedPlayers(room)
    .map(p => ({ id: p.id, name: p.name, total: p.matchPoints, rank: rankFor(p.sessionPoints) }))
    .sort((a, b) => b.total - a.total);

  broadcast(room, {
    t: 'reveal',
    correct, accusedId: r.accusedId, accusedName: accusedP ? accusedP.name : null,
    truthHolderId: r.truthHolderId,
    truthHolderName: truthP ? truthP.name : '?', truthHolderLeft: !truthActive,
    correctVersion: r.case.versions[r.case.correctIndex].text,
    bloopers, verse: r.case.verse, note: r.case.note,
    roundScores, leaderboard,
    satOut: r.satOut.map(s => ({ name: s.name, reason: s.reason })),
    hostId: room.hostId
  });

  // auto-advance countdown (host 'next' skips)
  let secLeft = REVEAL_WAIT_SEC;
  room.timers.tick = setInterval(() => {
    secLeft -= 1;
    if (secLeft <= 0) { clearInterval(room.timers.tick); room.timers.tick = null; return; }
    broadcast(room, { t: 'tick', secLeft, phase: 'reveal' });
  }, 1000);
  room.timers.reveal = setTimeout(() => nextRound(room), REVEAL_WAIT_SEC * 1000);
}

function nextRound(room) {
  if (room.state !== 'reveal') return;
  room.match.roundIdx += 1;
  if (room.match.roundIdx >= room.match.roundsTotal) return doFinal(room);
  startRound(room);
}

function handleNext(ws) {
  const room = ws._room, me = ws._player;
  if (!room || !me || room.state !== 'reveal') return;
  if (room.hostId !== me.id) return sendError(ws, 'Only the host can skip.');
  clearTimers(room);
  nextRound(room);
}

function doFinal(room) {
  room.state = 'final';
  clearTimers(room);
  const order = connectedPlayers(room);
  const standings = order
    .map(p => ({ id: p.id, name: p.name, total: p.matchPoints, rank: rankFor(p.sessionPoints), streak: p.streak, joinedAt: p.joinedAt }))
    .sort((a, b) => b.total - a.total || b.streak - a.streak || a.joinedAt - b.joinedAt)
    .map(({ joinedAt, ...s }) => s);
  const w = standings[0];
  broadcast(room, {
    t: 'final', standings,
    winnerId: w ? w.id : null, winnerName: w ? w.name : null,
    celebrationVerse: CELEBRATION_VERSE, hostId: room.hostId
  });
}

function handlePlayAgain(ws) {
  const room = ws._room, me = ws._player;
  if (!room || !me || room.state !== 'final') return;
  if (room.hostId !== me.id) return sendError(ws, 'Only the host can start a rematch.');
  startMatch(room); // matchPoints reset; streaks + sessionPoints persist
}

function abortMatch(room, reason) {
  clearTimers(room);
  room.state = 'lobby';
  room.match = null;
  broadcast(room, { t: 'matchAborted', reason: { en: reason, pt: 'Jogadores insuficientes — partida encerrada.' } });
  sendLobby(room);
}

// ============================ disconnects ============================
function handleDisconnect(ws) {
  const room = ws._room, me = ws._player;
  if (!room || !me) return;
  ws._room = null; ws._player = null;
  room.players.delete(me.id);
  room.joinOrder = room.joinOrder.filter(id => id !== me.id);

  if (room.players.size === 0) { rooms.delete(room.code); return; }

  // host migration -> longest-joined player
  if (room.hostId === me.id) {
    const next = connectedPlayers(room)[0];
    room.hostId = next.id;
    if (room.state === 'lobby') sendLobby(room);
    else broadcast(room, { t: 'hostChanged', hostId: room.hostId, hostName: next.name });
  } else if (room.state === 'lobby') sendLobby(room);

  if (!room.match || room.state === 'final') return;

  const r = room.match.round;
  if (me.id === r.detectiveId) {
    // promote longest-joined storyteller to detective; void their card
    const cands = activeTellers(r).map(t => room.players.get(t.id)).filter(Boolean)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (!cands.length) return abortMatch(room, 'Not enough players left.');
    const np = cands[0];
    const t = r.tellers.find(x => x.id === np.id);
    if (t) { t.active = false; }
    r.satOut.push({ name: me.name, reason: { en: 'left the room', pt: 'saiu da sala' } });
    r.detectiveId = np.id;
    r.order = r.order.filter(id => id !== np.id);
    broadcast(room, { t: 'detectiveChanged', detectiveId: np.id, detectiveName: np.name });
    send(np.ws, { t: 'youAreDetective' });
    if (room.state === 'story') { sendStoryTurn(room); return; }
    if (room.state === 'accuse' || room.state === 'drumroll') { startAccuse(room); return; }
  } else {
    const t = r.tellers.find(x => x.id === me.id);
    if (t && t.active) {
      t.active = false;
      r.satOut.push({ name: me.name, reason: { en: 'left the room', pt: 'saiu da sala' } });
      r.order = r.order.filter(id => id !== me.id);
      if (room.state === 'story') sendStoryTurn(room); // skips them / may advance to accuse
    }
  }
  if (connectedPlayers(room).length < 2) abortMatch(room, 'Not enough players left.');
}

// ============================ wire-up ============================
function handleCreate(ws, name) {
  if (ws._room) return sendError(ws, 'Already in a room.');
  const code = makeCode();
  const id = uid();
  const room = {
    code, hostId: id, players: new Map(), joinOrder: [id],
    state: 'lobby', match: null,
    timers: { accuse: null, tick: null, reveal: null, drum: null }
  };
  const player = { id, name: cleanName(name).slice(0, 16) || 'Player', ws, sessionPoints: 0, matchPoints: 0, streak: 0, joinedAt: Date.now() };
  // name is unique trivially (first player); still normalize length
  player.name = cleanName(name);
  room.players.set(id, player);
  rooms.set(code, room);
  ws._room = room; ws._player = player;
  send(ws, { t: 'created', code, playerId: id });
  sendLobby(room);
}

function handleJoin(ws, code, name) {
  if (ws._room) return sendError(ws, 'Already in a room.');
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return sendError(ws, 'Room not found. Check the code! 🔍');
  if (room.state !== 'lobby') return sendError(ws, 'Game already started — ask the host for the next one!');
  if (room.players.size >= MAX_PLAYERS) return sendError(ws, 'Room is full!');
  const id = uid();
  const player = { id, name: dedupeName(room, cleanName(name)), ws, sessionPoints: 0, matchPoints: 0, streak: 0, joinedAt: Date.now() };
  room.players.set(id, player);
  room.joinOrder.push(id);
  ws._room = room; ws._player = player;
  send(ws, { t: 'joined', code: room.code, playerId: id });
  sendLobby(room);
}

function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return sendError(ws, 'Hmm, bad message.'); }
  if (!m || typeof m.t !== 'string') return sendError(ws, 'Hmm, bad message.');
  switch (m.t) {
    case 'create': return handleCreate(ws, m.name);
    case 'join': return handleJoin(ws, m.code, m.name);
    case 'start': return handleStart(ws);
    case 'storyDone': return handleStoryDone(ws);
    case 'accuse': return handleAccuse(ws, m.suspectId);
    case 'next': return handleNext(ws);
    case 'playAgain': return handlePlayAgain(ws);
    default: return sendError(ws, 'Unknown message.');
  }
}

function createServer(port) {
  const wss = new WebSocket.Server({ port });
  wss.on('connection', ws => {
    ws._room = null; ws._player = null;
    ws.on('message', raw => { try { onMessage(ws, raw); } catch (e) { sendError(ws, 'Oops, something hiccuped.'); } });
    ws.on('close', () => { try { handleDisconnect(ws); } catch (e) { /* noop */ } });
    ws.on('error', () => {});
  });
  wss.on('error', () => {});
  return {
    wss,
    close: () => new Promise(res => {
      for (const [, room] of rooms) clearTimers(room);
      rooms.clear();
      // terminate (don't wait for polite close handshakes) so tests/shutdown are snappy
      wss.clients.forEach(c => { try { c.terminate(); } catch {} });
      wss.close(() => res());
      setTimeout(res, 1500); // safety: never hang shutdown
    })
  };
}

if (require.main === module) {
  const { wss } = createServer(PORT);
  wss.on('listening', () => console.log(`🕵️ Bible Truth Detectives server on ws://localhost:${PORT}`));
}

module.exports = { createServer, rankFor, TIERS, CELEBRATION_VERSE, CASES };
