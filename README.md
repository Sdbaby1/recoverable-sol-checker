# Recoverable SOL — Token Mint Checker

A lightweight website to check Solana SPL token mints for **excess / recoverable SOL** (bricked lamports sent directly to mint accounts).

- Real-time on-chain balance + rent-exemption calculation
- Detects if SOL can be recovered via `withdraw_excess_lamports` (SIMD-0266 / p-token)
- Traces recent SOL transfers sent **to** the mint address (who sent it)
- Finds the token creator / dev wallet + creation tx
- One-click links to Solscan + the original Dune dashboard

## Features

- Paste any mint address (or Solscan link)
- Quick balance check or full trace + creator lookup
- Shows mint authorities, program (classic vs Token-2022)
- Attempts to resolve token name/symbol via public APIs
- Recovery instructions included

## Data Sources

- Direct Solana RPC (`getAccountInfo`, `getSignaturesForAddress`, `getParsedTransaction`)
- Public metadata (Dexscreener)
- Inspired by https://dune.com/parkernoir7826/recoverable-sol

## Run locally

```bash
npm install
npm run dev
```

Then open the shown localhost URL and paste a mint.

## Production build

```bash
npm run build
npm run preview
```

The site is 100% client-side. For heavy usage on popular mints, use your own RPC endpoint in the input field.

## Related

- Dune dashboard: https://dune.com/parkernoir7826/recoverable-sol
- Official docs: https://solana.com/docs/tokens/advanced/withdraw-excess-lamports

Built with Vite + React + TypeScript + @solana/web3.js + Tailwind.


See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
