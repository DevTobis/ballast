# Ballast contracts

Six Soroban contracts (Rust) plus `common`, a shared library of access-control, timelock, pause,
price, risk, and margin logic used across all of them. See `../PRD.md` §6.2 and §8 for the design
and interface each one implements, and each crate's own module doc comment for what's simplified
in this skeleton pass.

| Crate | Responsibility |
|---|---|
| `common` | Shared roles/timelock/pause/price/risk/margin logic — not itself a deployable contract |
| `registry` | Asset configs, haircut parameters, timelocked param changes |
| `price-guard` | Median/band/staleness/halt price logic (PRD §6.4) |
| `pledge-vault` | Escrow/lien collateral positions |
| `credit-line` | Credit lines, draws, repayments, the margin state machine |
| `exit-desk` | RWA → USDC instant exit |
| `repo-dvp` | Bilateral repo, atomic DvP |

## Building

`soroban-sdk` 28.x's build script refuses a plain `cargo build --target wasm32-unknown-unknown`
and requires the Stellar CLI's wrapper instead. From inside a contract's own directory:

```
stellar contract build
```

This produces `../target/wasm32v1-none/release/<crate>.wasm`. `cargo test -p <crate>` (run from
`contracts/`, on the host target) works normally for unit tests and does not need `stellar-cli`.
