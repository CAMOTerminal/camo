// Keys live here and nowhere else. One 32-byte seed, encrypted with the passphrase (PBKDF2 + AES-GCM), derives every
// compartment wallet. Transactions are signed in this tab (secp256k1, EIP-1559) and leave it already signed.
// Everything is written out by hand so the page loads no library: keccak-256, secp256k1, RFC 6979, RLP.
const te = new TextEncoder(), td = new TextDecoder();
export const b64 = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const hex = (u) => { let s = ''; for (const b of u) s += b.toString(16).padStart(2, '0'); return s; };
export const unhex = (s) => { s = String(s).replace(/^0x/, ''); if (s.length % 2) s = '0' + s; const u = new Uint8Array(s.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const VAULT = 'camo_vault', SESSION = 'camo_session';
export const CHAIN_ID = 4663;

// ---------- keccak-256 ----------
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rol = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function f1600(s) {
  for (let rnd = 0; rnd < 24; rnd++) {
    const c = []; for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + ((2 * x + 3 * y) % 5) * 5] = rol(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & M64) & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[rnd];
  }
}
export function keccak256(buf) {
  const rate = 136, padLen = rate - (buf.length % rate), p = new Uint8Array(buf.length + padLen); p.set(buf); p[buf.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const dv = new DataView(p.buffer), s = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) { for (let i = 0; i < rate / 8; i++) s[i] ^= dv.getBigUint64(off + i * 8, true); f1600(s); }
  const out = new Uint8Array(32), ov = new DataView(out.buffer); for (let i = 0; i < 4; i++) ov.setBigUint64(i * 8, s[i], true); return out;
}

// ---------- secp256k1 ----------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) { let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); }
// Jacobian coordinates: one inversion per multiplication instead of one per step
const dbl = ([X, Y, Z]) => { if (!Y) return [0n, 0n, 0n]; const S = mod(4n * X * Y * Y, P), Mm = mod(3n * X * X, P), X3 = mod(Mm * Mm - 2n * S, P); return [X3, mod(Mm * (S - X3) - 8n * Y * Y * Y * Y, P), mod(2n * Y * Z, P)]; };
const addJ = (A, B) => { if (!A[2]) return B; if (!B[2]) return A; const [X1, Y1, Z1] = A, [X2, Y2, Z2] = B, Z1Z1 = mod(Z1 * Z1, P), Z2Z2 = mod(Z2 * Z2, P), U1 = mod(X1 * Z2Z2, P), U2 = mod(X2 * Z1Z1, P), S1 = mod(Y1 * Z2 * Z2Z2, P), S2 = mod(Y2 * Z1 * Z1Z1, P);
  if (U1 === U2) return S1 === S2 ? dbl(A) : [0n, 0n, 0n]; const Hh = mod(U2 - U1, P), R = mod(S2 - S1, P), H2 = mod(Hh * Hh, P), H3 = mod(Hh * H2, P), X3 = mod(R * R - H3 - 2n * U1 * H2, P); return [X3, mod(R * (U1 * H2 - X3) - S1 * H3, P), mod(Hh * Z1 * Z2, P)]; };
function mul(k) { let R = [0n, 0n, 0n], A = [G[0], G[1], 1n]; k = mod(k, N); while (k > 0n) { if (k & 1n) R = addJ(R, A); A = dbl(A); k >>= 1n; } const zi = inv(R[2], P), z2 = mod(zi * zi, P); return [mod(R[0] * z2, P), mod(R[1] * z2 * zi, P)]; }
const b32 = (x) => unhex(x.toString(16).padStart(64, '0')), big = (u) => BigInt('0x' + (hex(u) || '0'));
const hmac = async (key, ...msgs) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), cat(...msgs)));
// RFC 6979: the nonce comes from the key and the message, so a weak random source can never leak the key
async function nonceK(priv, h) { let V = new Uint8Array(32).fill(1), K = new Uint8Array(32); const x = b32(priv);
  K = await hmac(K, V, Uint8Array.of(0), x, h); V = await hmac(K, V); K = await hmac(K, V, Uint8Array.of(1), x, h); V = await hmac(K, V);
  for (;;) { V = await hmac(K, V); const k = big(V); if (k > 0n && k < N) return k; K = await hmac(K, V, Uint8Array.of(0)); V = await hmac(K, V); } }
async function sign(priv, h) { const k = await nonceK(priv, h), R = mul(k), r = mod(R[0], N); let s = mod(inv(k, N) * (big(h) + r * priv), N), v = Number(R[1] & 1n); if (s > N / 2n) { s = N - s; v ^= 1; } return { r, s, v }; }
export const checksum = (addr) => { const a = addr.toLowerCase().replace(/^0x/, ''), h = hex(keccak256(te.encode(a))); return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join(''); };
export const addressOfKey = (privHex) => addrOf(BigInt(privHex)); // used by the test suite against a published vector
const addrOf = (priv) => { const Q = mul(priv); return checksum(hex(keccak256(cat(b32(Q[0]), b32(Q[1]))).subarray(12))); };

// ---------- RLP and EIP-1559 ----------
const trim = (x) => { x = BigInt(x); return x === 0n ? new Uint8Array(0) : unhex(x.toString(16)); };
const len = (n, base) => (n < 56 ? Uint8Array.of(base + n) : (() => { const b = trim(n); return cat(Uint8Array.of(base + 55 + b.length), b); })());
const rlp = (v) => { if (Array.isArray(v)) { const body = cat(...v.map(rlp)); return cat(len(body.length, 0xc0), body); } return v.length === 1 && v[0] < 0x80 ? v : cat(len(v.length, 0x80), v); };

// ---------- vault ----------
let live = null;
const kdf = async (pass, salt) => crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
async function persist() {
  const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, live.key, te.encode(JSON.stringify(live.data))));
  localStorage.setItem(VAULT, JSON.stringify({ v: 1, salt: b64(live.salt), iv: b64(iv), ct: b64(ct) }));
  try { sessionStorage.setItem(SESSION, JSON.stringify({ k: b64(new Uint8Array(await crypto.subtle.exportKey('raw', live.key))), salt: b64(live.salt) })); } catch {}
}
export const supported = async () => { try { await hmac(new Uint8Array(32), new Uint8Array(1)); return typeof BigInt === 'function'; } catch { return false; } };
export const exists = () => !!localStorage.getItem(VAULT);
export const unlocked = () => !!live;
export const data = () => live?.data;
export async function create(pass, seedBytes) {
  if (String(pass).length < 8) throw new Error('Use a passphrase of at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16)), seed = seedBytes || crypto.getRandomValues(new Uint8Array(32));
  live = { key: await kdf(pass, salt), salt, data: { seed: b64(seed), next: 1, comps: [{ i: 0, label: 'Reserve', mint: '', src: 'direct', at: Date.now() }], routes: [], fills: [] } };
  await persist(); return live.data;
}
async function open(key, salt) { const v = JSON.parse(localStorage.getItem(VAULT)); const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct)); live = { key, salt, data: JSON.parse(td.decode(pt)) }; return live.data; }
export async function unlock(pass) { const v = JSON.parse(localStorage.getItem(VAULT)), salt = unb64(v.salt); try { const d = await open(await kdf(pass, salt), salt); await persist(); return d; } catch { live = null; throw new Error('Wrong passphrase'); } }
export async function resume() { try { const s = JSON.parse(sessionStorage.getItem(SESSION) || 'null'); if (!s || !exists()) return false; const key = await crypto.subtle.importKey('raw', unb64(s.k), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); await open(key, unb64(s.salt)); return true; } catch { live = null; return false; } }
export function lock() { live = null; keys.clear(); try { sessionStorage.removeItem(SESSION); } catch {} }
export function destroy() { lock(); localStorage.removeItem(VAULT); }
export const save = () => persist();
export const backup = () => 'camo-' + hex(unb64(live.data.seed));
export async function restore(pass, phrase) { const s = phrase.trim().replace(/^camo-/i, ''); if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('That is not a CAMO recovery key'); return create(pass, unhex(s)); }

// ---------- compartments ----------
const keys = new Map();
async function keyOf(i) {
  if (keys.has(i)) return keys.get(i);
  let priv = big(await hmac(unb64(live.data.seed), te.encode('camo/compartment/' + i))); priv = mod(priv, N - 1n) + 1n;
  const k = { priv, address: addrOf(priv), secret: () => '0x' + priv.toString(16).padStart(64, '0') }; keys.set(i, k); return k;
}
export const address = async (i) => (await keyOf(i)).address;
export const secretKey = async (i) => (await keyOf(i)).secret();
export async function newCompartment(label, mint = '', src = 'pending') { const d = live.data, c = { i: d.next++, label, mint, src, at: Date.now() }; d.comps.push(c); await persist(); c.address = await address(c.i); return c; }
export async function removeCompartment(i) { live.data.comps = live.data.comps.filter((c) => c.i !== i); keys.delete(i); await persist(); }
export async function compartments() { return Promise.all(live.data.comps.map(async (c) => ({ ...c, address: await address(c.i) }))); }

// ---------- transactions ----------
// Sign an EIP-1559 transaction. t: { to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas, nonce }
export async function signTx(i, t) {
  const k = await keyOf(i), to = unhex(t.to); if (to.length !== 20) throw new Error('Not a valid address');
  const f = [trim(CHAIN_ID), trim(t.nonce), trim(t.maxPriorityFeePerGas || 0), trim(t.maxFeePerGas), trim(t.gas), to, trim(t.value || 0), unhex(t.data || '0x'), []];
  const h = keccak256(cat(Uint8Array.of(2), rlp(f))), { r, s, v } = await sign(k.priv, h);
  return '0x' + hex(cat(Uint8Array.of(2), rlp([...f, trim(v), trim(r), trim(s)])));
}
export const TRANSFER_GAS = 60000n; // a plain send on this chain; generous, unused gas is not charged
