# Uniswap integration feedback

This project connects an external payment-order auction to Uniswap AMM liquidity.
The Solver must quote before bidding, then build and validate a fresh swap after
customer funding. This feedback concerns initial read-only API integration
probes; it is not evidence of mainnet settlement.

## What worked

- The Trading API provides an AMM quote without requiring a prefunded payout
  balance, which fits deposit-funded payment execution.
- Allowing v2/v3/v4 AMM routes found a Base bridged-USDT/native-USDC route;
  a v3-only request returned no route.
- Explicit protected amounts and Permit2 data make it possible to preserve the
  accepted payment's spend/output bounds through execution.

## Integration friction

- Observed quote requests took roughly 2–4 seconds. Anyflo's normal 1.5-second
  bidding window is too short for this flow. The local demo uses a 10-second
  auction; late results must still be discarded.
- API examples and integration guidance should consistently identify numeric
  chain-ID fields, Universal Router versions, and the exact object passed from
  the quote response into `/swap`.
- An explicit, small example of validating API-built router commands, recipient,
  token pair and bounds would help non-wallet backend integrations safely use
  the API. HTTP success is not permission to sign arbitrary calldata.
- Keep the standard Permit2 workflow clearly distinguished from deprecated
  no-Permit2 compatibility proxies and potentially unlimited ERC20 approvals.

## Submission

The project README links the protocol integration and hackathon scope. This file
records developer feedback; it does not claim that an external feedback form or
hackathon submission has been sent.
