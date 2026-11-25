# Changelog

All notable changes to CAMO are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-25

First public release.

### Added

- **Terminal.** Trending, new pairs and top gainers, token pages with live candles and a trade tape, search, one-click buys and sells.
- **Vault.** A seed made in the tab, encrypted with PBKDF2 and AES-256-GCM, with a recovery key and per-compartment key export.
- **Compartments.** One wallet per position, derived from the seed.
- **Camo route.** Funding from other chains and private moves between compartments through NEAR Intents.
- **Orders.** Swap routing through Relay, signed as EIP-1559 in the tab and sent straight to the sequencer.
- **PnL cards.** A position's result as an image, with no wallet on it.
- **Scatter.** Buys split into random slices over a time window.
- **Relay.** Stateless server with a strict content policy and an image relay.

[Unreleased]: https://github.com/CAMOTerminal/camo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CAMOTerminal/camo/releases/tag/v0.1.0
