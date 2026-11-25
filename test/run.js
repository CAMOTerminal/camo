// End-to-end checks against live sources: relay endpoints, the vault, and that transactions signed by the wallet engine
// are accepted as correctly signed by a Robinhood Chain node (the wallets are empty, so the node names the sender and
// stops at the balance check: nothing is broadcast and no funds are needed).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PORT = 21000 + Math.floor(Math.random() * 2000), BASE = 'http://127.0.0.1:' + PORT;
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = mem(); globalThis.sessionStorage = mem();
const W = await import('../client/wallet.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  ' + String(extra).slice(0, 220))); };
const get = async (p, body) => { const r = await fetch(BASE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text, headers: r.headers }; };
const ETH = '0x0000000000000000000000000000000000000000', ADDR = /^0x[0-9a-fA-F]{40}$/;

const srv = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] }); let log = ''; srv.stdout.on('data', (d) => { log += d; });
try {
  for (let i = 0; i < 40 && !log.includes('camo relay'); i++) await sleep(150);
  console.log('pages');
  for (const p of ['/', '/app', '/docs', '/style.css', '/app.js', '/wallet.js', '/pnl.js', '/favicon.svg', '/fonts/bricolage.woff2', '/healthz']) ok(p, (await get(p)).status === 200);
  const nf = await get('/nope'); ok('unknown page is a styled 404', nf.status === 404 && nf.text.includes('Nothing to see'));
  const app = await get('/app'); ok('strict content policy: scripts and connections only to this origin', /script-src 'self'/.test(app.headers.get('content-security-policy')) && /connect-src 'self'/.test(app.headers.get('content-security-policy')) && app.headers.get('referrer-policy') === 'no-referrer');
  ok('no cookies are set', !app.headers.get('set-cookie'));
  ok('pages load nothing from another origin', !/(src|href)="https?:\/\//.test(app.text.replace(/rel="noopener[^>]*>/g, '')));

  console.log('market data');
  const d = await get('/api/discover?tab=trending&tf=h24'); ok('trending has rows', d.j?.rows?.length > 3, d.text); const row = d.j.rows.find((r) => r.liq > 50000) || d.j.rows[0];
  ok('row shape', ADDR.test(row.mint) && row.pool && row.symbol && row.price > 0, JSON.stringify(row)); ok('images go through the relay', d.j.rows.every((r) => !r.image || r.image.startsWith('/api/img?u=')));
  ok('ETH price', d.j.eth > 100, d.j.eth);
  const g = (await get('/api/discover?tab=gainers&tf=h24')).j.rows; ok('gainers are sorted by change', g.length > 1 && g[0].chg.h24 >= g[1].chg.h24);
  const t = await get('/api/token/' + row.mint); ok('token detail', t.j?.mint?.toLowerCase() === row.mint.toLowerCase() && t.j.price > 0, t.text); ok('token read from its contract', t.j?.info?.decimals >= 0 && t.j.info.supply > 0, JSON.stringify(t.j?.info));
  const oh = await get(`/api/ohlcv/${t.j.pool}?tf=15m`); ok('candles', oh.j?.candles?.length > 0 || oh.status === 503, oh.text); const trd = await get('/api/trades/' + t.j.pool); ok('trades', Array.isArray(trd.j?.trades) || trd.status === 503, trd.text);
  ok('search', (await get('/api/search?q=cash')).j?.rows?.length > 0); ok('bad address is a 400', (await get('/api/token/abc')).status === 400);
  ok('image relay refuses other hosts', (await get('/api/img?u=' + encodeURIComponent('https://example.com/a.png'))).status === 404);

  console.log('vault');
  ok('browser can sign', await W.supported());
  ok('keccak-256 matches the published value', W.hex(W.keccak256(new Uint8Array(0))) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  ok('address derivation matches a published key', W.addressOfKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318') === '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  let threw = false; try { await W.create('short'); } catch { threw = true; } ok('short passphrase refused', threw);
  await W.create('correct horse battery'); const a0 = await W.address(0), key = W.backup(); const c1 = await W.newCompartment('TEST', '', 'route');
  ok('reserve address is a checksummed EVM address', ADDR.test(a0) && a0 === W.checksum(a0)); ok('each compartment has its own address', c1.address !== a0);
  const stored = localStorage.getItem('camo_vault'); ok('vault at rest holds no seed or address in the clear', !stored.includes(W.data().seed) && !stored.toLowerCase().includes(a0.slice(2).toLowerCase()));
  W.lock(); ok('locked', !W.unlocked()); threw = false; try { await W.unlock('wrong passphrase'); } catch { threw = true; } ok('wrong passphrase refused', threw);
  await W.unlock('correct horse battery'); ok('unlock restores compartments', (await W.compartments()).length === 2 && (await W.address(0)) === a0);
  ok('session resume after a reload', await W.resume() && (await W.address(0)) === a0); W.lock(); ok('locking ends the session', !(await W.resume())); W.destroy(); await W.restore('another passphrase', key); ok('recovery key rebuilds the same wallets', (await W.address(0)) === a0 && (await W.address(1)) === c1.address);
  ok('exported key is that wallet', W.addressOfKey(await W.secretKey(0)) === a0);

  console.log('signing');
  const acct = await get('/api/account/' + a0); ok('nonce and fee', acct.j?.nonce === 0 && BigInt(acct.j.maxFeePerGas) > 0n, acct.text);
  const raw = await W.signTx(0, { to: c1.address, value: 1000000000000000n, data: '0x', gas: W.TRANSFER_GAS, maxFeePerGas: BigInt(acct.j.maxFeePerGas), maxPriorityFeePerGas: 0n, nonce: 0 });
  const sent = await get('/api/send', { tx: raw }); ok('node recovers our address from a signed transfer', sent.status === 400 && /insufficient funds/i.test(sent.text) && sent.text.toLowerCase().includes(a0.toLowerCase()), sent.text);
  const q = await get('/api/quote', { in: ETH, out: row.mint, amount: '10000000000000000', slip: 100 }); ok('preview quote', BigInt(q.j?.out || 0) > 0n && !q.j.steps, q.text);
  const q2 = await get('/api/quote', { user: a0, in: ETH, out: row.mint, amount: '10000000000000000', slip: 100 }); ok('quote for our wallet comes with the transaction to sign', q2.j?.steps?.length >= 1 && ADDR.test(q2.j.steps[0].to) && q2.j.steps[0].data.length > 10, q2.text);
  if (q2.j?.steps?.[0]) { const s = q2.j.steps[0], rawSwap = await W.signTx(0, { to: s.to, value: BigInt(s.value), data: s.data, gas: BigInt(s.gas) > 0n ? BigInt(s.gas) : 600000n, maxFeePerGas: BigInt(acct.j.maxFeePerGas), maxPriorityFeePerGas: 0n, nonce: 0 }); const r = await get('/api/send', { tx: rawSwap }); ok('node recovers our address from a signed swap', r.status === 400 && r.text.toLowerCase().includes(a0.toLowerCase()), r.text); }
  const sellRaw = (BigInt(Math.round(20 / t.j.price)) * 10n ** BigInt(t.j.info.decimals)).toString(); // about $20 of the token
  const qs = await get('/api/quote', { user: a0, in: row.mint, out: ETH, amount: sellRaw, slip: 100 }); ok('a sell comes as an approval then a swap', qs.j?.steps?.length === 2 && qs.j.steps[0].id === 'approve', qs.text);
  ok('garbage transaction refused', (await get('/api/send', { tx: '<script>' })).status === 400);
  const bal = await get('/api/balances', { addrs: [a0, c1.address] }); ok('balances', bal.j?.wei?.[a0] === '0', bal.text);
  const w = await get('/api/wallet', { addr: a0, tokens: [row.mint] }); ok('wallet lookup', w.j?.eth === 0 && Array.isArray(w.j.tokens), w.text);

  console.log('camo route');
  const rt = await get('/api/route/tokens'); ok('route assets across chains', rt.j?.tokens?.length > 10 && new Set(rt.j.tokens.map((x) => x.chain)).size > 4, rt.text); ok('Robinhood Chain ETH is first', rt.j.tokens[0].symbol === 'ETH' && rt.j.tokens[0].chain === 'hood');
  const usdc = rt.j.tokens.find((x) => x.symbol === 'USDC' && x.chain === 'base') || rt.j.tokens.find((x) => x.symbol === 'USDC');
  const rq = await get('/api/route/quote', { asset: usdc.id, amount: '50' }); ok('estimate: USDC in, ETH out', +rq.j?.out > 0, rq.text);
  const mv = await get('/api/route/quote', { asset: 'nep141:hood.omft.near', raw: '10000000000000000' }); ok('estimate: ETH to ETH between own wallets', +mv.j?.out > 0.009, mv.text);
  const od = await get('/api/route/quote', { asset: 'nep141:hood.omft.near', raw: '10000000000000000', order: true, recipient: c1.address, refundTo: a0 }); ok('order returns a one-time deposit address', ADDR.test(od.j?.deposit || '') && od.j.deposit.toLowerCase() !== c1.address.toLowerCase(), od.text);
  if (od.j?.deposit) { const st = await get('/api/route/status?deposit=' + od.j.deposit); ok('route status', st.status === 200 && !!st.j.status, st.text); }
  ok('order without a refund address is refused', (await get('/api/route/quote', { asset: usdc.id, amount: '50', order: true, recipient: c1.address })).status === 400);
} catch (e) { fail++; console.log('  FAIL crashed: ' + (e.stack || e)); } finally { srv.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
