# Changelog

## Unreleased

### Features

- Add a standalone, fixed-input EVM Solver using the public Anyflo wire contracts,
  Uniswap AMM liquidity and a custom permissionless Aqua/SwapVM position app.
- Add bounded Permit2/router transaction validation, independently verified
  customer funding and delivery, and durable intent-before-broadcast checkpoints.
- Add read-only preflight and Aqua position build/inspect/ship/dock tooling.

### Safety boundaries

- No Inventory fallback, bridge, UniswapX or automatic recovery of funded or
  ambiguous orders. Restart reconciliation remains an explicit operator task.
- Provider credentials and signing keys remain private. Route-compliance policy
  checks and production Solver modularization are deferred, not claimed here.
