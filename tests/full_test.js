// Full feature test for the last two feature batches of Blok Diyarı.
// Runs a test-only copy of index.html with a debug eval hook injected inside the game closure.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const DIR = process.env.TEST_DIR || __dirname; // needs package/build/three.min.js (three@0.128.0) here
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const marker = '\nrequestAnimationFrame(frame);\nsetTimeout(';
if (!src.includes(marker)) throw new Error('injection marker not found');
const testHtml = src.replace(marker, '\nwindow.__ev = (c) => eval(c);' + marker);
const TEST_FILE = path.join(DIR, 'game_under_test.html');
fs.writeFileSync(TEST_FILE, testHtml);

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];

  async function openGame(data, opts = {}) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p.on('pageerror', (e) => errors.push('PAGEERR ' + (e.stack || e)));
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
    await p.addInitScript(([d, keepStorage]) => {
      HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('no lock in test')); };
      if (!keepStorage) { try { localStorage.clear(); } catch (e) {} }
      if (d) window.claude = { hot: { data: d } };
    }, [data || null, !!opts.keepStorage]);
    await p.route('**/three.min.js', (r) => r.fulfill({ path: path.join(DIR, 'package/build/three.min.js'), contentType: 'application/javascript' }));
    await p.route('https://fonts.**', (r) => r.abort());
    await p.goto('file://' + TEST_FILE);
    await p.waitForFunction(() => window.__ev && window.__ev("state") === 'menu', null, { timeout: 30000 });
    await p.click('#play');
    await p.waitForFunction(() => window.__ev("!pendingSpawn && chunkReadyAt(player.pos.x, player.pos.z)"), null, { timeout: 30000 });
    await p.waitForTimeout(1500);
    return p;
  }
  const evOn = (p) => (code) => p.evaluate((c) => window.__ev(c), code);

  // ------------------------------------------------------------------ main world
  const page = await openGame({ seed: 777, t: 0.25, mode: 'survival', rain: false, rainTimer: 9999, pos: null });
  const ev = evOn(page);
  await ev(`window.TT = {
    clearMobs() { while (mobs.length) removeMob(mobs[0]); while (drops.length) { const d = drops.pop(); scene.remove(d.obj); } },
    give(list) { inv.fill(null); armor[0] = null; list.forEach(([id, n], i) => { inv[i] = { id, n, d: hasDur(id) ? ITEM[id].dur : 0 }; }); slot = 0; invChanged(); },
    hold(id) { const i = inv.findIndex((s) => s && s.id === id); slot = i; invChanged(); return i; },
    tgt(x, y, z, face) { const f = face || [0, 1, 0]; target = { x, y, z, px: x + f[0], py: y + f[1], pz: z + f[2], id: getB(x, y, z), dist: 2 }; return target; },
    rnd(v) { TT._r = TT._r || Math.random; Math.random = () => v; },
    unrnd() { if (TT._r) Math.random = TT._r; },
    dropsOf(id) { return drops.filter((d) => d.id === id).reduce((a, d) => a + d.n, 0); },
    toastText() { return document.getElementById('toast').textContent; },
    reset() { player.hp = 20; player.hunger = 20; player.sat = 5; player.air = 15; player.invuln = 0; player.fire = 0; player.regenT = 0; player.dead = false; player.vel = { x: 0, y: 0, z: 0 }; }
  }; true`);

  // build a flat stone arena around the player
  const A = await ev(`(() => { const x = Math.floor(player.pos.x), y = Math.floor(player.pos.y), z = Math.floor(player.pos.z);
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) { setBlock(x + dx, y - 1, z + dz, B.STONE); setBlock(x + dx, y - 2, z + dz, B.STONE); for (let dy = 0; dy <= 6; dy++) setBlock(x + dx, y + dy, z + dz, B.AIR); }
    player.pos = { x: x + 0.5, y, z: z + 0.5 }; return { x, y, z }; })()`);
  await page.waitForTimeout(2500);
  console.log('arena at', A);
  const at = (dx, dy, dz) => `${A.x + dx}, ${A.y + dy}, ${A.z + dz}`;

  // ================================================================ BATCH 1
  // ---------------- creeper
  await ev(`TT.clearMobs(); TT.reset(); mode = 'survival'; dayT = 0.25; rain = false; rainLevel = 0; updateSky(false); state = 'playing'; true`);
  let r = await ev(`(() => { spawnMob('creeper', ${A.x + 2.5}, ${A.y}, ${A.z + 0.5}); const m = mobs[mobs.length - 1];
    const fuses = []; for (let i = 0; i < 20; i++) { updateMobs(0.05); fuses.push(+m.fuse.toFixed(2)); }
    return { w: m.w, h: m.h, hp: m.hp, fuseAfter1s: m.fuse, alive: mobs.includes(m), hiss: m.hiss, scale: m.g.scale.x }; })()`);
  check('Creeper', 'model and stats (w 0.3, h 1.7, 20 hp)', r.w === 0.3 && r.h === 1.7 && r.hp === 20, JSON.stringify({ w: r.w, h: r.h, hp: r.hp }));
  check('Creeper', 'fuse starts when player is within 3 blocks', r.fuseAfter1s > 0.5 && r.hiss, `fuse after 1s = ${r.fuseAfter1s.toFixed(2)}`);
  check('Creeper', 'swells while fusing', r.scale > 1.0, `scale ${r.scale.toFixed(3)}`);
  r = await ev(`(() => { const hp0 = player.hp; const floorBefore = getB(${at(2, -1, 0)});
    let steps = 0; while (mobs.some((m) => m.type === 'creeper') && steps < 200) { updateMobs(0.05); steps++; }
    return { exploded: !mobs.some((m) => m.type === 'creeper'), t: steps * 0.05, hp0, hp: player.hp, floorBefore, floorAfter: getB(${at(2, -1, 0)}), drops: drops.length }; })()`);
  check('Creeper', 'explodes about 1.5 s after fuse starts', r.exploded && r.t < 1.5, `exploded after ${r.t.toFixed(2)} s more`);
  check('Creeper', 'explosion damages the player', r.hp < r.hp0, `hp ${r.hp0} → ${r.hp}`);
  check('Creeper', 'explosion destroys blocks', r.floorBefore === 3 && r.floorAfter === 0, `floor ${r.floorBefore} → ${r.floorAfter}`);
  await ev(`TT.reset(); true`);
  // fuse cancel
  r = await ev(`(() => { TT.clearMobs(); spawnMob('creeper', ${A.x + 2.5}, ${A.y}, ${A.z + 0.5}); const m = mobs[0];
    for (let i = 0; i < 12; i++) updateMobs(0.05); const f1 = m.fuse;
    player.pos.x += 12; for (let i = 0; i < 30; i++) updateMobs(0.05); const f2 = m.fuse; const alive = mobs.includes(m);
    player.pos.x -= 12; TT.clearMobs(); return { f1, f2, alive }; })()`);
  check('Creeper', 'fuse cancels when the player runs away', r.f1 > 0.3 && r.f2 === 0 && r.alive, `fuse ${r.f1.toFixed(2)} → ${r.f2.toFixed(2)}, alive ${r.alive}`);
  // drops gunpowder
  r = await ev(`(() => { TT.clearMobs(); spawnMob('creeper', ${A.x + 4.5}, ${A.y}, ${A.z + 4.5}); TT.rnd(0.9); killMob(mobs[0]); TT.unrnd(); const g = TT.dropsOf(I.GUNPOWDER); TT.clearMobs(); return g; })()`);
  check('Creeper', 'drops gunpowder when killed', r === 2, `gunpowder dropped: ${r}`);
  // daylight: zombie burns, creeper does not
  r = await ev(`(() => { TT.clearMobs(); player.dead = true; dayT = 0.25; rain = false; rainLevel = 0; updateSky(false);
    spawnMob('zombie', ${A.x - 4.5}, ${A.y}, ${A.z - 4.5}); spawnMob('creeper', ${A.x + 4.5}, ${A.y}, ${A.z - 4.5});
    for (let i = 0; i < 60; i++) updateMobs(0.05);
    const z = mobs.find((m) => m.type === 'zombie'), c = mobs.find((m) => m.type === 'creeper');
    const res = { zhp: z ? z.hp : 'dead', chp: c ? c.hp : 'dead', daylight }; player.dead = false; TT.clearMobs(); return res; })()`);
  check('Creeper', 'does not burn in daylight (zombie does)', r.chp === 20 && (r.zhp === 'dead' || r.zhp < 20), `zombie hp ${r.zhp}, creeper hp ${r.chp}, daylight ${r.daylight.toFixed(2)}`);

  // ---------------- sheep
  r = await ev(`(() => { TT.clearMobs(); spawnMob('sheep', ${A.x + 3.5}, ${A.y}, ${A.z + 3.5}); const m = mobs[0]; const st = { w: m.w, h: m.h, hp: m.hp, hostile: isHostile(m) };
    hitMob(m, 1); st.flee = m.flee; TT.rnd(0.9); killMob(m); TT.unrnd(); st.wool = TT.dropsOf(B.WOOL); TT.clearMobs(); return st; })()`);
  check('Sheep', 'passive mob with 8 hp', r.hp === 8 && !r.hostile, JSON.stringify(r));
  check('Sheep', 'flees when hit', r.flee > 0, `flee timer ${r.flee}`);
  check('Sheep', 'drops wool when killed', r.wool === 2, `wool dropped: ${r.wool}`);
  r = await ev(`(() => { const ok = isBlock(B.WOOL) && DEF[B.WOOL].solid && TB.full[B.WOOL] === 1; setBlock(${at(5, 0, 5)}, B.WOOL); const placed = getB(${at(5, 0, 5)}); setBlock(${at(5, 0, 5)}, B.AIR); return { ok, placed }; })()`);
  check('Sheep', 'wool is a solid placeable block', r.ok && r.placed === 26, JSON.stringify(r));

  // ---------------- natural spawning
  r = await ev(`(() => { TT.clearMobs(); const cnt = { zombie: 0, creeper: 0, pig: 0, sheep: 0 };
    dayT = 0.75; updateSky(false);
    for (let i = 0; i < 600; i++) { spawnT = 0; spawnTick(0.1); while (mobs.length) { cnt[mobs[0].type]++; removeMob(mobs[0]); } }
    const night = { ...cnt }; Object.keys(cnt).forEach((k) => cnt[k] = 0);
    dayT = 0.25; updateSky(false); let litHostile = 0, maxL = 0;
    for (let i = 0; i < 600; i++) { spawnT = 0; spawnTick(0.1); while (mobs.length) { const m = mobs[0]; cnt[m.type]++;
      if (isHostile(m)) { const v = lightRaw(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z)); const l = Math.max((v >> 4) * daylight, v & 15); maxL = Math.max(maxL, l); if (l >= 7) litHostile++; }
      removeMob(m); } }
    return { night, day: cnt, litHostile, maxL }; })()`);
  check('Spawning', 'creepers and zombies spawn at night', r.night.creeper > 0 && r.night.zombie > 0, JSON.stringify(r.night));
  check('Spawning', 'sheep and pigs spawn in daylight', r.day.sheep > 0 && r.day.pig > 0, JSON.stringify(r.day));
  check('Spawning', 'in daylight hostiles only spawn in dark places (caves), never in light ≥ 7', r.litHostile === 0, `hostiles in light: ${r.litHostile}, brightest spawn light ${r.maxL.toFixed(1)}`);

  // ---------------- crafting helper (real UI)
  async function craft(name, expectId) {
    await ev(`openInv(); true`);
    const ok = await page.evaluate((nm) => {
      const btn = [...document.querySelectorAll('#recipes .recipe')].find((b) => b.querySelector('strong').textContent.replace(/ ×\d+$/, '') === nm);
      if (!btn) return 'no-button';
      const off = btn.classList.contains('off'); btn.click(); return off ? 'disabled' : 'clicked';
    }, name);
    const n = await ev(`countItem(${expectId})`);
    await ev(`closeInv(); state = 'playing'; true`);
    return { ok, n };
  }
  await ev(`setBlock(${at(-3, 0, -3)}, B.TABLE); setBlock(${at(-3, 0, -2)}, B.FURNACE); true`);

  // ---------------- TNT
  await ev(`TT.give([[I.GUNPOWDER, 5], [B.SAND, 4]]); true`);
  r = await craft('TNT', 24);
  check('TNT', 'craft TNT from 5 gunpowder + 4 sand at a table', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  check('TNT', 'ingredients consumed', (await ev(`countItem(I.GUNPOWDER) + countItem(B.SAND)`)) === 0);
  r = await ev(`(() => { TT.reset(); TT.hold(B.TNT); TT.tgt(${at(3, -1, 0)}); useAction(); return { placed: getB(${at(3, 0, 0)}), left: countItem(B.TNT) }; })()`);
  check('TNT', 'TNT can be placed', r.placed === 24 && r.left === 0, JSON.stringify(r));
  r = await ev(`(() => { TT.tgt(${at(3, 0, 0)}); useAction(); return { primed: primed.length, block: getB(${at(3, 0, 0)}), fuse: primed[0] && primed[0].fuse }; })()`);
  check('TNT', 'right-click ignites (block becomes primed TNT, 3 s fuse)', r.primed === 1 && r.block === 0 && r.fuse === 3, JSON.stringify(r));
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(SHOTS, '01-tnt-primed.png') });
  r = await ev(`(() => { const hp0 = player.hp; let t = 0; while (primed.length && t < 6) { updatePrimed(0.05, performance.now()); t += 0.05; }
    let gone = 0; for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (getB(${A.x + 3} + dx, ${A.y - 1}, ${A.z} + dz) === 0) gone++;
    return { exploded: primed.length === 0, hp0, hp: player.hp, gone }; })()`);
  check('TNT', 'explodes and carves a crater', r.exploded && r.gone >= 9, `floor blocks removed in 5×5: ${r.gone}`);
  check('TNT', 'explosion hurts a nearby player', r.hp < r.hp0, `hp ${r.hp0} → ${r.hp}`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '02-tnt-crater.png') });
  r = await ev(`(() => { TT.reset(); player.pos.x = ${A.x - 5.5}; setBlock(${at(4, 0, 4)}, B.TNT); setBlock(${at(5, 0, 4)}, B.TNT); setBlock(${at(6, 0, 4)}, B.TNT);
    setBlock(${at(4, 0, 4)}, B.AIR); primeTNT(${at(4, 0, 4)}, 0.1); let t = 0, maxPrimed = 0; while ((primed.length || t < 0.2) && t < 8) { updatePrimed(0.05, performance.now()); maxPrimed = Math.max(maxPrimed, primed.length); t += 0.05; }
    const res = { maxPrimed, rest: [getB(${at(5, 0, 4)}), getB(${at(6, 0, 4)})], left: primed.length }; player.pos.x = ${A.x + 0.5}; return res; })()`);
  check('TNT', 'explosions chain-ignite neighbouring TNT', r.rest[0] === 0 && r.rest[1] === 0 && r.left === 0 && r.maxPrimed >= 2, JSON.stringify(r));
  // rebuild arena floor
  await ev(`for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) { setBlock(${A.x} + dx, ${A.y - 1}, ${A.z} + dz, B.STONE); setBlock(${A.x} + dx, ${A.y - 2}, ${A.z} + dz, B.STONE); for (let dy = 0; dy <= 6; dy++) if (!(dx === -3 && dz <= -2 && dz >= -3 && dy === 0)) setBlock(${A.x} + dx, ${A.y} + dy, ${A.z} + dz, B.AIR); } TT.clearMobs(); TT.reset(); true`);
  await page.waitForTimeout(1500);

  // ---------------- Bed
  await ev(`TT.give([[B.WOOL, 3], [B.PLANKS, 3]]); true`);
  r = await craft('Yatak', 25);
  check('Bed', 'craft bed from 3 wool + 3 planks at a table', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  r = await ev(`(() => { TT.hold(B.BED); TT.tgt(${at(2, -1, 2)}); useAction(); return getB(${at(2, 0, 2)}); })()`);
  check('Bed', 'bed can be placed', r === 25, `block ${r}`);
  r = await ev(`(() => { dayT = 0.25; lastDayT = dayT; spawnPt = { x: 0, z: 0 }; TT.tgt(${at(2, 0, 2)}); useAction(); return { spawn: spawnPt, dayT, toast: TT.toastText() }; })()`);
  check('Bed', 'daytime: sets spawn point but does not skip time', r.spawn.x === A.x + 2.5 && r.spawn.z === A.z + 2.5 && r.dayT === 0.25 && /Doğma noktan/.test(r.toast), JSON.stringify(r));
  r = await ev(`(() => { dayT = 0.75; lastDayT = dayT; TT.clearMobs(); spawnMob('zombie', ${A.x + 5.5}, ${A.y}, ${A.z + 2.5}); TT.tgt(${at(2, 0, 2)}); useAction(); const res = { dayT, toast: TT.toastText(), sleeping }; TT.clearMobs(); return res; })()`);
  check('Bed', 'cannot sleep with monsters nearby', r.dayT === 0.75 && /canavar/.test(r.toast) && !r.sleeping, JSON.stringify(r));
  r = await ev(`(() => { dayT = 0.75; lastDayT = dayT; dayCount = 3; rain = true; rainLevel = 1; TT.tgt(${at(2, 0, 2)}); useAction(); return { sleeping, overlay: document.getElementById('sleep').style.opacity }; })()`);
  check('Bed', 'night: sleeping fades the screen', r.sleeping && r.overlay === '1', JSON.stringify(r));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, '03-bed-sleeping.png') });
  await page.waitForTimeout(1300);
  r = await ev(`({ dayT, dayCount, rain, sleeping, toast: TT.toastText() })`);
  check('Bed', 'wakes up in the morning, day counter +1, rain cleared', r.dayT < 0.05 && r.dayCount === 4 && r.rain === false && !r.sleeping && /4\. gün/.test(r.toast), JSON.stringify(r));
  // die and respawn at the bed
  r = await ev(`(() => { TT.reset(); player.pos.x += 4; damage(100, 'zombie'); return { state, msg: document.getElementById('deathMsg').textContent }; })()`);
  check('Bed', 'death screen shows', r.state === 'dead', JSON.stringify(r));
  await ev(`respawn(); true`);
  await page.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 10000 });
  r = await ev(`({ x: player.pos.x, y: player.pos.y, z: player.pos.z, hp: player.hp, state })`);
  check('Bed', 'respawns at the bed', Math.abs(r.x - (A.x + 2.5)) <= 1.5 && Math.abs(r.z - (A.z + 2.5)) <= 1.5 && r.hp === 20, JSON.stringify(r));
  await ev(`player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; true`);

  // ---------------- Day counter
  r = await ev(`(() => { dayCount = 7; dayT = 0.9999; lastDayT = 0.9999; return true; })()`);
  await page.waitForTimeout(400);
  r = await ev(`({ dayCount, dayT, toast: TT.toastText(), saved: snapshot().day })`);
  check('Day counter', 'increments when the day wraps and announces it', r.dayCount === 8 && /8\. gün/.test(r.toast), JSON.stringify(r));
  check('Day counter', 'is included in the save', r.saved === 8, `snapshot.day = ${r.saved}`);
  await ev(`infoOn = true; document.getElementById('info').hidden = false; true`);
  await page.waitForTimeout(400);
  r = await page.textContent('#info');
  check('Day counter', 'shown in the F3 panel', /Gün\s+8/.test(r), r.split('\n')[1]);

  // ================================================================ BATCH 2
  // ---------------- Hoe / farmland
  await ev(`TT.give([[I.STICK, 2], [B.PLANKS, 2]]); true`);
  r = await craft('Tahta çapa', 130);
  check('Farming', 'craft wooden hoe (2 planks + 2 sticks) at a table', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  r = await ev(`(() => { TT.reset(); TT.give([[hoeId(0), 1], [I.SEEDS, 5], [B.SAPLING, 2]]);
    setBlock(${at(1, -1, -1)}, B.GRASS); setBlock(${at(2, -1, -1)}, B.DIRT); setBlock(${at(3, -1, -1)}, B.SAND); setBlock(${at(4, -1, -1)}, B.SNOW);
    setBlock(${at(5, -1, -1)}, B.GRASS); setBlock(${at(5, 0, -1)}, B.TALLGRASS);
    TT.hold(hoeId(0)); const out = [];
    for (const dx of [1, 2, 3, 4, 5]) { TT.tgt(${A.x} + dx, ${A.y - 1}, ${A.z - 1}); useAction(); out.push(getB(${A.x} + dx, ${A.y - 1}, ${A.z - 1})); }
    return { out, above: getB(${at(5, 0, -1)}), dur: inv[slot].d }; })()`);
  check('Farming', 'hoe tills grass, dirt and snowy grass into farmland', r.out[0] === 27 && r.out[1] === 27 && r.out[3] === 27, JSON.stringify(r.out));
  check('Farming', 'hoe does nothing on sand', r.out[2] === 4, `sand → ${r.out[2]}`);
  check('Farming', 'tall grass on top is cleared when tilling', r.out[4] === 27 && r.above === 0, `block ${r.out[4]}, above ${r.above}`);
  check('Farming', 'hoe loses durability', r.dur === 59 - 4, `durability ${r.dur}`);
  // seeds
  r = await ev(`(() => { TT.hold(I.SEEDS); TT.tgt(${at(1, -1, -1)}); useAction(); const crop = getB(${at(1, 0, -1)});
    const key = posKey(${at(1, 0, -1)}); const tracked = growing.has(key); const seeds = countItem(I.SEEDS);
    TT.tgt(${at(-1, -1, 1)}); useAction(); const onStone = getB(${at(-1, 0, 1)}); return { crop, tracked, seeds, onStone, toast: TT.toastText() }; })()`);
  check('Farming', 'seeds plant wheat on farmland', r.crop === 28 && r.tracked && r.seeds === 4, JSON.stringify(r));
  check('Farming', 'seeds refuse non-farmland with a hint', r.onStone === 0 && /tarlaya/.test(r.toast), r.toast);
  await ev(`TT.tgt(${at(2, -1, -1)}); TT.hold(I.SEEDS); useAction(); TT.tgt(${at(4, -1, -1)}); useAction(); true`);
  await ev(`player.yaw = Math.PI * 0.75 + Math.PI; player.pitch = -0.6; true`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '04-farm-planted.png') });
  r = await ev(`(() => { const stages = [getB(${at(1, 0, -1)})]; TT.rnd(0); for (let i = 0; i < 3; i++) { growT = 0; tickGrowth(1); stages.push(getB(${at(1, 0, -1)})); } TT.unrnd();
    return { stages, tracked: growing.has(posKey(${at(1, 0, -1)})) }; })()`);
  check('Farming', 'wheat grows through 4 stages', JSON.stringify(r.stages) === '[28,29,30,31]', JSON.stringify(r.stages));
  check('Farming', 'mature wheat stops being tracked for growth', r.tracked === false);
  r = await ev(`(() => { setBlock(${at(2, 0, -1)}, B.WHEAT0); growing.add(posKey(${at(2, 0, -1)})); let steps = 0; while (getB(${at(2, 0, -1)}) !== B.WHEAT3 && steps < 2000) { growT = 0; tickGrowth(1); steps++; } return steps; })()`);
  check('Farming', 'natural growth rate: mature in a few minutes', r > 30 && r < 600, `${r} s of growth ticks`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '05-farm-mature.png') });
  r = await ev(`(() => { TT.clearMobs(); TT.rnd(0.5); breakAt(${at(1, 0, -1)}, false); TT.unrnd(); const mature = { wheat: TT.dropsOf(I.WHEAT), seeds: TT.dropsOf(I.SEEDS) }; TT.clearMobs();
    setBlock(${at(4, 0, -1)}, B.WHEAT0 + 1); breakAt(${at(4, 0, -1)}, false); const young = { wheat: TT.dropsOf(I.WHEAT), seeds: TT.dropsOf(I.SEEDS) }; TT.clearMobs();
    breakAt(${at(2, -1, -1)}, false); const crop = getB(${at(2, 0, -1)}); const farmDrop = TT.dropsOf(B.DIRT); TT.clearMobs();
    return { mature, young, crop, farmDrop }; })()`);
  check('Farming', 'mature wheat drops wheat + 1–3 seeds', r.mature.wheat === 1 && r.mature.seeds >= 1 && r.mature.seeds <= 3, JSON.stringify(r.mature));
  check('Farming', 'young wheat drops only a seed', r.young.wheat === 0 && r.young.seeds === 1, JSON.stringify(r.young));
  check('Farming', 'breaking farmland breaks the crop and drops dirt', r.crop === 0 && r.farmDrop === 1, JSON.stringify(r));
  r = await ev(`(() => { setBlock(${at(6, 0, 6)}, B.TALLGRASS); TT.rnd(0.1); breakAt(${at(6, 0, 6)}, false); TT.unrnd(); const a = TT.dropsOf(I.SEEDS); TT.clearMobs();
    setBlock(${at(6, 0, 6)}, B.TALLGRASS); TT.rnd(0.5); breakAt(${at(6, 0, 6)}, false); TT.unrnd(); const b = TT.dropsOf(I.SEEDS); TT.clearMobs(); return { a, b }; })()`);
  check('Farming', 'tall grass sometimes drops seeds (15 %)', r.a === 1 && r.b === 0, JSON.stringify(r));
  // bread
  await ev(`TT.give([[I.WHEAT, 3]]); true`);
  r = await craft('Ekmek', 127);
  check('Farming', 'craft bread from 3 wheat', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  r = await ev(`(() => { player.hunger = 10; eatCd = 0; TT.hold(I.BREAD); target = null; useAction(); return { hunger: player.hunger, left: countItem(I.BREAD) }; })()`);
  check('Farming', 'eating bread restores 5 hunger', r.hunger === 15 && r.left === 0, JSON.stringify(r));

  // ---------------- Sapling
  r = await ev(`(() => { TT.clearMobs(); setBlock(${at(6, 0, -6)}, B.LEAVES); TT.rnd(0.07); breakAt(${at(6, 0, -6)}, false); TT.unrnd(); const s = TT.dropsOf(B.SAPLING); TT.clearMobs(); return s; })()`);
  check('Sapling', 'leaves can drop saplings', r === 1, `saplings dropped: ${r}`);
  r = await ev(`(() => { TT.give([[B.SAPLING, 2]]); setBlock(${at(-5, -1, 5)}, B.GRASS); TT.tgt(${at(-5, -1, 5)}); useAction(); const planted = getB(${at(-5, 0, 5)});
    const tracked = growing.has(posKey(${at(-5, 0, 5)})); TT.tgt(${at(-4, -1, 5)}); useAction(); const onStone = getB(${at(-4, 0, 5)});
    return { planted, tracked, onStone, toast: TT.toastText() }; })()`);
  check('Sapling', 'plants on grass and is tracked', r.planted === 32 && r.tracked, JSON.stringify(r));
  check('Sapling', 'refuses stone', r.onStone === 0 && /toprağa/.test(r.toast), r.toast);
  r = await ev(`(() => { TT.rnd(0); growT = 0; tickGrowth(1); TT.unrnd(); const trunk = []; for (let dy = 0; dy < 5; dy++) trunk.push(getB(${A.x - 5}, ${A.y} + dy, ${A.z + 5}));
    let leaves = 0; for (let dy = 0; dy < 8; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (getB(${A.x - 5} + dx, ${A.y} + dy, ${A.z + 5} + dz) === B.LEAVES) leaves++;
    return { trunk, leaves, under: getB(${at(-5, -1, 5)}), tracked: growing.has(posKey(${at(-5, 0, 5)})) }; })()`);
  check('Sapling', 'grows into a tree (logs + leaves)', r.trunk.slice(0, 4).every((b) => b === 6) && r.leaves > 15, JSON.stringify(r));
  check('Sapling', 'grass under the trunk becomes dirt', r.under === 2);
  await ev(`player.yaw = Math.atan2(5, -5); player.pitch = 0.2; true`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '06-sapling-tree.png') });

  // ---------------- Chest
  await ev(`TT.give([[B.PLANKS, 8], [B.WOOL, 5], [I.DIAMOND, 2]]); true`);
  r = await craft('Sandık', 33);
  check('Chest', 'craft chest from 8 planks at a table', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  r = await ev(`(() => { TT.hold(B.CHEST); TT.tgt(${at(-2, -1, 3)}); useAction(); const placed = getB(${at(-2, 0, 3)}); TT.tgt(${at(-2, 0, 3)}); useAction();
    return { placed, state, title: document.getElementById('invTitle').textContent, gridVisible: !document.getElementById('chestGrid').hidden, recipesHidden: document.getElementById('recipes').hidden }; })()`);
  check('Chest', 'placed and opened with right-click', r.placed === 33 && r.state === 'inventory' && r.title === 'Sandık' && r.gridVisible && r.recipesHidden, JSON.stringify(r));
  // move wool with shift-click, diamonds with drag (click pick, click drop)
  const woolIdx = await ev(`inv.findIndex((s) => s && s.id === B.WOOL)`);
  const diaIdx = await ev(`inv.findIndex((s) => s && s.id === I.DIAMOND)`);
  await page.keyboard.down('Shift'); await page.click(`#bar .slot:nth-child(${woolIdx + 1})`); await page.keyboard.up('Shift');
  await page.click(`#bar .slot:nth-child(${diaIdx + 1})`); await page.click('#chestGrid .slot:nth-child(5)');
  await page.screenshot({ path: path.join(SHOTS, '07-chest-ui.png') });
  r = await ev(`({ c0: openChest[0] && [openChest[0].id, openChest[0].n], c4: openChest[4] && [openChest[4].id, openChest[4].n], wool: countItem(B.WOOL), dia: countItem(I.DIAMOND) })`);
  check('Chest', 'shift-click moves a stack into the chest', r.c0 && r.c0[0] === 26 && r.c0[1] === 5 && r.wool === 0, JSON.stringify(r));
  check('Chest', 'pick-and-place moves items into a chosen chest slot', r.c4 && r.c4[0] === 103 && r.c4[1] === 2 && r.dia === 0, JSON.stringify(r));
  await page.keyboard.down('Shift'); await page.click('#chestGrid .slot:nth-child(5)'); await page.keyboard.up('Shift');
  r = await ev(`({ dia: countItem(I.DIAMOND), c4: openChest[4] })`);
  check('Chest', 'shift-click moves items back to the bag', r.dia === 2 && r.c4 === null, JSON.stringify(r));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  r = await ev(`({ state, open: openChest, saved: snapshot().chests })`);
  check('Chest', 'closing with E returns to the game', r.state === 'playing' && r.open === null);
  check('Chest', 'chest contents are in the save', JSON.stringify(r.saved).includes('[26,5,0]'), JSON.stringify(r.saved));

  // ---------------- Armor
  await ev(`TT.give([[I.IRON, 8], [I.DIAMOND, 8]]); true`);
  r = await craft('Demir zırh', 134);
  const r2 = await craft('Elmas zırh', 135);
  check('Armor', 'craft iron armor (8 iron) and diamond armor (8 diamonds)', r.n === 1 && r2.n === 1, JSON.stringify([r, r2]));
  await ev(`openInv(); true`);
  const ironIdx = await ev(`inv.findIndex((s) => s && s.id === I.IRON_ARMOR)`);
  await page.keyboard.down('Shift'); await page.click(`#bar .slot:nth-child(${ironIdx + 1})`); await page.keyboard.up('Shift');
  // try to put a non-armor item into the armor slot
  await ev(`inv[8] = { id: B.DIRT, n: 1, d: 0 }; renderInv(); true`);
  await page.click('#bar .slot:nth-child(9)'); await page.click('#armorSlot .slot');
  r = await ev(`({ armor: armor[0] && armor[0].id, cursor: cursor && cursor.id, toast: TT.toastText() })`);
  check('Armor', 'shift-click equips armor', r.armor === 134, JSON.stringify(r));
  check('Armor', 'armor slot rejects non-armor items', r.cursor === 2 && /zırh/.test(r.toast), JSON.stringify(r));
  await page.screenshot({ path: path.join(SHOTS, '08-armor-slot.png') });
  await page.click('#bar .slot:nth-child(9)');
  await page.keyboard.press('KeyE'); await page.waitForTimeout(300);
  r = await ev(`(() => { const out = {};
    TT.reset(); damage(3, 'zombie'); out.ironZombie = 20 - player.hp; out.ironDur = armor[0].d;
    TT.reset(); damage(5, 'fall'); out.ironFall = 20 - player.hp; out.durAfterFall = armor[0].d;
    armor[0] = { id: I.DIAMOND_ARMOR, n: 1, d: ITEM[I.DIAMOND_ARMOR].dur };
    TT.reset(); damage(3, 'zombie'); out.diaZombie = 20 - player.hp;
    TT.reset(); damage(10, 'explosion'); out.diaExplosion = 20 - player.hp;
    armor[0] = null; TT.reset(); damage(3, 'zombie'); out.noneZombie = 20 - player.hp;
    armor[0] = { id: I.IRON_ARMOR, n: 1, d: 1 }; TT.reset(); damage(3, 'zombie'); out.brokeAfter = armor[0]; out.breakToast = TT.toastText();
    TT.reset(); return out; })()`);
  check('Armor', 'no armor: zombie hit = 3', r.noneZombie === 3, JSON.stringify(r));
  check('Armor', 'iron armor: zombie hit 3 → 2 (−40 %)', r.ironZombie === 2);
  check('Armor', 'diamond armor: zombie hit 3 → 1, explosion 10 → 4 (−60 %)', r.diaZombie === 1 && r.diaExplosion === 4, `zombie ${r.diaZombie}, explosion ${r.diaExplosion}`);
  check('Armor', 'armor wears by 1 per absorbed hit', r.ironDur === 239);
  check('Armor', 'armor does not reduce fall damage', r.ironFall === 5 && r.durAfterFall === 239, `fall dmg ${r.ironFall}`);
  check('Armor', 'armor breaks at 0 durability', r.brokeAfter === null && /kırıldı/.test(r.breakToast), r.breakToast);
  r = await ev(`(() => { TT.clearMobs(); inv.fill(null); armor[0] = { id: I.DIAMOND_ARMOR, n: 1, d: 500 }; TT.reset(); damage(100, 'void'); const res = { armor: armor[0], dropped: TT.dropsOf(I.DIAMOND_ARMOR) }; respawn(); return res; })()`);
  check('Armor', 'armor drops on death', r.armor === null && r.dropped === 1, JSON.stringify(r));
  await page.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 10000 });
  await ev(`TT.clearMobs(); player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; TT.reset(); true`);

  // ---------------- Lava
  r = await ev(`(() => { let lava = 0, lit = null; for (const c of chunks.values()) { if (!c.data || !c.light) continue; for (let i = 0; i < c.data.length; i++) if (c.data[i] === B.LAVA) { lava++; if (!lit) { const lx = i % 16, lz = ((i / 16) | 0) % 16, y = (i / 256) | 0; const x = c.cx * 16 + lx, z = c.cz * 16 + lz;
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) { if (getB(x + dx, y + dy, z + dz) === B.AIR) { lit = { pos: [x, y, z], blk: lightRaw(x + dx, y + dy, z + dz) & 15 }; break; } } } } }
    return { lava, lit }; })()`);
  check('Lava', 'lava pools exist in loaded caves', r.lava > 0, `${r.lava} lava blocks loaded`);
  check('Lava', 'lava emits light (block light ≥ 13 next to it)', r.lit && r.lit.blk >= 13, JSON.stringify(r.lit));
  r = await ev(`(() => { TT.reset(); setBlock(${at(0, 0, -5)}, B.LAVA); player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z - 4.5} }; survivalTick(0.05); const hit = 20 - player.hp, fire = player.fire;
    player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; player.invuln = 0; let burnHp = player.hp; for (let i = 0; i < 40; i++) survivalTick(0.05); burnHp -= player.hp;
    return { hit, fire, burnHp, fireLeft: player.fire }; })()`);
  check('Lava', 'touching lava hurts and sets the player on fire', r.hit >= 4 && r.fire > 0, JSON.stringify(r));
  check('Lava', 'burning keeps hurting after leaving lava', r.burnHp >= 1, `extra burn damage ${r.burnHp}`);
  r = await ev(`(() => { TT.reset(); player.fire = 3; setBlock(${at(3, 0, 3)}, B.WATER); player.pos = { x: ${A.x + 3.5}, y: ${A.y}, z: ${A.z + 3.5} }; survivalTick(0.05); const f = player.fire; setBlock(${at(3, 0, 3)}, B.AIR); player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; return f; })()`);
  check('Lava', 'water puts the fire out', r === 0, `fire after entering water: ${r}`);
  r = await ev(`(() => { TT.reset(); player.fire = 3; rain = true; rainLevel = 1; rainOut = 1; survivalTick(0.05); const f = player.fire; rain = false; rainLevel = 0; rainOut = 0; return f; })()`);
  check('Lava', 'rain puts the fire out outdoors', r === 0, `fire in rain: ${r}`);
  r = await ev(`(() => { TT.reset(); setBlock(${at(1, 0, -5)}, B.LAVA); player.pos = { x: ${A.x + 1.5}, y: ${A.y}, z: ${A.z - 4.5} }; player.vel = { x: 0, y: 0, z: 0 }; updatePlayer(0.05); const inFluid = player.inWater; player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; TT.reset(); return inFluid; })()`);
  check('Lava', 'lava slows movement like a fluid', r === true);
  r = await ev(`(() => { TT.clearMobs(); spawnMob('pig', ${A.x + 0.5}, ${A.y}, ${A.z - 4.5}); const m = mobs[0]; for (let i = 0; i < 10; i++) updateMobs(0.05); const res = { alive: mobs.includes(m), hp: m.hp }; TT.clearMobs(); return res; })()`);
  check('Lava', 'mobs burn in lava', !r.alive || r.hp < 10, JSON.stringify(r));
  r = await ev(`(() => { setBlock(${at(-6, 0, 0)}, B.LAVA); setBlock(${at(-5, 0, 0)}, B.STONE); breakAt(${at(-5, 0, 0)}, false); return getB(${at(-5, 0, 0)}); })()`);
  check('Lava', 'breaking a block next to lava lets the lava in', r === 34, `block after break: ${r}`);
  r = await ev(`({ breakable: DEF[B.LAVA].hard, targetable: (() => { const t0 = target; TT.tgt(${at(-6, 0, 0)}); breakAt(${at(-6, 0, 0)}, false); const b = getB(${at(-6, 0, 0)}); target = t0; return b; })() })`);
  check('Lava', 'lava cannot be broken', r.targetable === 34, JSON.stringify(r));
  // lava screenshot (pool next to the player)
  await ev(`for (let dx = -2; dx <= 2; dx++) for (let dz = -6; dz <= -5; dz++) { setBlock(${A.x} + dx, ${A.y - 1}, ${A.z} + dz, B.LAVA); setBlock(${A.x} + dx, ${A.y}, ${A.z} + dz, B.AIR); } dayT = 0.75; updateSky(false); player.yaw = 0; player.pitch = -0.5; true`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '09-lava-night.png') });
  await ev(`dayT = 0.25; true`);

  // ---------------- Bucket & obsidian
  await ev(`TT.give([[I.IRON, 3]]); true`);
  r = await craft('Kova', 136);
  check('Bucket', 'craft bucket from 3 iron', r.ok === 'clicked' && r.n === 1, JSON.stringify(r));
  r = await ev(`(() => { TT.reset(); setBlock(${at(2, 0, 0)}, B.WATER); player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} };
    camera.position.set(${A.x + 0.5}, ${A.y + 1.62}, ${A.z + 0.5}); camera.lookAt(${A.x + 2.5}, ${A.y + 0.4}, ${A.z + 0.5}); camera.updateMatrixWorld();
    TT.hold(I.BUCKET); useAction(); return { water: getB(${at(2, 0, 0)}), held: inv[slot] && inv[slot].id }; })()`);
  check('Bucket', 'empty bucket scoops up water', r.water === 0 && r.held === 137, JSON.stringify(r));
  r = await ev(`(() => { target = null; setBlock(${at(3, 0, 3)}, B.STONE); TT.tgt(${at(3, 0, 3)}); useAction(); return { placed: getB(${at(3, 1, 3)}), held: inv[slot] && inv[slot].id }; })()`);
  check('Bucket', 'water bucket pours water and becomes an empty bucket', r.placed === 5 && r.held === 136, JSON.stringify(r));
  r = await ev(`(() => { setBlock(${at(3, 1, 3)}, B.AIR); setBlock(${at(-3, 0, 4)}, B.LAVA); setBlock(${at(-3, 0, 5)}, B.LAVA);
    inv[slot] = { id: I.WATER_BUCKET, n: 1, d: 0 }; TT.tgt(${at(-3, -1, 4)}); useAction();
    return { cell: getB(${at(-3, 0, 4)}), neighbour: getB(${at(-3, 0, 5)}), toast: TT.toastText() }; })()`);
  check('Bucket', 'water on lava turns it into obsidian (cell and neighbours)', r.cell === 35 && r.neighbour === 35 && /obsidyen/.test(r.toast), JSON.stringify(r));
  await ev(`player.yaw = Math.atan2(3, -4); player.pitch = -0.5; true`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '10-obsidian.png') });
  r = await ev(`(() => { inv[0] = { id: toolId(PICK, 2), n: 1, d: 250 }; inv[1] = { id: toolId(PICK, 3), n: 1, d: 1561 }; slot = 0; const iron = breakInfo(B.OBSIDIAN); slot = 1; const dia = breakInfo(B.OBSIDIAN); return { iron, dia }; })()`);
  check('Bucket', 'obsidian needs a diamond pickaxe', !r.iron.harvest && r.dia.harvest && r.dia.time > 5 && r.dia.time < 15, JSON.stringify(r));
  r = await ev(`(() => { setMode('creative'); inv[0] = { id: I.WATER_BUCKET, n: 1, d: 0 }; slot = 0; TT.tgt(${at(4, -1, -4)}); useAction(); const held = inv[0] && inv[0].id; setBlock(${at(4, 0, -4)}, B.AIR); setMode('survival'); return held; })()`);
  check('Bucket', 'creative mode keeps the water bucket', r === 137);

  // ---------------- Cactus
  r = await ev(`(() => { TT.reset(); setBlock(${at(1, 0, 0)}, B.CACTUS); player.pos = { x: ${A.x + 1 - 0.3 - 0.03}, y: ${A.y}, z: ${A.z + 0.5} }; survivalTick(0.05); const touch = 20 - player.hp;
    TT.reset(); player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; survivalTick(0.05); const away = 20 - player.hp;
    TT.reset(); armor[0] = { id: I.DIAMOND_ARMOR, n: 1, d: 100 }; player.pos = { x: ${A.x + 1 - 0.3 - 0.03}, y: ${A.y}, z: ${A.z + 0.5} }; survivalTick(0.05); const armored = 20 - player.hp; const d = armor[0].d; armor[0] = null;
    return { touch, away, armored, d, solid: DEF[B.CACTUS].solid }; })()`);
  check('Cactus', 'touching a cactus hurts (1 per hit)', r.touch === 1, JSON.stringify(r));
  check('Cactus', 'standing 0.2 blocks away is safe', r.away === 0);
  check('Cactus', 'cactus is solid', r.solid === true);
  check('Cactus', 'armor wears on cactus hits', r.d === 99, `durability 100 → ${r.d}`);
  r = await ev(`(() => { TT.reset(); player.hp = 1; player.pos = { x: ${A.x + 1 - 0.3 - 0.03}, y: ${A.y}, z: ${A.z + 0.5} }; survivalTick(0.05); const res = { state, msg: document.getElementById('deathMsg').textContent }; respawn(); return res; })()`);
  check('Cactus', 'death message for cactus', r.state === 'dead' && /Kaktüs/.test(r.msg), r.msg);
  await page.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 10000 });
  r = await ev(`(() => { TT.reset(); setBlock(${at(0, 0, -6)}, B.LAVA); player.hp = 2; player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z - 5.5} }; survivalTick(0.05); const res = { state, msg: document.getElementById('deathMsg').textContent }; respawn(); return res; })()`);
  check('Lava', 'death message for lava', r.state === 'dead' && /Lav/.test(r.msg), r.msg);
  await page.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 10000 });
  await ev(`TT.clearMobs(); TT.reset(); true`);

  // ---------------- Rain & weather
  r = await ev(`(() => { rain = false; rainLevel = 0; rainTimer = 0; weatherTick(0.1); return { rain, timer: rainTimer, toast: TT.toastText() }; })()`);
  check('Weather', 'weather timer starts rain', r.rain === true && r.timer >= 120 && r.timer <= 300 && /Yağmur/.test(r.toast), JSON.stringify(r));
  r = await ev(`(() => { rainTimer = 0; weatherTick(0.1); const off = { rain, timer: rainTimer }; rain = true; rainTimer = 9999; return off; })()`);
  check('Weather', 'rain stops again after a while', r.rain === false && r.timer >= 300 && r.timer <= 780, JSON.stringify(r));
  r = await ev(`(() => { dayT = 0.25; rainLevel = 0; updateSky(false); const dry = daylight; rainLevel = 1; updateSky(false); const wet = daylight; return { dry, wet }; })()`);
  check('Weather', 'rain darkens the daylight', r.wet < r.dry * 0.8, `daylight ${r.dry.toFixed(2)} → ${r.wet.toFixed(2)}`);
  r = await ev(`(() => { TT.clearMobs(); player.dead = true; rain = true; rainLevel = 1; dayT = 0.25; updateSky(false); spawnMob('zombie', ${A.x - 4.5}, ${A.y}, ${A.z + 4.5}); const z = mobs[0]; for (let i = 0; i < 40; i++) updateMobs(0.05); const hp = z.hp; player.dead = false; TT.clearMobs(); return hp; })()`);
  check('Weather', 'zombies do not burn in the rain', r === 20, `zombie hp ${r}`);
  await ev(`player.pos = { x: ${A.x + 0.5}, y: ${A.y}, z: ${A.z + 0.5} }; player.yaw = 0.4; player.pitch = 0.05; rain = true; rainLevel = 1; rainTimer = 9999; true`);
  await page.waitForTimeout(1200);
  r = await ev(`({ visible: rainMesh.visible, color: rainMat.color.getHexString(), biome: core.column(Math.floor(player.pos.x), Math.floor(player.pos.z))[1], rainOut })`);
  check('Weather', 'rain is visible outdoors', r.visible && r.color === 'a8bcd8', JSON.stringify(r));
  await page.screenshot({ path: path.join(SHOTS, '11-rain.png') });
  r = await page.evaluate(() => window.__ev('rainGain ? rainGain.gain.value : null'));
  check('Weather', 'rain sound plays outdoors', r !== null && r > 0.05, `gain ${r}`);
  // indoors: roof over the player
  await ev(`for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) setBlock(${A.x} + dx, ${A.y + 3}, ${A.z} + dz, B.STONE); true`);
  await page.waitForTimeout(2500);
  r = await ev(`({ visible: rainMesh.visible, sky: lightRaw(Math.floor(camera.position.x), Math.floor(camera.position.y), Math.floor(camera.position.z)) >> 4, gain: rainGain && rainGain.gain.value })`);
  check('Weather', 'rain hidden and muffled under a roof', r.visible === false && r.gain < 0.05, JSON.stringify(r));
  await ev(`for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) setBlock(${A.x} + dx, ${A.y + 3}, ${A.z} + dz, B.AIR); true`);
  r = await ev(`({ saved: snapshot().rain, timer: snapshot().rainTimer })`);
  check('Weather', 'weather is saved', r.saved === true && r.timer > 0, JSON.stringify(r));

  // snow biome and desert: teleport
  const snowPos = await ev(`(() => { for (let r = 32; r < 3000; r += 24) for (let a = 0; a < 24; a++) { const x = Math.round(Math.cos(a / 24 * 6.283) * r), z = Math.round(Math.sin(a / 24 * 6.283) * r); const c = core.column(x, z); if (c[1] === 3) return { x, z, h: c[0] }; } return null; })()`);
  const desertPos = await ev(`(() => { for (let r = 32; r < 3000; r += 24) for (let a = 0; a < 24; a++) { const x = Math.round(Math.cos(a / 24 * 6.283) * r), z = Math.round(Math.sin(a / 24 * 6.283) * r); const c = core.column(x, z); if (c[1] === 2) return { x, z, h: c[0] }; } return null; })()`);
  async function teleport(pos) {
    await ev(`TT.clearMobs(); player.pos = { x: ${pos.x + 0.5}, y: ${pos.h + 20}, z: ${pos.z + 0.5} }; pendingSpawn = true; true`);
    await page.waitForFunction(() => window.__ev('!pendingSpawn && chunkReadyAt(player.pos.x, player.pos.z)'), null, { timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  if (snowPos) {
    await teleport(snowPos);
    await ev(`rain = true; rainLevel = 1; player.pitch = 0.1; TT.reset(); true`);
    await page.waitForTimeout(1000);
    r = await ev(`({ visible: rainMesh.visible, color: rainMat.color.getHexString(), biome: core.column(Math.floor(player.pos.x), Math.floor(player.pos.z))[1] })`);
    check('Weather', 'snow falls in snowy mountains (white, slow)', r.visible && r.color === 'f4f8ff' && r.biome === 3, JSON.stringify(r));
    await page.screenshot({ path: path.join(SHOTS, '12-snow.png') });
  } else check('Weather', 'snow biome found', false);
  if (desertPos) {
    await teleport(desertPos);
    await ev(`rain = true; rainLevel = 1; TT.reset(); true`);
    await page.waitForTimeout(800);
    r = await ev(`({ visible: rainMesh.visible, out: rainOut, biome: core.column(Math.floor(player.pos.x), Math.floor(player.pos.z))[1] })`);
    check('Weather', 'no rain in the desert', r.visible === false && r.out === 0 && r.biome === 2, JSON.stringify(r));
    // find a cactus among loaded chunks
    const cac = await ev(`(() => { let best = null, bd = 1e9; for (const c of chunks.values()) { if (!c.data) continue; for (let i = 0; i < c.data.length; i++) if (c.data[i] === B.CACTUS) { const x = c.cx * 16 + (i % 16), z = c.cz * 16 + (((i / 16) | 0) % 16), y = (i / 256) | 0; const d = Math.hypot(x - player.pos.x, z - player.pos.z); if (d < bd) { bd = d; best = { x, y, z }; } } } return best; })()`);
    check('Cactus', 'cacti generate in the desert', !!cac, JSON.stringify(cac));
    if (cac) {
      await ev(`rain = false; rainLevel = 0; player.pos = { x: ${cac.x + 3.5}, y: ${A.y}, z: ${cac.z + 0.5} }; pendingSpawn = true; true`);
      await page.waitForFunction(() => window.__ev('!pendingSpawn'), null, { timeout: 15000 });
      await ev(`player.yaw = Math.PI / 2; player.pitch = -0.05; true`);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(SHOTS, '13-cactus.png') });
    }
  } else check('Weather', 'desert biome found', false);

  // ---------------- creative palette & creeper/sheep visuals
  r = await ev(`(() => { const need = [B.TNT, B.BED, B.WOOL, B.CHEST, B.FARMLAND, B.SAPLING, B.CACTUS, B.OBSIDIAN, B.LAVA, I.GUNPOWDER, I.SEEDS, I.WHEAT, I.BREAD, I.BUCKET, I.WATER_BUCKET, I.IRON_ARMOR, I.DIAMOND_ARMOR, hoeId(0), hoeId(1), hoeId(2), hoeId(3)];
    return need.filter((id) => !PALETTE.includes(id)); })()`);
  check('Creative', 'all new blocks and items are in the creative palette', r.length === 0, r.length ? 'missing ' + r : '21 items present');
  await ev(`setMode('creative'); openInv(); true`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '14-creative-palette.png') });
  r = await page.$$eval('#palette .slot img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
  check('Creative', 'every palette icon renders', r === 0, `${r} broken icons`);
  await ev(`closeInv(); setMode('survival'); state = 'playing'; true`);
  // icons for every new item render in the hotbar
  r = await ev(`(() => { const ids = [B.TNT, B.BED, B.WOOL, B.CHEST, B.SAPLING, B.CACTUS, B.OBSIDIAN, I.GUNPOWDER, I.SEEDS]; ids.forEach((id, i) => inv[i] = { id, n: 3, d: 0 }); invChanged(); return true; })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '15-hotbar-items-1.png'), clip: { x: 380, y: 600, width: 520, height: 120 } });
  await ev(`(() => { const ids = [I.WHEAT, I.BREAD, I.BUCKET, I.WATER_BUCKET, I.IRON_ARMOR, I.DIAMOND_ARMOR, hoeId(0), hoeId(2), hoeId(3)]; ids.forEach((id, i) => inv[i] = { id, n: hasDur(id) ? 1 : 3, d: hasDur(id) ? ITEM[id].dur : 0 }); invChanged(); return true; })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '16-hotbar-items-2.png'), clip: { x: 380, y: 600, width: 520, height: 120 } });
  // mobs line-up screenshot (player "dead" flag stops the creeper chasing)
  await ev(`(() => { TT.clearMobs(); dayT = 0.25; rain = false; rainLevel = 0; const x = Math.floor(player.pos.x), z = Math.floor(player.pos.z);
    for (let dx = -3; dx <= 3; dx++) for (let dz = 3; dz <= 6; dz++) { setBlock(x + dx, Math.floor(player.pos.y) - 1, z - dz, B.GRASS); for (let dy = 0; dy < 4; dy++) setBlock(x + dx, Math.floor(player.pos.y) + dy, z - dz, B.AIR); }
    const y = Math.floor(player.pos.y); spawnMob('creeper', x - 1.5, y, z - 4); spawnMob('sheep', x + 1, y, z - 4.5); spawnMob('zombie', x + 2.8, y, z - 5);
    mobs.forEach((m) => { m.yaw = Math.PI; m.think = 999; m.wx = m.wz = 0; }); player.dead = true; player.yaw = 0; player.pitch = -0.15; return true; })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '17-creeper-sheep-zombie.png') });
  await ev(`player.dead = false; TT.clearMobs(); true`);

  // held item must draw over water/lava/rain
  r = await ev(`(() => { inv.fill(null); invChanged(); const arm = { t: handObj.material.transparent, o: handObj.renderOrder }; inv[0] = { id: B.TNT, n: 1, d: 0 }; slot = 0; invChanged(); const blk = { t: handObj.material.transparent, o: handObj.renderOrder };
    inv[0] = { id: I.BREAD, n: 1, d: 0 }; invChanged(); const flat = { t: handObj.material.transparent, o: handObj.renderOrder }; return { arm, blk, flat }; })()`);
  check('Render', 'held item is drawn after water/lava/rain (empty hand, block, flat item)', [r.arm, r.blk, r.flat].every((x) => x.t && x.o > 1), JSON.stringify(r));
  await ev(`(() => { inv[0] = null; invChanged(); const x = Math.floor(player.pos.x), y = Math.floor(player.pos.y), z = Math.floor(player.pos.z); for (let dx = -2; dx <= 3; dx++) for (let dz = -1; dz <= 1; dz++) { setBlock(x + dx + 1, y, z + dz, B.WATER); setBlock(x + dx + 1, y + 1, z + dz, B.WATER); } player.yaw = -Math.PI / 2; player.pitch = -0.3; return true; })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '19-hand-over-water.png') });

  // ---------------- full save → reload round trip
  const snap = await ev(`(() => { armor[0] = { id: I.IRON_ARMOR, n: 1, d: 123 }; growing.add('1,2,3'); dayCount = 9; rain = true; rainTimer = 77; save(); return JSON.parse(localStorage.getItem('blok-diyari-v2')); })()`);
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page2.on('pageerror', (e) => errors.push('PAGEERR(reload) ' + (e.stack || e)));
  await page2.addInitScript(([s]) => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('x')); }; localStorage.setItem('blok-diyari-v2', s); }, [JSON.stringify(snap)]);
  await page2.route('**/three.min.js', (rt) => rt.fulfill({ path: path.join(DIR, 'package/build/three.min.js'), contentType: 'application/javascript' }));
  await page2.route('https://fonts.**', (rt) => rt.abort());
  await page2.goto('file://' + TEST_FILE);
  await page2.waitForFunction(() => window.__ev && window.__ev('state') === 'menu', null, { timeout: 30000 });
  const ev2 = evOn(page2);
  r = await ev2(`({ armor: armor[0], chests: [...chests].map(([k, a]) => [k, a.filter(Boolean).map((s) => s.id + 'x' + s.n)]), growing: [...growing], dayCount, rain, rainTimer, btn: document.getElementById('play').textContent })`);
  check('Save', 'armor restored after reload', r.armor && r.armor.id === 134 && r.armor.d === 123, JSON.stringify(r.armor));
  check('Save', 'chest contents restored after reload', JSON.stringify(r.chests).includes('26x5'), JSON.stringify(r.chests));
  check('Save', 'growing crops/saplings list restored', r.growing.includes('1,2,3'), JSON.stringify(r.growing));
  check('Save', 'day counter and weather restored', r.dayCount === 9 && r.rain === true && r.rainTimer === 77, JSON.stringify({ d: r.dayCount, rain: r.rain, t: r.rainTimer }));
  await page2.close();

  // ---------------- touch layout smoke test (phone size)
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', (e) => errors.push('PAGEERR(phone) ' + (e.stack || e)));
  await phone.route('**/three.min.js', (rt) => rt.fulfill({ path: path.join(DIR, 'package/build/three.min.js'), contentType: 'application/javascript' }));
  await phone.route('https://fonts.**', (rt) => rt.abort());
  await phone.goto('file://' + TEST_FILE);
  await phone.waitForFunction(() => window.__ev && window.__ev('state') === 'menu', null, { timeout: 30000 });
  await phone.tap('#play'); await phone.waitForTimeout(1500);
  await phone.evaluate(() => window.__ev(`(() => { [[B.CHEST, 1], [I.IRON_ARMOR, 1]].forEach(([id, n], i) => inv[i] = { id, n, d: hasDur(id) ? ITEM[id].dur : 0 }); invChanged(); openInv(); return true; })()`));
  await phone.waitForTimeout(400);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('Mobile', 'inventory with armor slot fits a phone screen (no sideways scroll)', !overflow);
  await phone.screenshot({ path: path.join(SHOTS, '18-phone-inventory.png') });
  await phone.close();

  // ---------------- summary
  check('Runtime', 'no JavaScript errors during the whole run', errors.length === 0, errors.slice(0, 5).join(' | '));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
