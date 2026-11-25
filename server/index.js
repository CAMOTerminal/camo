// CAMO relay. The browser only ever talks to this server: market data, quotes, images and transaction relay all pass
// through here, so no third party sees a visitor's address or what they are looking at. It stores nothing about anyone:
// no accounts, no cookies, no request log. Keys never reach it; transactions arrive already signed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), CLIENT = path.join(ROOT, 'client');
const PORT = +process.env.PORT || 8318, CHAIN_ID = 4663;
const RPCS = (process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com').split(',').map((s) => s.trim()).filter(Boolean);
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood', DS = 'https://api.dexscreener.com', RELAY = process.env.RELAY_URL || 'https://api.relay.link', ONE = process.env.ONECLICK_URL || 'https://1click.chaindefuser.com';
const ROUTE_FEE_TO = process.env.ROUTE_FEE_TO || '', ROUTE_FEE_BPS = +process.env.ROUTE_FEE_BPS || 0, FEE_BPS = Math.min(100, Math.max(0, +process.env.FEE_BPS || 0)), FEE_TO = /^0x[0-9a-fA-F]{40}$/.test(process.env.FEE_TO || '') ? process.env.FEE_TO : '';
const okUrl = (u) => (/^https:\/\//.test(u || '') ? u : ''), okAddr = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a || '') ? a : '');
const SITE = { x: okUrl(process.env.X_URL) || 'https://x.com/CAMOTerminal', gh: okUrl(process.env.GH_URL) || 'https://github.com/CAMOTerminal/camo', mint: okAddr(process.env.TOKEN_MINT) };
const ETH = '0x0000000000000000000000000000000000000000', WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', ETH_ASSET = 'nep141:hood.omft.near', QUOTER = '0x1111111111111111111111111111111111111111'; // stand-in sender for price previews before a wallet is chosen
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, POOL = /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/;
process.on('uncaughtException', (e) => { console.error('uncaught', e?.message || e); if (e?.code === 'EADDRINUSE') process.exit(1); });
process.on('unhandledRejection', (e) => console.error('unhandled', e?.message || e));

// ---------- upstream fetch with a last-good cache: a slow or failing source never becomes an error page ----------
const store = new Map(), flights = new Map();
async function get(url, opt = {}) {
  const r = await fetch(url, { method: opt.method || (opt.body ? 'POST' : 'GET'), body: opt.body ? JSON.stringify(opt.body) : undefined, headers: { accept: 'application/json', ...(opt.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(opt.timeout || 12000) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!r.ok) { const e = new Error(j?.message || j?.error?.message || j?.status?.error_message || j?.error || ('upstream ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function cached(key, ttl, make) {
  const hit = store.get(key), now = Date.now();
  if (hit && now - hit.at < ttl) return hit.v;
  if (flights.has(key)) return hit ? hit.v : flights.get(key);
  const p = (async () => { try { const v = await make(); if (store.size > 4000) store.delete(store.keys().next().value); store.delete(key); store.set(key, { v, at: Date.now() }); return v; } catch (e) { if (hit) return hit.v; throw e; } finally { flights.delete(key); } })();
  flights.set(key, p); return hit && now - hit.at < ttl * 40 ? hit.v : p;
}
let rpcAt = 0;
async function rpc(method, params = []) {
  let last;
  for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(rpcAt + i) % RPCS.length];
    try { const j = await get(u, { body: { jsonrpc: '2.0', id: 1, method, params }, timeout: 15000 }); if (j?.error) { const e = new Error(j.error.message || 'rpc error'); e.rpc = true; throw e; } return j.result; }
    catch (e) { last = e; if (e.rpc) throw e; rpcAt++; } }
  throw last || new Error('rpc unavailable');
}
async function rpcBatch(calls) { const j = await get(RPCS[rpcAt % RPCS.length], { body: calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params })), timeout: 15000 }); const out = []; for (const r of Array.isArray(j) ? j : []) out[r.id] = r.error ? null : r.result; return calls.map((_, i) => out[i] ?? null); }
const call = (to, data) => [`eth_call`, [{ to, data }, 'latest']];
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// ---------- market data ----------
const num = (x) => (x == null || x === '' || !isFinite(+x) ? null : +x);
const img = (u) => (u && /^https:\/\//.test(u) && !/missing/.test(u) ? '/api/img?u=' + encodeURIComponent(u) : '');
function fromGT(j) {
  const tok = new Map((j.included || []).filter((x) => x.type === 'token').map((x) => [x.id, x.attributes]));
  const dex = new Map((j.included || []).filter((x) => x.type === 'dex').map((x) => [x.id, x.attributes.name]));
  const seen = new Set(), out = [];
  for (const p of j.data || []) { const a = p.attributes, b = tok.get(p.relationships?.base_token?.data?.id); if (!b || !ADDR.test(b.address) || seen.has(b.address.toLowerCase()) || b.address.toLowerCase() === WETH) continue; seen.add(b.address.toLowerCase());
    const tx = a.transactions?.h24 || {};
    out.push({ mint: b.address, pool: a.address, name: b.name, symbol: b.symbol, image: img(b.image_url), dex: dex.get(p.relationships?.dex?.data?.id) || '', price: num(a.base_token_price_usd), mcap: num(a.market_cap_usd) ?? num(a.fdv_usd), liq: num(a.reserve_in_usd),
      vol: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) }, chg: { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h6: num(a.price_change_percentage?.h6), h24: num(a.price_change_percentage?.h24) },
      buys: tx.buys ?? null, sells: tx.sells ?? null, created: a.pool_created_at ? Date.parse(a.pool_created_at) : null }); }
  return out;
}
const TF = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };
async function discover(tab, tf) {
  if (tab === 'new') return cached('disc:new', 40000, async () => fromGT(await get(GT + '/new_pools?include=base_token,dex&page=1')));
  const rows = await cached('disc:tr:' + tf, 60000, async () => { const all = fromGT(await get(GT + `/trending_pools?include=base_token,dex&duration=${TF[tf] || '24h'}&page=1`)); if (!all.length) throw new Error('Market data is catching up'); return all; });
  return tab === 'gainers' ? [...rows].filter((r) => (r.liq || 0) > 3000).sort((a, b) => (b.chg[tf] ?? -1e9) - (a.chg[tf] ?? -1e9)) : rows;
}
function fromDS(p) {
  return { mint: p.baseToken.address, pool: p.pairAddress, name: p.baseToken.name, symbol: p.baseToken.symbol, image: img(p.info?.imageUrl), dex: p.dexId + (p.labels?.[0] ? ' ' + p.labels[0] : ''), quote: p.quoteToken?.symbol, price: num(p.priceUsd), priceNative: num(p.priceNative), mcap: num(p.marketCap) ?? num(p.fdv), fdv: num(p.fdv), liq: num(p.liquidity?.usd), liqBase: num(p.liquidity?.base), liqQuote: num(p.liquidity?.quote),
    vol: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) }, chg: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) }, buys: p.txns?.h24?.buys ?? null, sells: p.txns?.h24?.sells ?? null, created: p.pairCreatedAt || null,
    links: [...(p.info?.websites || []).map((w) => ({ t: 'web', u: w.url })), ...(p.info?.socials || []).map((s) => ({ t: s.type, u: s.url }))].filter((l) => /^https:\/\//.test(l.u)).slice(0, 4) };
}
async function token(mint) {
  return cached('tok:' + mint.toLowerCase(), 8000, async () => { const j = await get(DS + '/tokens/v1/robinhood/' + mint); const pairs = (Array.isArray(j) ? j : []).filter((p) => p.baseToken?.address?.toLowerCase() === mint.toLowerCase()).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)); if (!pairs.length) { const e = new Error('No market found for this token'); e.status = 404; throw e; } return fromDS(pairs[0]); });
}
// read straight from the contract: decimals, supply and whether an owner can still act on it
async function tokenInfo(mint) {
  return cached('info:' + mint.toLowerCase(), 600000, async () => { const [dec, sup, own] = await rpcBatch([call(mint, '0x313ce567'), call(mint, '0x18160ddd'), call(mint, '0x8da5cb5b')]); if (!dec || dec === '0x') return null; const decimals = parseInt(dec, 16);
    const owner = own && own.length >= 66 ? '0x' + own.slice(-40) : null; return { decimals, supply: sup && sup !== '0x' ? Number(BigInt(sup)) / 10 ** decimals : null, owner: owner === null ? null : /^0x0{40}$/.test(owner) ? '' : owner, hasOwner: owner !== null }; });
}
const AGG = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1] };
const ohlcv = (pool, tf) => cached('oh:' + pool + tf, 30000, async () => { const [unit, agg] = AGG[tf] || AGG['15m']; const j = await get(GT + `/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=300&currency=usd`); return (j.data?.attributes?.ohlcv_list || []).map((c) => c.map(Number)).reverse(); });
const trades = (pool) => cached('tr:' + pool, 15000, async () => { const j = await get(GT + `/pools/${pool}/trades`); return (j.data || []).slice(0, 60).map((t) => { const a = t.attributes; return { t: Date.parse(a.block_timestamp), side: a.kind, usd: num(a.volume_in_usd), price: num(a.kind === 'buy' ? a.price_to_in_usd : a.price_from_in_usd), amount: num(a.kind === 'buy' ? a.to_token_amount : a.from_token_amount), who: a.tx_from_address, sig: a.tx_hash }; }); });
const search = (q) => cached('q:' + q.toLowerCase(), 20000, async () => { const j = await get(DS + '/latest/dex/search?q=' + encodeURIComponent(q)); const s = new Set(); return (j.pairs || []).filter((p) => p.chainId === 'robinhood' && p.baseToken.address.toLowerCase() !== WETH && !s.has(p.baseToken.address) && s.add(p.baseToken.address)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 12).map(fromDS); });
const ethPrice = () => cached('ethpx', 20000, async () => { const j = await get(DS + '/tokens/v1/robinhood/' + WETH); const p = (Array.isArray(j) ? j : []).filter((x) => x.baseToken?.address?.toLowerCase() === WETH && /USD/i.test(x.quoteToken?.symbol || '')).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || (Array.isArray(j) ? j : []).find((x) => x.baseToken?.address?.toLowerCase() === WETH); if (!p?.priceUsd) throw new Error('no price'); return +p.priceUsd; });
async function prices(mints) { const out = {}; for (let i = 0; i < mints.length; i += 30) { const part = mints.slice(i, i + 30); const j = await cached('px:' + part.map((m) => m.toLowerCase()).sort().join(','), 12000, () => get(DS + '/tokens/v1/robinhood/' + part.join(','))); for (const p of Array.isArray(j) ? j : []) { const m = p.baseToken?.address?.toLowerCase(); if (m && p.priceUsd && (!out[m] || (p.liquidity?.usd || 0) > out[m].liq)) out[m] = { px: +p.priceUsd, liq: p.liquidity?.usd || 0, symbol: p.baseToken.symbol }; } } return out; }

// ---------- wallets (read-only lookups by address; nothing is remembered) ----------
async function wallet(addr, tokens) {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 40);
  const res = await rpcBatch([['eth_getBalance', [addr, 'latest']], ...list.flatMap((t) => [call(t, '0x70a08231' + pad(addr)), call(t, '0x313ce567')])]);
  const wei = BigInt(res[0] || '0x0'), held = []; for (let i = 0; i < list.length; i++) { const bal = res[1 + i * 2], dec = res[2 + i * 2]; if (!bal || bal === '0x' || BigInt(bal) === 0n) continue; const decimals = dec && dec !== '0x' ? parseInt(dec, 16) : 18; held.push({ mint: list[i], raw: BigInt(bal).toString(), decimals, amount: Number(BigInt(bal)) / 10 ** decimals }); }
  const [px, eth] = await Promise.all([held.length ? prices(held.map((h) => h.mint)).catch(() => ({})) : {}, ethPrice().catch(() => null)]);
  for (const h of held) { const p = px[h.mint]; h.price = p?.px ?? null; h.symbol = p?.symbol || ''; h.usd = p ? p.px * h.amount : null; }
  return { address: addr, wei: wei.toString(), eth: Number(wei) / 1e18, ethUsd: eth, tokens: held.sort((a, b) => (b.usd || 0) - (a.usd || 0)) };
}
async function balances(addrs) { const r = await rpcBatch(addrs.map((a) => ['eth_getBalance', [a, 'latest']])); return Object.fromEntries(addrs.map((a, i) => [a, BigInt(r[i] || '0x0').toString()])); }
async function account(addr) { const [n, gp] = await rpcBatch([['eth_getTransactionCount', [addr, 'pending']], ['eth_gasPrice', []]]); const gas = BigInt(gp || '0x1312d00'); return { nonce: parseInt(n || '0x0', 16), maxFeePerGas: (gas * 2n).toString(), maxPriorityFeePerGas: '0' }; }

// ---------- trade relay: quotes come with the exact transactions to sign ----------
async function quote(b) {
  const j = await get(RELAY + '/quote', { body: { user: b.user || QUOTER, recipient: b.user || QUOTER, originChainId: CHAIN_ID, destinationChainId: CHAIN_ID, originCurrency: b.in, destinationCurrency: b.out, amount: String(b.amount), tradeType: 'EXACT_INPUT', slippageTolerance: String(Math.min(5000, Math.max(1, +b.slip || 100))), ...(FEE_BPS && FEE_TO ? { appFees: [{ recipient: FEE_TO, fee: String(FEE_BPS) }] } : {}) }, timeout: 20000 });
  const d = j.details || {}, steps = (j.steps || []).flatMap((s) => (s.items || []).map((it) => ({ id: s.id, to: it.data.to, data: it.data.data || '0x', value: String(it.data.value || '0'), gas: String(it.data.gas || it.data.gasLimit || '0'), maxFeePerGas: String(it.data.maxFeePerGas || '0'), maxPriorityFeePerGas: String(it.data.maxPriorityFeePerGas || '0') })));
  if (!steps.length || steps.some((s) => !ADDR.test(s.to))) throw Object.assign(new Error('No route for this trade'), { status: 422 });
  return { out: d.currencyOut?.amount, outFormatted: d.currencyOut?.amountFormatted, minOut: d.currencyOut?.minimumAmount, outDecimals: d.currencyOut?.currency?.decimals, usdIn: num(d.currencyIn?.amountUsd), usdOut: num(d.currencyOut?.amountUsd), impact: num(d.totalImpact?.percent ?? d.swapImpact?.percent), steps: b.user ? steps : undefined };
}
async function send(b) { return { sig: await rpc('eth_sendRawTransaction', [b.tx]) }; }

// ---------- camo route: move value in through NEAR Intents so the receiving wallet is paid by the route, not by the sender ----------
const routeTokens = () => cached('route:tokens', 300000, async () => { const j = await get(ONE + '/v0/tokens'); const want = ['ETH', 'USDC', 'USDT', 'USDG', 'SOL', 'BTC', 'ZEC', 'BNB', 'NEAR', 'XRP', 'DOGE', 'TRX', 'SUI', 'LTC', 'TON', 'AVAX', 'POL'];
  return j.filter((t) => want.includes(t.symbol) && t.price).map((t) => ({ id: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, price: t.price })).sort((a, b) => want.indexOf(a.symbol) - want.indexOf(b.symbol) || rank(a.chain) - rank(b.chain) || a.chain.localeCompare(b.chain)); });
const CHAINS = ['hood', 'eth', 'base', 'arb', 'sol', 'bsc', 'btc', 'zec', 'near', 'tron', 'op', 'pol', 'avax', 'sui', 'ton'], rank = (c) => { const i = CHAINS.indexOf(c); return i < 0 ? 99 : i; };
const units = (amt, dec) => { const [a, b = ''] = String(amt).split('.'); return (BigInt(a || '0') * 10n ** BigInt(dec) + BigInt((b + '0'.repeat(dec)).slice(0, dec) || '0')).toString(); };
async function routeQuote(b) {
  const list = await routeTokens(), from = list.find((t) => t.id === b.asset); if (!from) { const e = new Error('Unknown asset'); e.status = 400; throw e; }
  const order = !!b.order, amount = b.raw ? String(b.raw) : units(b.amount, from.decimals);
  const body = { dry: !order, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: from.id, depositType: 'ORIGIN_CHAIN', destinationAsset: ETH_ASSET, amount, deadline: new Date(Date.now() + 2 * 3600e3).toISOString(),
    ...(order ? { refundTo: String(b.refundTo), refundType: 'ORIGIN_CHAIN', recipient: String(b.recipient), recipientType: 'DESTINATION_CHAIN' } : { refundTo: 'intents.near', refundType: 'INTENTS', recipient: 'intents.near', recipientType: 'INTENTS' }), ...(ROUTE_FEE_TO && ROUTE_FEE_BPS ? { appFees: [{ recipient: ROUTE_FEE_TO, fee: ROUTE_FEE_BPS }] } : {}) };
  const j = await get(ONE + '/v0/quote', { body, timeout: 20000 }); const q = j.quote;
  return { from: from.symbol, chain: from.chain, amountIn: q.amountInFormatted, amountInRaw: q.amountIn, out: q.amountOutFormatted, minOutRaw: q.minAmountOut, usd: q.amountInUsd, eta: q.timeEstimate, ...(order ? { deposit: q.depositAddress, memo: q.depositMemo || '', expires: q.deadline } : {}) };
}
async function routeStatus(dep) { const j = await get(ONE + '/v0/status?depositAddress=' + encodeURIComponent(dep)); const d = j.swapDetails || {}; return { status: j.status, out: d.amountOutFormatted || '', refunded: d.refundedAmountFormatted && d.refundedAmountFormatted !== '0' ? d.refundedAmountFormatted : '', txs: (d.destinationChainTxHashes || []).map((t) => t.hash) }; }

// ---------- image relay (so token pictures do not expose visitors to image hosts) ----------
const IMG_HOSTS = /(^|\.)(dexscreener\.com|geckoterminal\.com|coingecko\.com|ipfs\.io|pinata\.cloud|arweave\.net|irys\.xyz|nftstorage\.link|dweb\.link|w3s\.link|relay\.link|githubusercontent\.com)$/i, imgs = new Map();
async function image(u) {
  let url; try { url = new URL(u); } catch { return null; } if (url.protocol !== 'https:' || !IMG_HOSTS.test(url.hostname)) return null;
  const hit = imgs.get(u); if (hit) return hit;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' }); const type = r.headers.get('content-type') || ''; if (!r.ok || !/^image\/(png|jpe?g|webp|gif|avif)/.test(type)) return null;
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 1_500_000) return null;
  if (imgs.size > 600) imgs.delete(imgs.keys().next().value); const v = { type, buf }; imgs.set(u, v); return v;
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/app': 'app.html', '/docs': 'docs.html' };
const SEC = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'permissions-policy': 'interest-cohort=(), geolocation=(), camera=(), microphone=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC }); res.end(JSON.stringify(body)); };
function file(res, name, code = 200) {
  const p = path.join(CLIENT, name); if (!p.startsWith(CLIENT)) return false; let buf; try { buf = fs.readFileSync(p); } catch { return false; }
  const ext = path.extname(p); res.writeHead(code, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300', ...SEC }); res.end(buf); return true;
}
const readBody = (req) => new Promise((ok, bad) => { let n = 0; const parts = []; req.on('data', (d) => { n += d.length; if (n > 200_000) { bad(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else parts.push(d); }); req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}); } catch { bad(Object.assign(new Error('Bad request body'), { status: 400 })); } }); req.on('error', bad); });
// rate limit keyed by a salted hash that changes on every start; the address itself is never kept
const SALT = crypto.randomBytes(16), hits = new Map(); setInterval(() => hits.clear(), 60_000).unref();
const limited = (req, cost) => { const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); const k = crypto.createHash('sha256').update(SALT).update(ip).digest('base64').slice(0, 12); const n = (hits.get(k) || 0) + cost; hits.set(k, n); return n > 600; };
const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); };

async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams, m = req.method;
  if (limited(req, m === 'POST' ? 3 : 1)) return json(res, 429, { error: 'Slow down for a moment' });
  if (p === '/api/config') return json(res, 200, { ...SITE, chainId: CHAIN_ID, fee: FEE_BPS && FEE_TO ? FEE_BPS : 0, eth: await ethPrice().catch(() => null) });
  if (p === '/api/discover') { const tab = ['trending', 'new', 'gainers'].includes(q.get('tab')) ? q.get('tab') : 'trending', tf = TF[q.get('tf')] ? q.get('tf') : 'h24'; return json(res, 200, { rows: await discover(tab, tf), eth: await ethPrice().catch(() => null) }); }
  if (p === '/api/search') { const s = (q.get('q') || '').trim().slice(0, 60); need(s.length >= 2, 'Type at least two characters'); return json(res, 200, { rows: await search(s) }); }
  let mm;
  if ((mm = p.match(/^\/api\/token\/([^/]+)$/))) { need(ADDR.test(mm[1]), 'Not a token address'); const [t, s] = await Promise.all([token(mm[1]), tokenInfo(mm[1]).catch(() => null)]); return json(res, 200, { ...t, info: s }); }
  if ((mm = p.match(/^\/api\/ohlcv\/([^/]+)$/))) { need(POOL.test(mm[1]), 'Not a pool address'); return json(res, 200, { candles: await ohlcv(mm[1].toLowerCase(), AGG[q.get('tf')] ? q.get('tf') : '15m') }); }
  if ((mm = p.match(/^\/api\/trades\/([^/]+)$/))) { need(POOL.test(mm[1]), 'Not a pool address'); return json(res, 200, { trades: await trades(mm[1].toLowerCase()) }); }
  if (p === '/api/wallet' && m === 'POST') { const b = await readBody(req); need(ADDR.test(b.addr || '') && Array.isArray(b.tokens) && b.tokens.every((t) => ADDR.test(t)), 'Bad wallet request'); return json(res, 200, await wallet(b.addr, b.tokens)); }
  if (p === '/api/balances' && m === 'POST') { const b = await readBody(req); need(Array.isArray(b.addrs) && b.addrs.length <= 100 && b.addrs.every((a) => ADDR.test(a)), 'Bad address list'); return json(res, 200, { wei: b.addrs.length ? await balances(b.addrs) : {}, eth: await ethPrice().catch(() => null) }); }
  if ((mm = p.match(/^\/api\/account\/([^/]+)$/))) { need(ADDR.test(mm[1]), 'Not a wallet address'); return json(res, 200, await account(mm[1])); }
  if (p === '/api/quote' && m === 'POST') { const b = await readBody(req); need(ADDR.test(b.in || '') && ADDR.test(b.out || '') && /^\d{1,40}$/.test(String(b.amount || '')) && (!b.user || ADDR.test(b.user)), 'Bad quote request'); return json(res, 200, await quote(b)); }
  if (p === '/api/send' && m === 'POST') { const b = await readBody(req); need(typeof b.tx === 'string' && /^0x02[0-9a-fA-F]{100,20000}$/.test(b.tx), 'Bad transaction'); return json(res, 200, await send(b)); }
  if (p === '/api/status') { const sigs = (q.get('sigs') || '').split(',').filter((s) => HASH.test(s)).slice(0, 20); need(sigs.length, 'No transactions'); const r = await rpcBatch(sigs.map((s) => ['eth_getTransactionReceipt', [s]])); return json(res, 200, { statuses: r.map((x) => (x ? { state: x.status === '0x1' ? 'confirmed' : 'failed' } : null)) }); }
  if (p === '/api/route/tokens') return json(res, 200, { tokens: await routeTokens() });
  if (p === '/api/route/quote' && m === 'POST') { const b = await readBody(req); need(typeof b.asset === 'string' && (/^\d+(\.\d+)?$/.test(String(b.amount || '')) || /^\d+$/.test(String(b.raw || ''))), 'Bad amount'); if (b.order) need(ADDR.test(b.recipient || '') && typeof b.refundTo === 'string' && b.refundTo.length > 10 && b.refundTo.length < 120, 'A refund address on the sending chain is required'); return json(res, 200, await routeQuote(b)); }
  if (p === '/api/route/status') { const d = q.get('deposit') || ''; need(d.length > 10 && d.length < 120, 'Bad deposit address'); return json(res, 200, await routeStatus(d)); }
  if (p === '/api/img') { const v = await image(q.get('u') || '').catch(() => null); if (!v) { res.writeHead(404, { 'cache-control': 'public, max-age=600', ...SEC }); return res.end(); } res.writeHead(200, { 'content-type': v.type, 'cache-control': 'public, max-age=86400', ...SEC }); return res.end(v.buf); }
  return json(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request'); }
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const name = PAGES[url.pathname] || (url.pathname.startsWith('/t/') ? 'app.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!name.includes('..') && file(res, name)) return;
    file(res, '404.html', 404) || json(res, 404, { error: 'Not found' });
  } catch (e) { const code = e.status && e.status >= 400 && e.status < 500 ? e.status : e.rpc ? 400 : 503; if (!res.headersSent) json(res, code, { error: e.message || 'Something went wrong on our side', ...(code === 503 ? { retry: true } : {}) }); else res.end(); }
}).listen(PORT, () => console.log(`camo relay on http://localhost:${PORT}`));
