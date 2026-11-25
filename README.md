# CAMO

[![license](https://img.shields.io/badge/license-MIT-00c805)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2022-00c805)](.node-version) [![dependencies](https://img.shields.io/badge/dependencies-0-00c805)](package.json) [![checks](https://img.shields.io/badge/end--to--end%20checks-56-00c805)](test)

**[camoterminal.xyz](https://camoterminal.xyz)** · [Terminal](https://camoterminal.xyz/app) · [Docs](https://camoterminal.xyz/docs) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

The private trading terminal for Robinhood Chain. Every position sits in its own wallet, and no wallet can be followed back to the one that funded it.

- **Discover.** Trending, new pairs and top gainers, with live charts and a trade tape for any Robinhood Chain token.
- **Compartments.** A fresh wallet per position, derived in the browser from one encrypted seed.
- **Camo route.** Compartments are paid through NEAR Intents from the route's own wallet, from any supported chain or from your own Reserve.
- **No public mempool.** Robinhood Chain orders go straight to the sequencer, so nobody sees an order before it is in a block.
- **Scatter.** One buy split into random slices over a time window.
- **Relay.** The browser talks to this server only. No accounts, no cookies, no request log, no database.

One Node.js program, no dependencies.

## Quick start

```bash
git clone https://github.com/CAMOTerminal/camo
cd camo
npm start          # http://localhost:8318
npm test           # 56 end-to-end checks against live sources
```

Node 22 or newer.

## How it fits together

```
browser tab                          relay (server/index.js)              the outside
  vault, keys, signing  ──signed tx──▶  stateless, no log   ──────────▶  Robinhood Chain RPC, Relay, market data, NEAR Intents
  (client/wallet.js)   ◀── quotes ────  last-good cache    ◀──────────
```

| Path | What it is |
|---|---|
| `client/wallet.js` | Vault (PBKDF2 + AES-256-GCM), key derivation, keccak-256, secp256k1 with RFC 6979, RLP and EIP-1559 signing, written out with no library |
| `client/app.js` | The terminal: discover, token page, chart, order engine, compartments, activity |
| `server/index.js` | The relay: market data, swap quotes from Relay, images, transaction relay, the route |
| `client/landing.js` | Landing hero |
| `test/run.js` | End-to-end checks |

## Keys

Keys never reach the server. A 32-byte seed is generated in the tab and encrypted with a key stretched from the passphrase (PBKDF2-SHA256, 310,000 rounds, AES-256-GCM). Compartment `n` uses the secp256k1 key `HMAC-SHA256(seed, "camo/compartment/n")`, signed as EIP-1559 for chain id 4663. Transactions are signed in the tab and arrive at the relay already signed.

## Configuration

All optional, read from the environment.

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 8318) |
| `RPC_URL` | Comma-separated Robinhood Chain RPC endpoints |
| `TOKEN_MINT` | $CAMO contract address shown on the site |
| `X_URL`, `GH_URL` | Links shown in the landing page nav |
| `FEE_BPS`, `FEE_TO` | Swap fee in basis points and the address that receives it |
| `ROUTE_FEE_BPS`, `ROUTE_FEE_TO` | Route fee and its NEAR recipient |

## Tests

`npm test` runs 56 checks against live sources: every page and its content policy, market data, the vault, the route, published test values for keccak-256 and address derivation, and a Robinhood Chain node recovering the wallet's address from transfers and swaps it signed (the wallets are empty, so nothing is broadcast and no funds are needed).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [private reporting](https://github.com/CAMOTerminal/camo/security/advisories/new).

## License

[MIT](LICENSE)
