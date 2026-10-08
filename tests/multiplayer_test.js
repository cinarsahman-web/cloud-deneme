// Multiplayer test: several real game tabs talk to a mock of the artifact
// `room`, `db` and `user` capabilities that lives in Node, so presence, events,
// shared documents and late joiners can be exercised end to end.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const DIR = process.env.TEST_DIR || __dirname; // needs package/build/three.min.js (three@0.128.0) here
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const marker = '\nrequestAnimationFrame(frame);\nsetTimeout(';
const TEST_FILE = path.join(DIR, 'game_under_test_mp.html');
fs.writeFileSync(TEST_FILE, src.replace(marker, '\nwindow.__ev = (c) => eval(c);' + marker));

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

// ------------------------------------------------------------------ mock server
const store = new Map(); // path -> object
const leases = new Map();
const subs = []; // {page, sid, kind: 'doc'|'col', path, last: Map(id -> json)}
const rooms = new Map(); // name -> Map(page -> {peer, by, presence, updatedAt})
const pageInfo = new Map(); // page -> {peer, uid, name, color}
let peerSeq = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], b[k]); else a[k] = clone(b[k]); } return a; }
async function deliver(page, kind, payload) { try { await page.evaluate(([k, p]) => window.__mockDeliver(k, p), [kind, payload]); } catch (e) { /* page closed */ } }
function colChildren(col) {
  const n = col.split('/').length + 1, out = [];
  for (const [p, d] of store) if (p.startsWith(col + '/') && p.split('/').length === n) out.push([p.split('/').pop(), d]);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function notify() {
  for (const s of subs) {
    if (s.kind === 'doc') {
      const d = store.get(s.path), j = JSON.stringify(d || null);
      if (s.lastDoc === j) continue;
      s.lastDoc = j;
      await deliver(s.page, 'docsnap', { sid: s.sid, id: s.path.split('/').pop(), exists: !!d, data: d || null });
    } else {
      const now = new Map(colChildren(s.path).map(([id, d]) => [id, JSON.stringify(d)]));
      const changes = [];
      for (const [id, j] of now) if (!s.last.has(id)) changes.push({ type: 'added', id, data: JSON.parse(j) }); else if (s.last.get(id) !== j) changes.push({ type: 'modified', id, data: JSON.parse(j) });
      for (const [id, j] of s.last) if (!now.has(id)) changes.push({ type: 'removed', id, data: JSON.parse(j) });
      if (!changes.length && s.sent) continue;
      s.last = now; s.sent = true;
      await deliver(s.page, 'colsnap', { sid: s.sid, docs: [...now].map(([id, j]) => ({ id, data: JSON.parse(j) })), changes });
    }
  }
}
function peersOf(name, forPage) {
  const r = rooms.get(name); if (!r) return [];
  return [...r].map(([pg, v]) => ({ peer: v.peer, by: v.by, isMe: pg === forPage, sameTab: pg === forPage, kind: 'viewer', guest: false, presence: v.presence, updatedAt: v.updatedAt }));
}
async function pushPeers(name, change) {
  const r = rooms.get(name); if (!r) return;
  for (const pg of r.keys()) await deliver(pg, 'peers', { room: name, peers: peersOf(name, pg), change });
}
async function mockCall(source, op, a) {
  const page = source.page, me = pageInfo.get(page);
  switch (op) {
    case 'user.id': return me.uid;
    case 'user.profiles': { const out = {}; for (const id of a.ids) { const p = [...pageInfo.values()].find((x) => x.uid === id); out[id] = { id, name: p ? p.name : '', color: p ? p.color : '#888888', avatarUrl: '', email: null, isMe: id === me.uid, guest: false }; } return out; }
    case 'db.get': { const d = store.get(a.path); return { exists: !!d, data: d ? clone(d) : null }; }
    case 'db.set': store.set(a.path, clone(a.data)); setTimeout(notify, 30); return true;
    case 'db.update': { const d = store.get(a.path); if (!d) return { error: 'invalid_argument' }; deepMerge(d, a.data); setTimeout(notify, 30); return true; }
    case 'db.delete': store.delete(a.path); setTimeout(notify, 30); return true;
    case 'db.acquire': { const l = leases.get(a.path); const now = Date.now(); if (l && l.until > now && l.holder !== a.holder) return { acquired: false }; leases.set(a.path, { holder: a.holder, until: now + (a.ttlMs || 30000) }); return { acquired: true, holder: a.holder }; }
    case 'db.sub': subs.push({ page, sid: a.sid, kind: a.kind, path: a.path, last: new Map(), sent: false, lastDoc: undefined }); setTimeout(notify, 30); return true;
    case 'db.unsub': { const i = subs.findIndex((s) => s.page === page && s.sid === a.sid); if (i >= 0) subs.splice(i, 1); return true; }
    case 'room.join': { if (!rooms.has(a.room)) rooms.set(a.room, new Map()); const r = rooms.get(a.room); if (!r.has(page)) { r.set(page, { peer: me.peer, by: me.uid, presence: {}, updatedAt: Date.now() }); const p = peersOf(a.room, null).find((x) => x.peer === me.peer); setTimeout(() => pushPeers(a.room, { joined: [p], left: [], updated: [] }), 20); } return { peer: me.peer }; }
    case 'room.leave': { const r = rooms.get(a.room); if (r && r.has(page)) { const v = r.get(page); r.delete(page); await pushPeers(a.room, { joined: [], left: [{ peer: v.peer, by: v.by, kind: 'viewer', isMe: false, sameTab: false, guest: false, presence: v.presence }], updated: [] }); } return true; }
    case 'room.presence': { const r = rooms.get(a.room); if (!r || !r.has(page)) return true; const v = r.get(page); v.presence = { ...v.presence, ...a.patch }; v.updatedAt = Date.now(); setTimeout(() => pushPeers(a.room, { joined: [], left: [], updated: [] }), 10); return true; }
    case 'room.emit': {
      const r = rooms.get(a.room); if (!r) return true;
      if (pageInfo.get(page).readOnly) return { error: 'not_permitted' };
      for (const pg of r.keys()) deliver(pg, 'msg', { room: a.room, topic: a.topic, data: a.data, peer: me.peer, by: me.uid, isMe: pg === page, sameTab: pg === page, kind: 'viewer', guest: false });
      return true;
    }
  }
  return { error: 'invalid_argument' };
}
const MOCK_CLIENT = () => {
  const call = async (op, a) => { const r = await window.__mockCall(op, a || {}); if (r && r.error) throw { code: r.error, message: r.error }; return r; };
  const handlers = { doc: new Map(), col: new Map(), msg: [], peers: [] };
  const peersCache = new Map();
  let sid = 0;
  const snapDoc = (id, exists, data) => ({ id, exists, data: () => (exists ? data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  window.__mockDeliver = (kind, p) => {
    if (kind === 'docsnap') { const h = handlers.doc.get(p.sid); if (h) h(snapDoc(p.id, p.exists, p.data)); }
    else if (kind === 'colsnap') { const h = handlers.col.get(p.sid); if (h) { const docs = p.docs.map((d) => snapDoc(d.id, true, d.data)); h({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => p.changes.map((c) => ({ type: c.type, doc: snapDoc(c.id, true, c.data), oldIndex: -1, newIndex: -1 })) }); } }
    else if (kind === 'msg') { for (const h of handlers.msg) if (h.room === p.room && h.topic === p.topic) h.fn(p); }
    else if (kind === 'peers') { peersCache.set(p.room, p.peers); for (const h of handlers.peers) if (h.room === p.room) h.fn({ peers: p.peers, joined: p.change.joined.map((x) => ({ ...x, isMe: x.peer === (p.peers.find((q) => q.sameTab) || {}).peer })), left: p.change.left, updated: p.change.updated }); }
  };
  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => { const r = await call('db.get', { path }); return snapDoc(path.split('/').pop(), r.exists, r.data); },
    set: (data) => call('db.set', { path, data }),
    update: (data) => call('db.update', { path, data }),
    delete: () => call('db.delete', { path }),
    acquire: (o) => call('db.acquire', { path, holder: o.holder, ttlMs: o.ttlMs }),
    onSnapshot: (next) => { const id = ++sid; handlers.doc.set(id, next); call('db.sub', { sid: id, kind: 'doc', path }); return () => { handlers.doc.delete(id); call('db.unsub', { sid: id }); }; },
    collection: (sub) => colRef(path + '/' + sub),
  });
  const colRef = (path) => ({
    path, doc: (id) => docRef(path + '/' + id),
    onSnapshot: (next) => { const id = ++sid; handlers.col.set(id, next); call('db.sub', { sid: id, kind: 'col', path }); return () => { handlers.col.delete(id); call('db.unsub', { sid: id }); }; },
  });
  const named = (room) => ({
    name: room,
    emit: (topic, data) => call('room.emit', { room, topic, data }),
    on: (topic, fn) => { const h = { room, topic, fn }; handlers.msg.push(h); return () => { const i = handlers.msg.indexOf(h); if (i >= 0) handlers.msg.splice(i, 1); }; },
    presence: (patch) => call('room.presence', { room, patch }),
    peers: () => peersCache.get(room) || [],
    onPeers: (fn) => { const h = { room, fn }; handlers.peers.push(h); return () => { const i = handlers.peers.indexOf(h); if (i >= 0) handlers.peers.splice(i, 1); }; },
    connected: () => true,
    leave: () => call('room.leave', { room }),
  });
  const ns = {
    room: { join: async (name) => { await call('room.join', { room: name }); return named(name); } },
    db: { doc: docRef, collection: colRef },
    user: { id: () => call('user.id'), profiles: (ids) => call('user.profiles', { ids: [].concat(ids) }), canEdit: async () => true, isOwner: async () => false, can: async () => true, me: async () => ({}) },
  };
  window.claude = { use: async (n) => (window.__noCaps ? null : ns[n] || null) };
};

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.exposeBinding('__mockCall', (source, op, a) => mockCall(source, op, a));
  const errors = [];
  async function openPlayer(name, uid, color, opts = {}) {
    const page = await context.newPage();
    pageInfo.set(page, { peer: 'peer' + (++peerSeq) + 'x', uid, name, color, readOnly: !!opts.readOnly });
    page.on('pageerror', (e) => errors.push(name + ': ' + (e.stack || e)));
    await page.addInitScript(MOCK_CLIENT);
    await page.addInitScript((noCaps) => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('x')); }; if (noCaps) window.__noCaps = true; }, !!opts.noCaps);
    await page.route('**/three.min.js', (r) => r.fulfill({ path: path.join(DIR, 'package/build/three.min.js'), contentType: 'application/javascript' }));
    await page.route('https://fonts.**', (r) => r.abort());
    await page.goto('file://' + TEST_FILE);
    await page.waitForFunction(() => window.__ev && window.__ev('state') === 'menu', null, { timeout: 30000 });
    return page;
  }
  const ev = (p, code) => p.evaluate((c) => window.__ev(c), code);
  async function join(page, code) {
    await page.fill('#mpCode', code);
    await page.click('#mpJoin');
    await page.waitForFunction(() => window.__ev("!!mp && state === 'playing'"), null, { timeout: 30000 });
    await page.waitForFunction(() => window.__ev('!pendingSpawn && chunkReadyAt(player.pos.x, player.pos.z)'), null, { timeout: 30000 });
    await page.waitForTimeout(800);
  }

  // ---------------- single player first, so we can check it is preserved
  const A = await openPlayer('Ayşe', 'u_ayse', '#e0603a');
  await A.click('#play');
  await A.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 30000 });
  const singleSeed = await ev(A, 'seed');
  await ev(A, 'pause(); true');

  // ---------------- join
  await join(A, 'Test Dünya!');
  let r = await ev(A, `({ code: mp.code, seed, label: document.getElementById('seedLbl').textContent, plist: !document.getElementById('plist').hidden })`);
  check('Join', 'world name is cleaned to a safe code', r.code === 'testdnya' || r.code === 'testdunya', r.code);
  const code = r.code;
  check('Join', 'first player creates the shared world in db (seed, clock, spawn)', store.has('worlds/' + code) && Number.isFinite(store.get('worlds/' + code).seed) && store.get('worlds/' + code).seed === r.seed, JSON.stringify(store.get('worlds/' + code)));
  check('Join', 'shared world uses a different seed than the single-player world', r.seed !== singleSeed);
  check('Join', 'menu label and player list switch to online mode', /Çevrimiçi/.test(r.label) && r.plist, r.label);

  const B = await openPlayer('Mehmet', 'u_mehmet', '#3a7be0');
  await join(B, code);
  r = await ev(B, 'seed');
  check('Join', 'second player gets the same seed', r === store.get('worlds/' + code).seed, r);
  await A.waitForTimeout(3500);
  const seesA = await ev(B, '[...remotes.values()].map((r) => ({ name: r.name, x: r.pos && r.pos.x }))');
  const seesB = await ev(A, '[...remotes.values()].map((r) => ({ name: r.name }))');
  check('Presence', 'each player sees the other as an avatar', seesA.length === 1 && seesB.length === 1, JSON.stringify({ seesA, seesB }));
  check('Presence', 'name tags come from the user profile', seesA[0] && seesA[0].name === 'Ayşe' && seesB[0] && seesB[0].name === 'Mehmet', JSON.stringify([seesA, seesB]));
  r = await A.textContent('#chatLog');
  check('Presence', 'join is announced in chat', /Mehmet oyuna katıldı/.test(r), r);
  r = await A.textContent('#plist');
  check('Presence', 'player list shows both players', /2 oyuncu/.test(r) && /Mehmet/.test(r) && /Ayşe \(sen\)/.test(r), r);

  // movement sync
  const posA = await ev(A, `(() => { player.pos.x += 3; player.yaw = 1.2; return { x: player.pos.x, z: player.pos.z }; })()`);
  await B.waitForTimeout(2500);
  const posA2 = await ev(A, '({ x: player.pos.x, z: player.pos.z })');
  r = await ev(B, `(() => { const r = [...remotes.values()].find((v) => v.name === 'Ayşe'); return { x: r.pos.x, z: r.pos.z, yaw: r.yaw }; })()`);
  check('Presence', 'movement and facing are synced', Math.abs(r.x - posA2.x) < 0.3 && Math.abs(r.z - posA2.z) < 0.3 && Math.abs(r.yaw - 1.2) < 0.25, JSON.stringify({ posA: posA2, seen: r }));

  // ---------------- block edits
  const spot = await ev(A, `(() => { const x = Math.floor(player.pos.x) + 2, z = Math.floor(player.pos.z); let y = H - 2; while (y > 0 && !DEF[getB(x, y, z)].solid) y--; y++; setBlock(x, y, z, B.BRICK); setBlock(x, y + 1, z, B.GLASS); return { x, y, z }; })()`);
  await B.waitForTimeout(400);
  r = await ev(B, `[getB(${spot.x}, ${spot.y}, ${spot.z}), getB(${spot.x}, ${spot.y + 1}, ${spot.z})]`);
  check('Blocks', 'placed blocks appear for the other player within 0.4 s', r[0] === 11 && r[1] === 10, JSON.stringify(r));
  await A.waitForTimeout(800);
  const chunkDoc = store.get(`worlds/${code}/chunks/${spot.x >> 4}_${spot.z >> 4}`);
  check('Blocks', 'edits are saved to the shared db (per-chunk document)', chunkDoc && Object.values(chunkDoc.e).includes(11), JSON.stringify(chunkDoc && Object.keys(chunkDoc.e).length) + ' edits in doc');
  await ev(B, `setBlock(${spot.x}, ${spot.y + 1}, ${spot.z}, B.AIR); true`);
  await A.waitForTimeout(400);
  r = await ev(A, `getB(${spot.x}, ${spot.y + 1}, ${spot.z})`);
  check('Blocks', 'breaking works both ways', r === 0, r);
  // burst of edits (TNT-like)
  await ev(A, `(() => { for (let i = 0; i < 40; i++) setBlock(${spot.x} + (i % 8), ${spot.y + 3}, ${spot.z} + ((i / 8) | 0), B.WOOL); return true; })()`);
  await A.waitForTimeout(1500);
  r = await ev(B, `(() => { let n = 0; for (let i = 0; i < 40; i++) if (getB(${spot.x} + (i % 8), ${spot.y + 3}, ${spot.z} + ((i / 8) | 0)) === B.WOOL) n++; return n; })()`);
  check('Blocks', 'a burst of 40 edits arrives complete', r === 40, `${r}/40`);
  // late joiner
  const C = await openPlayer('Zeynep', 'u_zeynep', '#3ab07a');
  await join(C, code);
  await C.waitForTimeout(1500);
  r = await ev(C, `(() => { let n = 0; for (let i = 0; i < 40; i++) if (getB(${spot.x} + (i % 8), ${spot.y + 3}, ${spot.z} + ((i / 8) | 0)) === B.WOOL) n++; return { n, brick: getB(${spot.x}, ${spot.y}, ${spot.z}), glass: getB(${spot.x}, ${spot.y + 1}, ${spot.z}), remotes: remotes.size }; })()`);
  check('Blocks', 'a late joiner sees every earlier edit (from db)', r.n === 40 && r.brick === 11 && r.glass === 0, JSON.stringify(r));
  check('Presence', 'third player sees both others', r.remotes === 2, r.remotes);
  // untrusted event data is validated
  r = await ev(B, `(() => { const before = getB(${spot.x}, ${spot.y + 5}, ${spot.z}); onRemoteBlk({ sameTab: false, data: { x: ${spot.x}, y: ${spot.y + 5}, z: ${spot.z}, id: 255 } }); onRemoteBlk({ sameTab: false, data: { x: 'a', y: 1, z: 1, id: 3 } }); onRemoteBlk({ sameTab: false, data: { x: ${spot.x}, y: 999, z: ${spot.z}, id: 3 } }); return [before, getB(${spot.x}, ${spot.y + 5}, ${spot.z})]; })()`);
  check('Safety', 'bad block events (unknown id, non-numbers, out of range) are ignored', r[0] === r[1], JSON.stringify(r));

  // ---------------- chat
  await A.keyboard.press('KeyT');
  await A.waitForTimeout(200);
  r = await ev(A, 'state');
  check('Chat', 'T opens the chat box', r === 'chat' && await A.isVisible('#chatBox'));
  await A.keyboard.type('Merhaba <b>herkes</b>!');
  await A.keyboard.press('Enter');
  await B.waitForTimeout(500);
  r = await B.evaluate(() => { const ps = [...document.querySelectorAll('#chatLog p')]; const last = ps[ps.length - 1]; return { text: last.textContent, html: last.innerHTML, bold: !!last.querySelector('b') }; });
  check('Chat', 'message reaches the other player with the sender name', /^Ayşe/.test(r.text) && r.text.includes('Merhaba <b>herkes</b>!'), r.text);
  check('Safety', 'chat text is shown as text, not HTML', !r.bold, r.html);
  r = await ev(A, 'state');
  check('Chat', 'sending returns to the game', r === 'playing');

  // ---------------- PvP
  const bp = await ev(B, `({ x: player.pos.x, y: player.pos.y, z: player.pos.z })`);
  await ev(A, `(() => { player.pos = { x: ${bp.x} - 2, y: ${bp.y}, z: ${bp.z} }; mode = 'survival'; return true; })()`);
  await ev(B, `(() => { player.hp = 20; player.invuln = 0; player.regenT = 0; setMode('survival'); return true; })()`);
  await A.waitForTimeout(1200);
  r = await ev(A, `(() => { while (mobs.length) removeMob(mobs[0]); attackCd = 0; target = null; const r = [...remotes.entries()].find(([k, v]) => v.name === 'Mehmet')[1];
    camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z); camera.lookAt(r.pos.x, r.pos.y + 1.0, r.pos.z); camera.updateMatrixWorld();
    inv[slot] = { id: toolId(SWORD, 2), n: 1, d: 250 }; return attackMob(); })()`);
  await B.waitForTimeout(500);
  const bhp = await ev(B, 'player.hp');
  check('PvP', 'hitting another player with an iron sword deals 6 damage', r === true && bhp === 14, `hit ${r}, Mehmet hp ${bhp}`);
  await ev(B, `(() => { setMode('creative'); return true; })()`);
  await A.waitForTimeout(800);
  const hpBefore = await ev(B, 'player.hp');
  r = await ev(A, `(() => { while (mobs.length) removeMob(mobs[0]); attackCd = 0; const r = [...remotes.values()].find((v) => v.name === 'Mehmet'); camera.lookAt(r.pos.x, r.pos.y + 1.0, r.pos.z); camera.updateMatrixWorld(); attackMob(); return { creative: r.creative }; })()`);
  await B.waitForTimeout(800);
  const hpAfter = await ev(B, 'player.hp');
  check('PvP', 'players in creative mode cannot be hurt', r.creative === true && hpAfter === hpBefore, JSON.stringify({ ...r, hpBefore, hpAfter }));
  await ev(B, `setMode('survival'); player.hp = 20; true`);
  r = await ev(B, `(() => { const me = mp.room.peers().find((p) => p.sameTab); player.invuln = 0; const hp = player.hp; onHit({ sameTab: false, data: { to: 'someone-else', dmg: 5 } }); onHit({ sameTab: false, data: { to: me.peer, dmg: 999 } }); return { before: hp, after: player.hp }; })()`);
  check('Safety', 'hit events for others are ignored and damage is capped at 8', r.before - r.after === 8, JSON.stringify(r));
  await ev(B, `player.hp = 20; player.invuln = 0; true`);

  // ---------------- chests
  const cs = await ev(A, `(() => { const x = Math.floor(player.pos.x), z = Math.floor(player.pos.z) + 2; let y = H - 2; while (y > 0 && !DEF[getB(x, y, z)].solid) y--; y++; setBlock(x, y, z, B.CHEST);
    target = { x, y, z, px: x, py: y + 1, pz: z, id: B.CHEST, dist: 2 }; inv[0] = { id: I.DIAMOND, n: 7, d: 0 }; slot = 0; invChanged(); useAction(); return { x, y, z, state }; })()`);
  await A.keyboard.down('Shift'); await A.click('#bar .slot:nth-child(1)'); await A.keyboard.up('Shift');
  await A.keyboard.press('KeyE');
  await A.waitForTimeout(1200);
  r = await ev(B, `(() => { const c = chests.get('${cs.x},${cs.y},${cs.z}'); return c ? c.filter(Boolean).map((s) => s.id + 'x' + s.n) : null; })()`);
  check('Chests', 'chest contents are shared', JSON.stringify(r) === '["103x7"]', JSON.stringify(r));
  // B takes them out
  await ev(B, `(() => { target = { x: ${cs.x}, y: ${cs.y}, z: ${cs.z}, px: ${cs.x}, py: ${cs.y + 1}, pz: ${cs.z}, id: B.CHEST, dist: 2 }; inv.fill(null); invChanged(); useAction(); return state; })()`);
  await B.keyboard.down('Shift'); await B.click('#chestGrid .slot:nth-child(1)'); await B.keyboard.up('Shift');
  await B.keyboard.press('KeyE');
  await B.waitForFunction(() => window.__ev('mp.chestPend.size === 0'), null, { timeout: 10000 });
  await A.waitForTimeout(1500);
  r = await ev(A, `(() => { const c = chests.get('${cs.x},${cs.y},${cs.z}'); return c ? c.filter(Boolean).length : -1; })()`);
  const bDia = await ev(B, 'countItem(I.DIAMOND)');
  check('Chests', 'taking items out is visible to the other player', r === 0 && bDia === 7, JSON.stringify({ aSeesItems: r, bDiamonds: bDia }));

  // ---------------- clock and sleep
  r = await Promise.all([ev(A, 'dayT'), ev(B, 'dayT'), ev(C, 'dayT')]);
  check('Time', 'all players share the same time of day', Math.max(...r) - Math.min(...r) < 0.002, JSON.stringify(r.map((x) => x.toFixed(4))));
  r = await Promise.all([ev(A, 'rain'), ev(B, 'rain'), ev(C, 'rain')]);
  check('Time', 'all players share the same weather', r[0] === r[1] && r[1] === r[2], JSON.stringify(r));
  // make it night for everyone, then A sleeps
  store.get('worlds/' + code).t0 = Date.now() / 1000 - 600 * 0.75; await notify();
  await B.waitForTimeout(600);
  r = await ev(B, 'dayT');
  check('Time', 'clock changes in db reach everyone', Math.abs(r - 0.75) < 0.01, r.toFixed(3));
  const bed = await ev(A, `(() => { while (mobs.length) removeMob(mobs[0]); const x = Math.floor(player.pos.x) + 1, z = Math.floor(player.pos.z) - 2; let y = H - 2; while (y > 0 && !DEF[getB(x, y, z)].solid) y--; y++; setBlock(x, y, z, B.BED); sleepInBed({ x, y, z }); return { x, y, z, sleeping }; })()`);
  await A.waitForTimeout(3500);
  r = await Promise.all([ev(A, 'dayT'), ev(B, 'dayT'), ev(C, 'dayT')]);
  check('Time', 'sleeping at night makes it morning for everyone', r.every((x) => x < 0.05), JSON.stringify(r.map((x) => x.toFixed(3))));

  // screenshot: B looks at A and C
  await ev(A, `(() => { const p = ${JSON.stringify(bp)}; player.pos = { x: p.x + 3, y: p.y, z: p.z - 4 }; player.yaw = 0.6; return true; })()`);
  await ev(C, `(() => { const p = ${JSON.stringify(bp)}; player.pos = { x: p.x - 2, y: p.y, z: p.z - 5 }; return true; })()`);
  await ev(B, `(() => { player.yaw = 0; player.pitch = -0.05; infoOn = false; document.getElementById('info').hidden = true; return true; })()`);
  await B.waitForTimeout(2000);
  await B.screenshot({ path: path.join(SHOTS, 'mp-01-two-players.png') });
  await A.keyboard.press('KeyT'); await A.keyboard.type('Buradayız!'); await A.keyboard.press('Enter');
  await B.waitForTimeout(600);
  r = await B.evaluate(() => { const ps = [...document.querySelectorAll('#chatLog p')]; return ps[ps.length - 1].textContent; });
  check('Chat', 'typing right after T loses no letters', r === 'AyşeBuradayız!', r);
  await B.screenshot({ path: path.join(SHOTS, 'mp-02-chat.png') });

  // ---------------- leave and rejoin
  await ev(A, "setMode('creative'); player.fly = true; player.vel = { x: 0, y: 0, z: 0 }; true");
  const aPos = await ev(A, '({ x: player.pos.x, z: player.pos.z })');
  await ev(A, 'pause(); true');
  await A.click('#mpLeave');
  await A.waitForTimeout(800);
  r = await ev(A, `({ mp: !!mp, seed, remotes: remotes.size, label: document.getElementById('seedLbl').textContent })`);
  check('Leave', 'leaving returns to the single-player world', !r.mp && r.seed === singleSeed && r.remotes === 0, JSON.stringify(r));
  await B.waitForTimeout(800);
  r = await ev(B, `({ names: [...remotes.values()].map((r) => r.name), chat: document.getElementById('chatLog').textContent })`);
  check('Leave', 'others see the player leave', !r.names.includes('Ayşe') && /Ayşe ayrıldı/.test(r.chat), JSON.stringify(r.names));
  await join(A, code);
  r = await ev(A, '({ x: player.pos.x, z: player.pos.z, mode })');
  check('Leave', 'rejoining restores position and game mode in the shared world', Math.abs(r.x - aPos.x) < 0.5 && Math.abs(r.z - aPos.z) < 0.5 && r.mode === 'creative', JSON.stringify({ before: aPos, after: r }));

  // ---------------- capability missing
  const D = await openPlayer('Misafir', null, '#999', { noCaps: true });
  await D.click('#mpJoin');
  await D.waitForTimeout(1500);
  r = await D.textContent('#mpNote');
  check('Fallback', 'without room/db the join button explains why', /claude\.ai/.test(r) && !(await ev(D, '!!mp')), r);
  // read-only viewer: emits refused
  const E = await openPlayer('İzleyici', 'u_view', '#999', { readOnly: true });
  await join(E, code);
  await E.keyboard.press('KeyT');
  await E.waitForFunction(() => document.activeElement && document.activeElement.id === 'chatInput', null, { timeout: 5000 });
  await E.keyboard.type('selam');
  await E.keyboard.press('Enter');
  await E.waitForFunction(() => /iznin yok/.test(document.getElementById('chatLog').textContent), null, { timeout: 5000 }).catch(() => {});
  r = await E.textContent('#chatLog');
  check('Fallback', 'a viewer without send rights gets a clear chat message', /iznin yok/.test(r), r.slice(-60));

  // ---------------- phone layout
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.exposeBinding('__mockCall', (source, op, a) => mockCall(source, op, a));
  const P = await phone.newPage();
  pageInfo.set(P, { peer: 'peerphone', uid: 'u_phone', name: 'Telefon', color: '#c0c' });
  await P.addInitScript(MOCK_CLIENT);
  await P.route('**/three.min.js', (rt) => rt.fulfill({ path: path.join(DIR, 'package/build/three.min.js'), contentType: 'application/javascript' }));
  await P.route('https://fonts.**', (rt) => rt.abort());
  await P.goto('file://' + TEST_FILE);
  await P.waitForFunction(() => window.__ev && window.__ev('state') === 'menu', null, { timeout: 30000 });
  await P.screenshot({ path: path.join(SHOTS, 'mp-03-phone-menu.png') });
  await P.fill('#mpCode', code); await P.tap('#mpJoin');
  await P.waitForFunction(() => window.__ev("!!mp && state === 'playing'"), null, { timeout: 30000 });
  await P.waitForTimeout(1500);
  r = await P.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, chatBtn: !document.getElementById('tChat').hidden }));
  check('Mobile', 'phone layout fits and shows a chat button', !r.overflow && r.chatBtn, JSON.stringify(r));
  await P.tap('#tChat'); await P.waitForTimeout(300);
  await P.screenshot({ path: path.join(SHOTS, 'mp-04-phone-chat.png') });

  check('Runtime', 'no JavaScript errors in any tab', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
