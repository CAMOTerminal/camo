import * as W from './wallet.js';
import { drawPnl, PNL_THEMES } from './pnl.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ETH = '0x0000000000000000000000000000000000000000', ETH_ASSET = 'nep141:hood.omft.near', ADDR = /^0x[0-9a-fA-F]{40}$/;
const GAS_KEEP = 150_000_000_000_000n, SEND_PAD = 30_000_000_000_000n; // 0.00015 ETH left in a wallet for its own fees; headroom for one send
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = $('#view');

// ---------- relay ----------
async function api(path, body, tries = 3) {
  for (let a = 1; ; a++) {
    let r; try { r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); } catch { r = null; }
    relay(!!r && r.status < 500);
    if (r && r.ok) return r.json();
    const retry = !r || [502, 503, 504].includes(r.status), safe = !body || /\/(balances|wallet|quote|route\/quote)$/.test(path);
    if (retry && safe && a < tries) { await sleep(900 * a); continue; }
    const j = r ? await r.json().catch(() => ({})) : {}; throw Object.assign(new Error(j.error || 'The relay is catching up. Try again in a few seconds'), { status: r?.status || 0 });
  }
}
function relay(ok) { $('#relaydot').classList.toggle('off', !ok); $('#relay').textContent = ok ? 'Relay connected' : 'Reconnecting to the relay'; }

// ---------- formatting ----------
const usd = (n, d = 2) => (n == null || !isFinite(n) ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const SUB = '₀₁₂₃₄₅₆₇₈₉';
function px(n) { if (n == null || !isFinite(n)) return '—'; if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }); if (n >= 1) return '$' + n.toFixed(3); if (n >= 0.001) return '$' + n.toFixed(5);
  const e = Math.floor(-Math.log10(n)), digits = Math.round(n * 10 ** (e + 4)).toString().padStart(4, '0').slice(0, 4); return '$0.0' + String(e).split('').map((c) => SUB[c]).join('') + digits; }
const pct = (n) => (n == null ? '<span class="mute">—</span>' : `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : ''}${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2)}%</span>`);
const qty = (n) => (n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'K' : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const num = (wei) => Number(BigInt(wei || 0)) / 1e18, eth = (wei, d = 5) => num(wei).toFixed(d);
const toWei = (x) => { const [a, b = ''] = String(x).split('.'); return BigInt(a || '0') * 10n ** 18n + BigInt((b + '0'.repeat(18)).slice(0, 18) || '0'); };
const age = (t) => { if (!t) return '—'; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const avatar = (t, cls = '') => `<span class="av ${cls}">${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : esc((t.symbol || '?').slice(0, 2).toUpperCase())}</span>`;
document.addEventListener('error', (e) => { const el = e.target; if (el?.tagName === 'IMG' && el.parentElement?.classList.contains('av')) { el.parentElement.textContent = (el.closest('[data-sym]')?.dataset.sym || '··').slice(0, 2).toUpperCase(); } }, true);
function toast(msg) { $$('.toast').forEach((t) => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3200); }
const copy = async (text, what = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy is blocked in this browser'); } };

// ---------- settings and shared state ----------
const cfg = Object.assign({ quick: 0.01, slip: 100, isolate: true, slices: 1, window: 30, camoed: false }, JSON.parse(localStorage.getItem('camo_cfg') || '{}'));
const saveCfg = () => localStorage.setItem('camo_cfg', JSON.stringify(cfg));
let ethPx = null, comps = [], wei = {}, holdings = {}, timers = [];
const every = (ms, fn) => { const run = async () => { if (!document.hidden) try { await fn(); } catch {} }; timers.push(setInterval(run, ms)); run(); };
function setEth(p) { if (p) { ethPx = p; $('#solpx').textContent = '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 }); } }
function setCamo(on) { cfg.camoed = on; saveCfg(); document.body.classList.toggle('camoed', on); $('#camobtn').classList.toggle('on', on); }
$('#camobtn').addEventListener('click', () => setCamo(!cfg.camoed));
document.addEventListener('keydown', (e) => { if (e.key === '`' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); setCamo(!cfg.camoed); } if (e.key === 'Escape') closeModal(); });

// ---------- vault ----------
const tokensOf = (c) => [...new Set([c.mint, ...(W.data()?.fills || []).filter((f) => f.comp === c.i).map((f) => f.mint)].filter((m) => ADDR.test(m || '')).map((m) => m.toLowerCase()))];
async function lookup(c, extra = []) { const r = await api('/api/wallet', { addr: c.address, tokens: [...new Set([...tokensOf(c), ...extra.map((m) => m.toLowerCase())])] }); holdings[c.address] = r.tokens; wei[c.address] = BigInt(r.wei); setEth(r.ethUsd); return r; }
async function refreshVault(deep) {
  const btn = $('#vaultbtn');
  if (!W.unlocked()) { comps = []; btn.textContent = W.exists() ? 'Unlock vault' : 'Open vault'; btn.className = 'btn'; $('#total').textContent = '—'; return; }
  comps = await W.compartments(); btn.textContent = 'Lock'; btn.className = 'btn ghost';
  try { const r = await api('/api/balances', { addrs: comps.map((c) => c.address) }); for (const a in r.wei) wei[a] = BigInt(r.wei[a]); setEth(r.eth); } catch {}
  if (deep) await Promise.all(comps.map((c) => lookup(c).catch(() => {})));
  $('#total').textContent = usd(total());
}
const total = () => comps.reduce((n, c) => n + num(wei[c.address]) * (ethPx || 0) + (holdings[c.address] || []).reduce((m, t) => m + (t.usd || 0), 0), 0);
$('#vaultbtn').addEventListener('click', () => { if (W.unlocked()) { W.lock(); refreshVault().then(route); toast('Vault locked'); } else vaultDialog(); });
const closeModal = () => { $('#modal').innerHTML = ''; };
function modal(html) { $('#modal').innerHTML = `<div class="veil"><div class="dlg glass">${html}</div></div>`; const v = $('.veil'); v.addEventListener('mousedown', (e) => { if (e.target === v) closeModal(); }); $$('[data-close]', v).forEach((b) => b.addEventListener('click', closeModal)); const f = $('input', v); if (f) f.focus(); return v; }
async function vaultDialog(mode) {
  if (!(await W.supported())) return modal('<h3>This browser cannot sign here</h3><p>CAMO signs every trade inside the tab. Use a current Chrome, Edge, Brave, Safari or Firefox.</p><div class="acts"><button class="btn" data-close>Close</button></div>');
  mode = mode || (W.exists() ? 'unlock' : 'create');
  const v = modal(mode === 'unlock' ? `<h3>Unlock your vault</h3><p>The vault is encrypted in this browser. The passphrase never leaves it.</p><input class="inp" type="password" id="p1" placeholder="Passphrase" autocomplete="current-password"><div class="err" id="err"></div><div class="acts"><button class="btn ghost" id="other">Restore from a key</button><button class="btn" id="go">Unlock</button></div>`
    : `<h3>${mode === 'restore' ? 'Restore a vault' : 'Open a vault'}</h3><p>One seed, made in this tab, derives every compartment wallet. It is encrypted with your passphrase and stored only in this browser.</p>${mode === 'restore' ? '<input class="inp mono" id="rk" placeholder="Recovery key" autocomplete="off" spellcheck="false">' : ''}<input class="inp" type="password" id="p1" placeholder="Passphrase, 8 characters or more" autocomplete="new-password"><input class="inp" type="password" id="p2" placeholder="Repeat it" autocomplete="new-password"><div class="err" id="err"></div><div class="acts">${mode === 'create' ? '<button class="btn ghost" id="other">I have a recovery key</button>' : ''}<button class="btn" id="go">${mode === 'restore' ? 'Restore' : 'Create vault'}</button></div>`);
  $('#other', v)?.addEventListener('click', () => vaultDialog('restore'));
  const go = async () => { const p1 = $('#p1', v).value, err = $('#err', v); $('#go', v).disabled = true;
    try { if (mode === 'unlock') await W.unlock(p1); else { if (p1 !== $('#p2', v).value) throw new Error('The two passphrases do not match'); if (mode === 'restore') await W.restore(p1, $('#rk', v).value); else await W.create(p1); }
      await refreshVault(true); if (mode === 'create') backupDialog(true); else closeModal(); route(); } catch (e) { err.textContent = e.message; $('#go', v).disabled = false; } };
  $('#go', v).addEventListener('click', go); v.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
function backupDialog(first) { const key = W.backup(); const v = modal(`<h3>${first ? 'Save your recovery key' : 'Recovery key'}</h3><p>This key rebuilds every compartment on any device. Anyone holding it controls the funds, and nobody can reset it for you. Write it down before you deposit.</p><div class="box s" id="rkbox">${esc(key)}</div><div class="acts"><button class="btn ghost" id="cp">Copy</button><button class="btn" data-close>${first ? 'I saved it' : 'Done'}</button></div>`); $('#cp', v).addEventListener('click', () => copy(key, 'Recovery key copied')); }

// ---------- PnL card: your result as a picture, with no wallet on it ----------
function pnlDialog(d) {
  const o = { theme: cfg.pnlTheme || 'green', amounts: cfg.pnlAmounts !== false, tag: 'Position' };
  const v = modal(`<h3>PnL card</h3><p>Made in this tab from your own fills. It shows the result and never the wallet.</p><canvas id="pnlcv" style="width:100%;border-radius:12px;display:block;margin-bottom:12px"></canvas><div class="row"><span>Look</span><div class="chips" id="pth" style="margin:0;width:230px">${PNL_THEMES.map((t) => `<button data-v="${t}" class="${o.theme === t ? 'on' : ''}">${t}</button>`).join('')}</div></div><div class="row"><span>Show ETH amounts</span><button class="sw ${o.amounts ? 'on' : ''}" id="pam"></button></div><div class="acts"><button class="btn ghost" id="pcp">Copy image</button><button class="btn" id="pdl">Download</button></div>`);
  const cv = $('#pnlcv', v), paint = () => drawPnl(cv, d, o); document.fonts.ready.then(paint); paint();
  $('#pth', v).addEventListener('click', (e) => { const t = e.target.dataset.v; if (!t) return; o.theme = cfg.pnlTheme = t; saveCfg(); $$('#pth button', v).forEach((b) => b.classList.toggle('on', b === e.target)); paint(); });
  $('#pam', v).addEventListener('click', (e) => { o.amounts = cfg.pnlAmounts = !o.amounts; saveCfg(); e.target.classList.toggle('on', o.amounts); paint(); });
  $('#pdl', v).addEventListener('click', () => { const a = document.createElement('a'); a.download = `camo-pnl-${d.symbol.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`; a.href = cv.toDataURL('image/png'); a.click(); toast('Card saved'); });
  $('#pcp', v).addEventListener('click', () => cv.toBlob(async (b) => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('Card copied'); } catch { toast('Copy is blocked here. Use Download'); } }));
}

// ---------- orders: every multi-step action shows its steps and where it is ----------
function order(title, labels) {
  const el = document.createElement('div'); el.className = 'order glass'; el.innerHTML = `<button class="x" title="Dismiss">×</button><b>${esc(title)}</b><ol>${labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`; $('#orders').append(el);
  $('.x', el).addEventListener('click', () => el.remove()); const li = $$('li', el); let at = -1;
  return { step(note) { if (at >= 0) li[at].className = 'done'; at++; if (li[at]) { li[at].className = 'now'; if (note) li[at].textContent = note; } }, note(t) { if (li[at]) li[at].textContent = t; }, done(msg) { li.forEach((l) => { if (l.className === 'now') l.className = 'done'; }); if (msg) { const p = document.createElement('div'); p.style.marginTop = '6px'; p.textContent = msg; el.append(p); } setTimeout(() => el.remove(), 15000); },
    fail(msg) { if (li[at]) { li[at].className = 'fail'; li[at].textContent = msg; } else { const p = document.createElement('div'); p.className = 'err'; p.textContent = msg; el.append(p); } } };
}
async function confirmTx(hash, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { await sleep(1500); try { const s = (await api('/api/status?sigs=' + hash)).statuses[0]; if (s?.state === 'failed') throw Object.assign(new Error('The chain reverted the transaction'), { final: true }); if (s) return true; } catch (e) { if (e.final) throw e; } } return false; }
const maxBig = (a, b) => (a > b ? a : b);
// Sign and send one transaction from a compartment, then wait for it to be mined.
async function sendTx(i, addr, t, acct) { acct = acct || await api('/api/account/' + addr); const raw = await W.signTx(i, { to: t.to, value: BigInt(t.value || 0), data: t.data || '0x', gas: t.gas, maxFeePerGas: maxBig(BigInt(t.maxFeePerGas || 0), BigInt(acct.maxFeePerGas)), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas || 0), nonce: acct.nonce });
  const { sig } = await api('/api/send', { tx: raw }); acct.nonce++; if (!(await confirmTx(sig))) throw new Error('The transaction was not confirmed in time. Check the balance before trying again'); return sig; }
const sendEth = (i, from, to, amount) => sendTx(i, from, { to, value: amount, gas: W.TRANSFER_GAS });
// Move ETH between two of our own wallets through the route: the receiver is paid by the route, not by the sender.
async function routeMove(o, fromI, fromAddr, toAddr, amount) {
  o.step(); const q = await api('/api/route/quote', { asset: ETH_ASSET, raw: amount.toString(), order: true, recipient: toAddr, refundTo: fromAddr });
  W.data().routes.unshift({ at: Date.now(), deposit: q.deposit, from: 'ETH', chain: 'hood', amountIn: q.amountIn, to: toAddr, kind: 'move' }); await W.save();
  await sendEth(fromI, fromAddr, q.deposit, BigInt(q.amountInRaw)); const before = wei[toAddr] || 0n, want = BigInt(q.minOutRaw) * 98n / 100n;
  o.step(); const end = Date.now() + 15 * 60000;
  while (Date.now() < end) { await sleep(3500); try { const r = await api('/api/balances', { addrs: [toAddr] }); const now = BigInt(r.wei[toAddr]); if (now - before >= want) { wei[toAddr] = now; return now - before; } const s = await api('/api/route/status?deposit=' + encodeURIComponent(q.deposit)); if (/REFUNDED|FAILED/.test(s.status)) throw Object.assign(new Error('The route returned the funds to the sending wallet'), { final: true }); o.note('Route is working: ' + s.status.toLowerCase().replace(/_/g, ' ')); } catch (e) { if (e.final) throw e; } }
  throw new Error('The route is taking longer than usual. The funds arrive or return on their own; see Activity');
}
// One swap: the relay returns the exact transactions (an approval first when selling), we sign and send them in order.
async function swap(o, c, inAddr, outAddr, amount, label) {
  o.note(label + ': pricing'); const q = await api('/api/quote', { user: c.address, in: inAddr, out: outAddr, amount: amount.toString(), slip: cfg.slip }), acct = await api('/api/account/' + c.address); let sig;
  for (const [k, s] of q.steps.entries()) { o.note(label + (q.steps.length > 1 ? (s.id === 'approve' ? ': approving' : ': swapping') : ': sent')); sig = await sendTx(c.i, c.address, { to: s.to, value: s.value, data: s.data, gas: BigInt(s.gas) > 0n ? BigInt(s.gas) * 13n / 10n : 600000n, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }, acct); if (k < q.steps.length - 1) await sleep(600); }
  return { sig, q };
}
const randParts = (totalWei, n) => { const w = Array.from({ length: n }, () => BigInt(Math.floor((0.6 + Math.random()) * 1e6))), s = w.reduce((a, b) => a + b, 0n); const parts = w.map((x) => totalWei * x / s); parts[0] += totalWei - parts.reduce((a, b) => a + b, 0n); return parts; };
async function fill(side, t, c, ethAmt, tokAmt, sig) { W.data().fills.unshift({ at: Date.now(), side, mint: t.mint.toLowerCase(), symbol: t.symbol, sol: ethAmt, tok: tokAmt, sig, comp: c.i, label: c.label }); W.data().fills.length = Math.min(W.data().fills.length, 500); await W.save(); }
async function buy(t, ethAmount, compI) {
  if (!W.unlocked()) return vaultDialog();
  const amount = toWei(ethAmount), slices = Math.max(1, Math.min(6, cfg.slices | 0)), iso = compI === 'new', reserve = comps[0];
  const steps = [...(iso ? ['Send from Reserve into the camo route', 'Route pays the new compartment'] : []), ...Array.from({ length: slices }, (_, k) => (slices > 1 ? `Slice ${k + 1} of ${slices}` : 'Buy ' + t.symbol))];
  const o = order(`Buy ${t.symbol} · ${ethAmount} ETH${iso ? ' · isolated' : ''}`, steps);
  try {
    let c = comps.find((x) => x.i === compI);
    if (iso) { const need = amount + GAS_KEEP; if ((wei[reserve.address] || 0n) < need + SEND_PAD) throw new Error(`Reserve needs ${eth(need + SEND_PAD)} ETH for this order`);
      c = await W.newCompartment(t.symbol, t.mint.toLowerCase(), 'route'); comps = await W.compartments(); await routeMove(o, 0, reserve.address, c.address, need); }
    else if ((wei[c.address] || 0n) < amount + GAS_KEEP) throw new Error(`${c.label} needs ${eth(amount + GAS_KEEP)} ETH for this order (the amount plus network fees)`);
    const have = BigInt((await api('/api/balances', { addrs: [c.address] })).wei[c.address]), spend = have - GAS_KEEP < amount ? have - GAS_KEEP : amount;
    if (spend < 100_000_000_000_000n) throw new Error('Not enough arrived to place the order');
    const parts = randParts(spend, slices); let got = 0;
    for (let k = 0; k < slices; k++) { o.step(); if (k) { const wait = cfg.window * 1000 / slices * (0.5 + Math.random()); o.note(`Slice ${k + 1}: waiting ${Math.round(wait / 1000)}s`); await sleep(wait); }
      const r = await swap(o, c, ETH, t.mint, parts[k], slices > 1 ? `Slice ${k + 1} of ${slices}` : 'Buy ' + t.symbol); const tok = Number(BigInt(r.q.out)) / 10 ** (r.q.outDecimals ?? 18); got += tok; await fill('buy', t, c, num(parts[k]), tok, r.sig); }
    o.done(`Bought about ${qty(got)} ${t.symbol} in ${c.label}`);
  } catch (e) { o.fail(e.message); }
  await refreshVault(true); rerender();
}
async function sell(t, c, fraction) {
  const o = order(`Sell ${Math.round(fraction * 100)}% ${t.symbol} · ${c.label}`, ['Sell ' + t.symbol]);
  try { const w = await lookup(c, [t.mint]), h = w.tokens.find((x) => x.mint === t.mint.toLowerCase()); if (!h) throw new Error('This compartment holds none of this token');
    const raw = fraction >= 1 ? BigInt(h.raw) : BigInt(h.raw) * BigInt(Math.round(fraction * 10000)) / 10000n; o.step(); const r = await swap(o, c, t.mint, ETH, raw, 'Sell ' + t.symbol);
    await fill('sell', t, c, num(r.q.out), Number(raw) / 10 ** h.decimals, r.sig); o.done(`Sold for about ${eth(r.q.out)} ETH`);
  } catch (e) { o.fail(e.message); }
  await refreshVault(true); rerender();
}

// ---------- discover ----------
let disc = { tab: 'trending', tf: 'h24', rows: null };
function rowHtml(r, i, tf) { return `<tr data-mint="${esc(r.mint)}" data-sym="${esc(r.symbol)}"><td class="mute n">${i + 1}</td><td><div class="tk">${avatar(r)}<div><b>${esc(r.name)}</b><small>${esc(r.symbol)} · ${esc(r.dex || '')}</small></div></div></td><td class="n">${px(r.price)}<br><small>${pct(r.chg?.[tf])}</small></td><td class="n">${usd(r.mcap)}</td><td class="n">${usd(r.vol?.[tf])}</td><td class="n hide-s">${usd(r.liq)}</td><td class="n hide-s"><span class="up">${r.buys ?? '—'}</span> / <span class="down">${r.sells ?? '—'}</span></td><td class="n hide-s">${age(r.created)}</td><td><button class="btn sm buy" data-quick="${esc(r.mint)}">Buy ${cfg.quick}</button></td></tr>`; }
function renderDiscover() {
  view.innerHTML = `<div class="bar"><h1 class="h1">Discover</h1><div class="seg" id="dtab">${[['trending', 'Trending'], ['new', 'New pairs'], ['gainers', 'Top gainers']].map(([k, l]) => `<button data-k="${k}" class="${disc.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="seg" id="dtf">${[['m5', '5m'], ['h1', '1h'], ['h6', '6h'], ['h24', '24h']].map(([k, l]) => `<button data-k="${k}" class="${disc.tf === k ? 'on' : ''}">${l}</button>`).join('')}</div><label class="qb">Quick buy <input id="quick" value="${cfg.quick}" inputmode="decimal"> ETH</label></div>
  <div class="glass tbl"><table><thead><tr><th>#</th><th>Token</th><th>Price</th><th>Market cap</th><th>Volume</th><th class="hide-s">Liquidity</th><th class="hide-s">Buys / sells</th><th class="hide-s">Age</th><th></th></tr></thead><tbody id="drows">${disc.rows ? '' : Array.from({ length: 12 }, () => '<tr class="skel"><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td class="hide-s">0</td><td class="hide-s">0</td><td class="hide-s">0</td><td>0</td></tr>').join('')}</tbody></table></div>`;
  const paint = () => { if (disc.rows) $('#drows').innerHTML = disc.rows.length ? disc.rows.map((r, i) => rowHtml(r, i, disc.tf)).join('') : '<tr><td colspan="9" class="mute" style="text-align:center;padding:40px">Nothing to show for this window yet.</td></tr>'; };
  const load = async () => { const r = await api(`/api/discover?tab=${disc.tab}&tf=${disc.tf}`); disc.rows = r.rows; setEth(r.eth); if ($('#drows')) paint(); };
  paint(); every(30000, load);
  $('#dtab').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) { disc.tab = k; disc.rows = null; route(); } });
  $('#dtf').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) { disc.tf = k; disc.rows = null; route(); } });
  $('#quick').addEventListener('change', (e) => { const n = +e.target.value; if (n > 0) { cfg.quick = n; saveCfg(); paint(); } });
  $('#drows').addEventListener('click', async (e) => { const q = e.target.closest('[data-quick]'), tr = e.target.closest('tr[data-mint]'); if (q) { e.stopPropagation(); const t = disc.rows.find((r) => r.mint === q.dataset.quick); if (!W.unlocked()) return vaultDialog(); return buy(t, cfg.quick, cfg.isolate ? 'new' : 0); } if (tr) location.hash = '#/t/' + tr.dataset.mint; });
}

// ---------- token ----------
let tk = null, side = 'buy', tf = '15m', candles = [], hover = null;
function drawChart() {
  const cv = $('#cv'); if (!cv) return; const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement), UP = css.getPropertyValue('--up').trim(), DOWN = css.getPropertyValue('--down').trim(), MUTE = css.getPropertyValue('--mute').trim(), HI = css.getPropertyValue('--deep').trim(); g.font = '11px "Geist Mono", monospace';
  if (!candles?.length) { g.fillStyle = MUTE; g.textAlign = 'center'; g.fillText(candles === null ? 'No chart for this pool yet' : 'Loading chart', w / 2, h / 2); return; }
  const R = 74, B = 22, T = 44, cw = w - R, ch = h - B - T, volH = ch * 0.16, n = Math.min(candles.length, Math.max(30, Math.floor(cw / 7))), data = candles.slice(-n), step = cw / n;
  let lo = Math.min(...data.map((c) => c[3])), hi = Math.max(...data.map((c) => c[2])); const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad; const vmax = Math.max(...data.map((c) => c[5])) || 1;
  const y = (p) => T + (hi - p) / (hi - lo) * (ch - volH - 8), fmt = (p) => px(p).replace('$', '');
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.fillStyle = MUTE; g.textAlign = 'left'; g.lineWidth = 1;
  for (let i = 0; i <= 5; i++) { const p = lo + (hi - lo) * i / 5, yy = Math.round(y(p)) + .5; g.beginPath(); g.moveTo(0, yy); g.lineTo(cw, yy); g.stroke(); g.fillText(fmt(p), cw + 8, yy + 4); }
  const tfmt = (t) => { const d = new Date(t * 1000); return tf === '1d' || tf === '4h' ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); };
  g.textAlign = 'center'; for (let i = Math.floor(n / 6); i < n; i += Math.ceil(n / 6)) g.fillText(tfmt(data[i][0]), i * step + step / 2, h - 6);
  data.forEach((c, i) => { const [, o, hh, l, cl, v] = c, up = cl >= o, x = i * step + step / 2, bw = Math.max(1, step * 0.66); g.fillStyle = g.strokeStyle = up ? UP : DOWN;
    g.globalAlpha = 0.3; g.fillRect(x - bw / 2, T + ch - v / vmax * volH, bw, v / vmax * volH); g.globalAlpha = 1;
    g.beginPath(); g.moveTo(Math.round(x) + .5, y(hh)); g.lineTo(Math.round(x) + .5, y(l)); g.stroke(); g.fillRect(x - bw / 2, Math.min(y(o), y(cl)), bw, Math.max(1, Math.abs(y(o) - y(cl)))); });
  const last = data[data.length - 1][4], ly = y(last); g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.moveTo(0, ly); g.lineTo(cw, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = HI; g.fillRect(cw + 2, ly - 9, R - 4, 18); g.fillStyle = '#04130a'; g.textAlign = 'left'; g.fillText(fmt(last), cw + 8, ly + 4);
  if (hover && hover.x < cw) { const i = Math.min(n - 1, Math.max(0, Math.floor(hover.x / step))), c = data[i], x = Math.round(i * step + step / 2) + .5; g.strokeStyle = 'rgba(255,255,255,.3)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ch); g.moveTo(0, hover.y + .5); g.lineTo(cw, hover.y + .5); g.stroke();
    g.fillStyle = '#b8c4bb'; g.textAlign = 'left'; g.fillText(`${tfmt(c[0])}   O ${fmt(c[1])}  H ${fmt(c[2])}  L ${fmt(c[3])}  C ${fmt(c[4])}  V ${usd(c[5])}`, 14, h - B - 8 - volH); }
}
const holdOf = (c, mint) => (holdings[c.address] || []).find((h) => h.mint === mint.toLowerCase());
function tradePane() {
  const p = $('#pane'); if (!p || !tk) return; const holders = comps.filter((c) => holdOf(c, tk.mint)), locked = !W.unlocked();
  const opts = side === 'buy' ? `${cfg.isolate ? '<option value="new">New compartment (isolated)</option>' : ''}${comps.map((c) => `<option value="${c.i}">${esc(c.label)} · ${eth(wei[c.address], 4)} ETH</option>`).join('')}${cfg.isolate ? '' : '<option value="new">New compartment (isolated)</option>'}`
    : holders.map((c) => `<option value="${c.i}">${esc(c.label)} · ${qty(holdOf(c, tk.mint).amount)} ${esc(tk.symbol)}</option>`).join('');
  p.innerHTML = `<div class="bs"><button class="${side === 'buy' ? 'on b' : ''}" data-side="buy">Buy</button><button class="${side === 'sell' ? 'on s2' : ''}" data-side="sell">Sell</button></div>
    <div class="lab"><span>${side === 'buy' ? 'Pay from' : 'Sell from'}</span></div>${locked ? '<div class="hint">Open your vault to trade.</div>' : opts ? `<select class="sel s" id="from">${opts}</select>` : '<div class="hint">No compartment holds this token.</div>'}
    ${side === 'buy' ? `<div class="lab"><span>You pay</span><span class="s">Reserve ${eth(wei[comps[0]?.address], 4)} ETH</span></div><div class="field"><input id="amt" value="${cfg.quick}" inputmode="decimal"><b>ETH</b></div><div class="chips" id="pre">${[0.005, 0.01, 0.05, 0.1].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</div>`
      : `<div class="lab"><span>Amount</span></div><div class="chips" id="pre">${[25, 50, 75, 100].map((v) => `<button data-v="${v}" class="${v === 100 ? 'on' : ''}">${v}%</button>`).join('')}</div>`}
    <div class="quote mono" id="qt">${side === 'buy' ? 'Enter an amount for a live quote' : 'Pick how much to sell'}</div>
    <div class="row"><span>No public mempool <small class="mute">orders go straight to the sequencer</small></span><span class="pill ok">on</span></div>
    ${side === 'buy' ? `<div class="row"><span>Scatter <small class="mute">random slices over time</small></span><select class="sel" id="slices" style="width:auto;height:30px">${[1, 2, 3, 4, 6].map((n) => `<option value="${n}" ${cfg.slices === n ? 'selected' : ''}>${n === 1 ? 'Off' : n + ' slices'}</option>`).join('')}</select></div>` : ''}
    <div class="row"><span>Slippage</span><div class="chips" id="slip" style="margin:0;width:150px">${[50, 100, 300].map((v) => `<button data-v="${v}" class="${cfg.slip === v ? 'on' : ''}">${v / 100}%</button>`).join('')}</div></div>
    <button class="btn wide ${side}" id="go" style="margin-top:10px">${locked ? (W.exists() ? 'Unlock vault' : 'Open vault') : side === 'buy' ? 'Buy ' + esc(tk.symbol) : 'Sell ' + esc(tk.symbol)}</button>`;
  let frac = 1, qn = 0;
  const impact = (q) => (q.impact == null ? '' : `impact ${Math.abs(q.impact).toFixed(2)}% · `);
  const quote = async () => { const el = $('#qt'), id = ++qn; if (!el) return; try { if (side === 'buy') { const a = +$('#amt').value; if (!(a > 0)) return (el.textContent = 'Enter an amount for a live quote'); const q = await api('/api/quote', { in: ETH, out: tk.mint, amount: toWei($('#amt').value).toString(), slip: cfg.slip }); if (id !== qn) return; el.innerHTML = `≈ ${qty(+q.outFormatted)} ${esc(tk.symbol)}<br><span class="mute">${impact(q)}${usd(q.usdIn ?? a * (ethPx || 0))}</span>`; }
      else { const c = comps.find((x) => x.i === +$('#from')?.value), h = c && holdOf(c, tk.mint); if (!h) return (el.textContent = 'Pick how much to sell'); const raw = BigInt(h.raw) * BigInt(Math.round(frac * 10000)) / 10000n; if (raw <= 0n) return; const q = await api('/api/quote', { in: tk.mint, out: ETH, amount: raw.toString(), slip: cfg.slip }); if (id !== qn) return; el.innerHTML = `≈ ${(+q.outFormatted).toFixed(5)} ETH<br><span class="mute">${impact(q)}${usd(q.usdOut)}</span>`; } } catch (e) { if (id === qn) el.textContent = e.message; } };
  let deb; const later = () => { clearTimeout(deb); deb = setTimeout(quote, 400); };
  $$('[data-side]', p).forEach((b) => b.addEventListener('click', () => { side = b.dataset.side; tradePane(); }));
  $('#amt', p)?.addEventListener('input', later); $('#from', p)?.addEventListener('change', later);
  $('#pre', p)?.addEventListener('click', (e) => { const v = e.target.dataset.v; if (!v) return; if (side === 'buy') $('#amt').value = v; else { frac = +v / 100; $$('#pre button').forEach((b) => b.classList.toggle('on', b === e.target)); } later(); });
  $('#slip', p).addEventListener('click', (e) => { const v = +e.target.dataset.v; if (v) { cfg.slip = v; saveCfg(); $$('#slip button').forEach((b) => b.classList.toggle('on', b === e.target)); later(); } });
  $('#slices', p)?.addEventListener('change', (e) => { cfg.slices = +e.target.value; saveCfg(); });
  $('#go', p).addEventListener('click', () => { if (locked) return vaultDialog(); const from = $('#from')?.value; if (side === 'buy') { const a = $('#amt').value.trim(); if (!(+a > 0)) return toast('Enter an amount'); cfg.isolate = from === 'new'; saveCfg(); buy(tk, a, from === 'new' ? 'new' : +from); } else { const c = comps.find((x) => x.i === +from); if (!c) return toast('No compartment holds this token'); sell(tk, c, frac); } });
  later();
}
function renderToken(mint) {
  tk = tk?.mint?.toLowerCase() === mint.toLowerCase() ? tk : null; candles = [];
  view.innerHTML = `<div class="thead glass" id="th"><span class="mute">Loading the market</span></div><div class="tgrid"><div><div class="chart glass"><div class="seg tfs" id="tfs">${['1m', '5m', '15m', '1h', '4h', '1d'].map((k) => `<button data-k="${k}" class="${tf === k ? 'on' : ''}">${k}</button>`).join('')}</div><div class="chg" id="chg"></div><canvas id="cv"></canvas></div>
    <div class="sub glass"><div class="seg" id="stab"><button class="on" data-k="trades">Trades</button><button data-k="mine">My fills</button></div><div class="scroll"><table><thead id="sth"></thead><tbody id="sbody"></tbody></table></div></div></div>
    <div class="side"><div class="pane glass" id="pane"></div><div class="pane glass" id="pos"></div><div class="pane glass" id="facts"></div></div></div>`;
  let sub = 'trades', tape = [];
  const head = () => { const t = tk; document.title = `${t.symbol} ${px(t.price)} · CAMO`; $('#th').dataset.sym = t.symbol; $('#th').innerHTML = `${avatar(t, 'lg')}<div><b style="font-size:17px">${esc(t.name)}</b> <span class="mute">${esc(t.symbol)}</span><br><button class="copy" data-copy="${esc(t.mint)}">${short(t.mint)} ⧉</button></div><div class="px n">${px(t.price)}</div>
      ${[['Market cap', usd(t.mcap)], ['Liquidity', usd(t.liq)], ['24h volume', usd(t.vol.h24)], ['Buys', `<span class="up">${t.buys ?? '—'}</span>`], ['Sells', `<span class="down">${t.sells ?? '—'}</span>`], ['Age', age(t.created)]].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('')}`;
    $('#chg').innerHTML = [['5m', t.chg.m5], ['1h', t.chg.h1], ['6h', t.chg.h6], ['24h', t.chg.h24]].map(([k, v]) => `<span>${k} ${pct(v)}</span>`).join('');
    const i = t.info; $('#facts').innerHTML = `<p class="title">Token</p><div class="kv"><span>Contract owner</span><b>${i ? (!i.hasOwner ? '<span class="pill">none declared</span>' : i.owner ? '<span class="pill warn">active</span>' : '<span class="pill ok">renounced</span>') : '—'}</b><span>Supply</span><b>${i?.supply != null ? qty(i.supply) : '—'}</b><span>Pool</span><b>${esc(t.dex)} · <button class="copy" data-copy="${esc(t.pool)}">${short(t.pool)}</button></b><span>Pooled</span><b>${qty(t.liqBase)} ${esc(t.symbol)} / ${qty(t.liqQuote)} ${esc(t.quote || '')}</b>${t.links?.length ? `<span>Links</span><b>${t.links.map((l) => `<a href="${esc(l.u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l.t)}</a>`).join(' · ')}</b>` : ''}</div>`; };
  const pos = () => { const el = $('#pos'); if (!el || !tk) return; const hs = comps.map((c) => ({ c, h: holdOf(c, mint) })).filter((x) => x.h), fills = (W.data()?.fills || []).filter((f) => f.mint === mint.toLowerCase()), inS = fills.filter((f) => f.side === 'buy').reduce((n, f) => n + f.sol, 0), outS = fills.filter((f) => f.side === 'sell').reduce((n, f) => n + f.sol, 0), val = hs.reduce((n, x) => n + x.h.amount, 0) * (tk.price || 0);
    const pnl = ethPx ? val + (outS - inS) * ethPx : null; el.innerHTML = `<p class="title">Your position</p><div class="kv s"><span>Holding</span><b>${hs.length ? qty(hs.reduce((n, x) => n + x.h.amount, 0)) + ' ' + esc(tk.symbol) : '—'}</b><span>Value</span><b>${hs.length ? usd(val) : '—'}</b><span>Bought</span><b>${inS ? inS.toFixed(5) + ' ETH' : '—'}</b><span>Sold</span><b>${outS ? outS.toFixed(5) + ' ETH' : '—'}</b><span>Result</span><b>${fills.length && pnl != null ? `<span class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${usd(Math.abs(pnl))}</span>` : '—'}</b><span>Held in</span><b>${hs.length ? hs.map((x) => esc(x.c.label)).join(', ') : '—'}</b></div>${inS > 0 ? '<button class="btn sm ghost" id="pnlbtn" style="width:100%;margin-top:12px">PnL card</button>' : ''}`;
    $('#pnlbtn')?.addEventListener('click', () => pnlDialog({ symbol: tk.symbol, inSol: inS, outSol: outS, valueSol: ethPx ? val / ethPx : 0, solUsd: ethPx, since: Math.min(...fills.map((f) => f.at)) })); };
  const table = () => { if (!$('#sbody')) return; if (sub === 'trades') { $('#sth').innerHTML = '<tr><th>Age</th><th>Side</th><th>Price</th><th>Amount</th><th>Value</th><th class="hide-s">Trader</th></tr>'; $('#sbody').innerHTML = tape.length ? tape.map((t) => `<tr><td class="mute n">${age(t.t)}</td><td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="n">${px(t.price)}</td><td class="n">${qty(t.amount)}</td><td class="n ${t.side === 'buy' ? 'up' : 'down'}">${usd(t.usd)}</td><td class="n mute hide-s">${short(t.who)}</td></tr>`).join('') : '<tr><td colspan="6" class="mute" style="text-align:center;padding:30px">Waiting for trades</td></tr>'; }
    else { const fills = (W.data()?.fills || []).filter((f) => f.mint === mint.toLowerCase()); $('#sth').innerHTML = '<tr><th>Age</th><th>Side</th><th>ETH</th><th>Tokens</th><th>Compartment</th><th class="hide-s">Tx</th></tr>'; $('#sbody').innerHTML = fills.length ? fills.map((f) => `<tr class="s"><td class="mute n">${age(f.at)}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="n">${f.sol.toFixed(5)}</td><td class="n">${qty(f.tok)}</td><td>${esc(f.label)}</td><td class="hide-s"><button class="copy" data-copy="${esc(f.sig)}">${short(f.sig)}</button></td></tr>`).join('') : '<tr><td colspan="6" class="mute" style="text-align:center;padding:30px">Your fills on this token appear here</td></tr>'; } };
  const loadCandles = async () => { if (!tk) return; try { const c = (await api(`/api/ohlcv/${tk.pool}?tf=${tf}`)).candles; candles = c.length ? c : null; } catch { if (!candles?.length) candles = null; } drawChart(); };
  const loadTape = async () => { if (!tk) return; try { tape = (await api('/api/trades/' + tk.pool)).trades; } catch {} if (sub === 'trades') table(); };
  every(10000, async () => { const first = !tk; try { tk = await api('/api/token/' + mint); } catch (e) { if (first && $('#th')) $('#th').innerHTML = `<span>${esc(e.message)}</span>`; return; } if (!$('#th')) return; head(); pos(); if (first) { tradePane(); loadCandles(); loadTape(); if (W.unlocked()) Promise.all(comps.map((c) => lookup(c, [mint]).catch(() => {}))).then(() => { tradePane(); pos(); }); } });
  timers.push(setInterval(() => { if (!document.hidden) loadTape(); }, 16000), setInterval(() => { if (!document.hidden) loadCandles(); }, 31000));
  $('#tfs').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) { tf = k; $$('#tfs button').forEach((b) => b.classList.toggle('on', b === e.target)); candles = []; drawChart(); loadCandles(); } });
  $('#stab').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) { sub = k; $$('#stab button').forEach((b) => b.classList.toggle('on', b === e.target)); table(); } });
  const cv = $('#cv'); cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; drawChart(); }); cv.addEventListener('mouseleave', () => { hover = null; drawChart(); });
  if (tk) { head(); tradePane(); } pos(); table(); drawChart();
}
window.addEventListener('resize', drawChart);

// ---------- compartments ----------
const SRC = { direct: ['Reserve', ''], route: ['Paid by the route', 'ok'], pending: ['Empty', ''] };
function renderVault() {
  if (!W.unlocked()) { view.innerHTML = `<div class="empty"><h2>One vault. A wallet for every position.</h2><p>CAMO keeps each token in its own compartment wallet, made in this tab from a single seed. Compartments are funded through a route that pays them from its own wallet, so no explorer shows one of them paying another.</p><button class="btn" id="open">${W.exists() ? 'Unlock vault' : 'Open a vault'}</button></div>`; $('#open').addEventListener('click', () => vaultDialog()); return; }
  const paint = () => { view.innerHTML = `<div class="vhead"><div><div class="title" style="margin:0">Vault value</div><div class="big s">${usd(total())}</div></div><div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="fund" data-i="0">Fund Reserve</button><button class="btn ghost" data-act="new">New compartment</button><button class="btn ghost" data-act="backup">Recovery key</button></div></div>
    <div class="cards">${comps.map((c) => { const [lab, cls] = SRC[c.i === 0 ? 'direct' : c.src] || SRC.pending, hs = holdings[c.address] || []; return `<div class="card glass"><div class="hd"><b>${esc(c.label)}</b><span class="pill ${cls}">${lab}</span></div><button class="copy s" data-copy="${esc(c.address)}" style="text-align:left">${esc(c.address)} ⧉</button><div class="bal s n">${eth(wei[c.address])} <small class="mute" style="font-size:13px">ETH · ${usd(num(wei[c.address]) * (ethPx || 0))}</small></div>
      ${hs.map((h) => `<a class="hold s" href="#/t/${esc(h.mint)}"><span class="mono">${qty(h.amount)} ${esc(h.symbol || short(h.mint))}</span><span class="mono">${usd(h.usd)}</span></a>`).join('')}
      <div class="acts"><button class="btn sm ghost" data-act="fund" data-i="${c.i}">Fund</button><button class="btn sm ghost" data-act="send" data-i="${c.i}">Send</button>${c.i ? `<button class="btn sm ghost" data-act="home" data-i="${c.i}">Return to Reserve</button><button class="btn sm ghost" data-act="burn" data-i="${c.i}">Burn</button>` : ''}<button class="btn sm ghost" data-act="key" data-i="${c.i}">Key</button></div></div>`; }).join('')}</div>`; };
  paint(); every(20000, async () => { await refreshVault(true); if ($('.cards') && !$('.veil')) paint(); });
}
view.addEventListener('click', (e) => { const cp = e.target.closest('[data-copy]'); if (cp) { e.preventDefault(); return copy(cp.dataset.copy); } const a = e.target.closest('[data-act]'); if (!a) return; const c = comps.find((x) => x.i === +a.dataset.i);
  ({ fund: () => fundDialog(c), send: () => sendDialog(c), key: () => keyDialog(c), backup: () => backupDialog(), new: newDialog, home: () => homeDialog(c), burn: () => burnDialog(c) })[a.dataset.act]?.(); });
function newDialog() { const v = modal('<h3>New compartment</h3><p>A fresh wallet from your seed. Fund it through the route and nothing on-chain ties it to your other compartments.</p><input class="inp" id="lb" placeholder="Label" maxlength="24"><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Create</button></div>'); $('#go', v).addEventListener('click', async () => { await W.newCompartment($('#lb', v).value.trim() || 'Compartment ' + W.data().next); closeModal(); await refreshVault(); route(); }); }
async function keyDialog(c) { const k = await W.secretKey(c.i); const v = modal(`<h3>${esc(c.label)} · private key</h3><p>Import this into Robinhood Wallet, MetaMask or any EVM wallet to control this compartment directly. Anyone who sees it controls the funds.</p><div class="box s">${esc(k)}</div><div class="acts"><button class="btn ghost" id="cp">Copy</button><button class="btn" data-close>Done</button></div>`); $('#cp', v).addEventListener('click', () => copy(k, 'Private key copied')); }
function burnDialog(c) { const bal = wei[c.address] || 0n, hs = holdings[c.address] || []; const v = modal(`<h3>Burn ${esc(c.label)}</h3><p>${bal > GAS_KEEP || hs.length ? 'This compartment still holds funds. Sell and return them first; burning removes it from this vault view. Its key can always be re-derived from your recovery key as compartment #' + c.i + '.' : 'Removes this compartment from the vault. Nothing on-chain changes.'}</p><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn sell" id="go">Burn</button></div>`); $('#go', v).addEventListener('click', async () => { await W.removeCompartment(c.i); closeModal(); await refreshVault(); route(); }); }
function sendDialog(c) { const bal = wei[c.address] || 0n, max = bal > SEND_PAD ? bal - SEND_PAD : 0n; const v = modal(`<h3>Send from ${esc(c.label)}</h3><p>A plain transfer. Explorers will show this compartment paying the address you enter.</p><input class="inp mono" id="to" placeholder="0x address" autocomplete="off" spellcheck="false"><div class="field" style="margin-bottom:8px"><input id="amt" placeholder="0.0" inputmode="decimal"><button class="copy" id="mx">max ${eth(max)}</button><b>ETH</b></div><div class="err" id="err"></div><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Send</button></div>`);
  $('#mx', v).addEventListener('click', () => { $('#amt', v).value = (Number(max) / 1e18).toFixed(8); }); $('#go', v).addEventListener('click', async () => { const to = $('#to', v).value.trim(), raw = $('#amt', v).value.trim(), err = $('#err', v); if (!ADDR.test(to)) return (err.textContent = 'Enter a valid 0x address'); if (!/^\d*\.?\d+$/.test(raw)) return (err.textContent = 'Enter an amount'); const amt = toWei(raw); if (amt <= 0n || amt > max) return (err.textContent = 'Enter an amount up to ' + eth(max)); closeModal(); const o = order(`Send ${eth(amt)} ETH · ${c.label}`, ['Transfer']); o.step(); try { await sendEth(c.i, c.address, to, amt); o.done('Sent'); } catch (e2) { o.fail(e2.message); } await refreshVault(); rerender(); }); }
function homeDialog(c) { const bal = wei[c.address] || 0n, amt = bal > SEND_PAD ? bal - SEND_PAD : 0n, low = amt < 300_000_000_000_000n; const v = modal(`<h3>Return ${esc(c.label)} to Reserve</h3><p>Sends ${eth(amt)} ETH into the route, which pays Reserve from its own wallet. Sell the token first if this compartment still holds it.</p><div class="err" id="err">${low ? 'There is too little ETH here to move' : ''}</div><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="go" ${low ? 'disabled' : ''}>Return privately</button></div>`);
  $('#go', v).addEventListener('click', async () => { closeModal(); const o = order(`Return ${eth(amt)} ETH · ${c.label} → Reserve`, ['Send into the camo route', 'Route pays Reserve']); try { await routeMove(o, c.i, c.address, comps[0].address, amt); o.done('Reserve was paid by the route'); } catch (e) { o.fail(e.message); } await refreshVault(); rerender(); }); }
async function fundDialog(c) {
  const v = modal(`<h3>Fund ${esc(c.label)}</h3><div class="seg" id="ft" style="margin-bottom:12px"><button class="on" data-k="route">Camo route</button><button data-k="direct">Direct</button></div><div id="fb"></div>`); let tokens = [];
  const direct = () => { $('#fb', v).innerHTML = `<p>Send ETH on Robinhood Chain straight to this address. It is the fastest way in, and explorers will show the sending wallet paying this compartment.</p><div class="box s">${esc(c.address)}</div><div class="acts"><button class="btn ghost" id="cp">Copy address</button><button class="btn" data-close>Done</button></div>`; $('#cp', v).addEventListener('click', () => copy(c.address, 'Address copied')); $$('[data-close]', v).forEach((b) => b.addEventListener('click', closeModal)); };
  const viaRoute = async () => { $('#fb', v).innerHTML = `<p>Pay in from any chain. The route (NEAR Intents) takes your deposit on that chain and pays this compartment in ETH on Robinhood Chain from its own wallet, so nothing there points back to you.</p><select class="sel" id="as" style="margin-bottom:8px"><option>Loading assets</option></select><div class="field" style="margin-bottom:8px"><input id="amt" placeholder="0.0" inputmode="decimal"><b id="sym"></b></div><input class="inp mono" id="rf" placeholder="Your refund address on the sending chain" autocomplete="off" spellcheck="false"><div class="quote mono" id="rq">Enter an amount</div><div class="err" id="err"></div><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Get deposit address</button></div>`;
    $$('[data-close]', v).forEach((b) => b.addEventListener('click', closeModal));
    try { tokens = (await api('/api/route/tokens')).tokens; } catch (e) { return ($('#err', v).textContent = e.message); }
    const as = $('#as', v); as.innerHTML = tokens.map((t, i) => `<option value="${i}">${esc(t.symbol)} on ${esc(t.chain === 'hood' ? 'ROBINHOOD' : t.chain.toUpperCase())}</option>`).join(''); const pick = () => tokens[+as.value]; const sym = () => { $('#sym', v).textContent = pick().symbol; }; sym();
    let deb; const quote = () => { clearTimeout(deb); deb = setTimeout(async () => { const a = $('#amt', v).value.trim(); if (!/^\d+(\.\d+)?$/.test(a) || !+a) return; try { const q = await api('/api/route/quote', { asset: pick().id, amount: a }); $('#rq', v).innerHTML = `≈ ${(+q.out).toFixed(5)} ETH arrives<br><span class="mute">${usd(+q.usd)} in · about ${q.eta}s</span>`; $('#err', v).textContent = ''; } catch (e) { $('#rq', v).textContent = e.message; } }, 400); };
    as.addEventListener('change', () => { sym(); quote(); }); $('#amt', v).addEventListener('input', quote);
    $('#go', v).addEventListener('click', async () => { const a = $('#amt', v).value.trim(), rf = $('#rf', v).value.trim(), err = $('#err', v); if (!/^\d+(\.\d+)?$/.test(a) || !+a) return (err.textContent = 'Enter an amount'); if (rf.length < 10) return (err.textContent = 'Add a refund address on the sending chain, used only if the route cannot fill'); $('#go', v).disabled = true;
      try { const q = await api('/api/route/quote', { asset: pick().id, amount: a, order: true, recipient: c.address, refundTo: rf }); W.data().routes.unshift({ at: Date.now(), deposit: q.deposit, memo: q.memo, from: q.from, chain: q.chain, amountIn: q.amountIn, to: c.address, kind: 'in' }); if (c.i && c.src === 'pending') { W.data().comps.find((x) => x.i === c.i).src = 'route'; } await W.save();
        $('#fb', v).innerHTML = `<p>Send exactly <b>${esc(q.amountIn)} ${esc(q.from)}</b> on ${esc(q.chain === 'hood' ? 'Robinhood Chain' : q.chain.toUpperCase())} to this one-time address. About ${(+q.out).toFixed(5)} ETH then arrives in ${esc(c.label)}.</p><div class="box">${esc(q.deposit)}</div>${q.memo ? `<p>Memo (required)</p><div class="box">${esc(q.memo)}</div>` : ''}<div class="quote mono" id="st">Waiting for your deposit</div><div class="acts"><button class="btn ghost" id="cp">Copy address</button><button class="btn" data-close>Close</button></div>`;
        $('#cp', v).addEventListener('click', () => copy(q.deposit, 'Deposit address copied')); $$('[data-close]', v).forEach((b) => b.addEventListener('click', closeModal));
        const poll = setInterval(async () => { if (!$('#st')) return clearInterval(poll); try { const s = await api('/api/route/status?deposit=' + encodeURIComponent(q.deposit)); $('#st').textContent = s.status === 'SUCCESS' ? `Delivered ${s.out} ETH` : s.refunded ? 'Refunded ' + s.refunded : s.status.toLowerCase().replace(/_/g, ' '); if (s.status === 'SUCCESS') { clearInterval(poll); refreshVault(); } } catch {} }, 6000);
      } catch (e) { err.textContent = e.message; $('#go', v).disabled = false; } }); };
  $('#ft', v).addEventListener('click', (e) => { const k = e.target.dataset.k; if (!k) return; $$('#ft button').forEach((b) => b.classList.toggle('on', b === e.target)); k === 'route' ? viaRoute() : direct(); }); viaRoute();
}

// ---------- activity ----------
function renderActivity() {
  if (!W.unlocked()) { view.innerHTML = `<div class="empty"><h2>Your record, kept by you</h2><p>Fills and route transfers are written into the encrypted vault in this browser. The relay keeps no history of anyone.</p><button class="btn" id="open">${W.exists() ? 'Unlock vault' : 'Open a vault'}</button></div>`; $('#open').addEventListener('click', () => vaultDialog()); return; }
  const d = W.data(); view.innerHTML = `<div class="bar"><h1 class="h1">Activity</h1></div><div class="glass tbl" style="margin-bottom:12px"><p class="title" style="margin:10px">Fills</p><table><thead><tr><th>Age</th><th>Token</th><th>Side</th><th>ETH</th><th>Tokens</th><th>Compartment</th><th>Tx</th></tr></thead><tbody>${d.fills.length ? d.fills.map((f) => `<tr class="s" data-mint="${esc(f.mint)}"><td class="mute n">${age(f.at)}</td><td>${esc(f.symbol)}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="n">${f.sol.toFixed(5)}</td><td class="n">${qty(f.tok)}</td><td>${esc(f.label)}</td><td><button class="copy" data-copy="${esc(f.sig)}">${short(f.sig)}</button></td></tr>`).join('') : '<tr><td colspan="7" class="mute" style="text-align:center;padding:30px">No fills yet</td></tr>'}</tbody></table></div>
    <div class="glass tbl"><p class="title" style="margin:10px">Route transfers</p><table><thead><tr><th>Age</th><th>Kind</th><th>Sent</th><th>To</th><th>Deposit address</th><th>Status</th></tr></thead><tbody>${d.routes.length ? d.routes.slice(0, 40).map((r, i) => `<tr class="s"><td class="mute n">${age(r.at)}</td><td>${r.kind === 'in' ? 'Funding' : 'Internal move'}</td><td class="n">${esc(r.amountIn)} ${esc(r.from)} · ${esc(r.chain === 'hood' ? 'ROBINHOOD' : r.chain.toUpperCase())}</td><td class="n">${short(r.to)}</td><td><button class="copy" data-copy="${esc(r.deposit)}">${short(r.deposit)}</button></td><td class="n" data-route="${i}">…</td></tr>`).join('') : '<tr><td colspan="6" class="mute" style="text-align:center;padding:30px">No route transfers yet</td></tr>'}</tbody></table></div>`;
  d.routes.slice(0, 12).forEach(async (r, i) => { try { const s = await api('/api/route/status?deposit=' + encodeURIComponent(r.deposit)); const el = $(`[data-route="${i}"]`); if (el) el.textContent = s.status === 'SUCCESS' ? 'Delivered ' + s.out + ' ETH' : s.refunded ? 'Refunded ' + s.refunded : s.status.toLowerCase().replace(/_/g, ' '); } catch { const el = $(`[data-route="${i}"]`); if (el) el.textContent = 'waiting for deposit'; } });
  $$('tr[data-mint]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('[data-copy]')) location.hash = '#/t/' + tr.dataset.mint; }));
}

// ---------- search ----------
const q = $('#q'), results = $('#results'); let qd, found = [];
q.addEventListener('input', () => { clearTimeout(qd); const s = q.value.trim(); if (ADDR.test(s)) { results.hidden = true; q.value = ''; q.blur(); return (location.hash = '#/t/' + s); } if (s.length < 2) return (results.hidden = true);
  qd = setTimeout(async () => { try { found = (await api('/api/search?q=' + encodeURIComponent(s))).rows; results.innerHTML = found.length ? found.map((r) => `<a href="#/t/${esc(r.mint)}" data-sym="${esc(r.symbol)}">${avatar(r)}<div><b>${esc(r.symbol)}</b> <span class="mute">${esc(r.name).slice(0, 28)}</span><br><span class="mono mute" style="font-size:11px">${short(r.mint)}</span></div><div class="r mono">${px(r.price)}<br><span class="mute">${usd(r.liq)} liq</span></div></a>`).join('') : '<div class="mute" style="padding:12px">No Robinhood Chain market matches that</div>'; results.hidden = false; } catch {} }, 250); });
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && found[0]) { location.hash = '#/t/' + found[0].mint; results.hidden = true; q.value = ''; q.blur(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('.find')) results.hidden = true; else if (e.target.closest('.results a')) { results.hidden = true; q.value = ''; } });

// ---------- router ----------
function route() {
  timers.forEach(clearInterval); timers = []; const h = location.hash.replace(/^#\/?/, '') || 'discover', [name, arg] = h.split('/');
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (name === 't' ? 'discover' : name))); document.title = 'CAMO Terminal'; view.scrollTop = 0;
  if (name === 't' && ADDR.test(arg || '')) renderToken(arg); else if (name === 'vault') renderVault(); else if (name === 'activity') renderActivity(); else renderDiscover();
}
const rerender = () => { if ($('.veil')) return; const h = location.hash; if (/^#\/t\//.test(h)) { tradePane(); } else route(); };
window.addEventListener('hashchange', route);
if (location.pathname.startsWith('/t/')) history.replaceState(null, '', '/app#/t/' + location.pathname.slice(3));
setCamo(cfg.camoed);
(async () => { await W.resume(); await refreshVault(true); route(); setInterval(() => { if (!document.hidden && W.unlocked()) refreshVault(); }, 25000); api('/api/config').then((c) => { setEth(c.eth); if (c.mint) { const m = $('#camoTab'); m.href = '#/t/' + c.mint; m.hidden = false; } if (c.x) { const x = $('#xTab'); x.href = c.x; x.hidden = false; } }).catch(() => {}); })();
