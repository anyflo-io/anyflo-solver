// Native Typst is the source; diagrams are rendered from Mermaid.
// Level-2 headings delimit slides; speaker notes are source comments.
#import "@preview/touying:0.8.0": *
#import themes.metropolis: *

#show: metropolis-theme.with(
  aspect-ratio: "16-9",
  config-common(slide-heading-level: 2),
  config-info(
    title: [Anyflo DeFi Provider],
    logo: image("../assets/logo.webp", height: 1.2em),
  ),
  config-page(margin: (top: 3.9em, x: 2.4em, bottom: 1.6em)),
  config-colors(
    primary: rgb("#7c3aed"),
    primary-light: rgb("#c4b5fd"),
    secondary: rgb("#0f172a"),
    neutral-lightest: rgb("#f8fafc"),
    neutral-dark: rgb("#475569"),
    neutral-darkest: rgb("#0f172a"),
  ),
  footer: [Anyflo DeFi Provider],
)

#set text(font: "Noto Sans", size: 17pt)
#set par(justify: true)
#set strong(delta: 100)

#let figure(body, caption: none, ..options) = std.figure(
  body,
  caption: caption,
  ..options,
)

#title-slide(subtitle: [ETHGlobal Mumbai #text(size: 0.7em)[·] Robert Zaremba])


== Why we are building Anyflo

Businesses want to pay invoices in #strong[fiat], not operate wallets and DeFi.
Cross-border payments can be slow, opaque and difficult to reconcile.

- Keep familiar bank payments at both ends.
- Use stablecoins and on-chain liquidity for the international routing leg.
- Give banking and ramp partners a traceable payment record to review.

#strong[Product vision:] fiat in, fiat out. This demo covers the on-chain leg.

// Speaker notes: The objective is a bank-compatible business payment service,
// not asking a finance team or supplier to hold crypto. Fiat FX, bank access,
// licensed ramp integrations and their local obligations are outside this demo.
// On-chain availability does not make fiat settlement instant or guaranteed.

== User story: Atlas pays Deccan

_Atlas Motors GmbH_ in Munich owes _Deccan Parts Pvt. Ltd._ in Pune
#strong[EUR 50,000] for invoice #strong[DP-2048].

Atlas wants to fund in EUR. Deccan wants INR in its bank account.

#align(center, image(
  "diagrams/diagram-4.svg",
  alt: "Illustrative EUR-to-INR corridor using stablecoin routing",
  width: 100%,
  height: 88pt,
  fit: "contain",
))

#strong[Illustrative scenario:] names are not claimed customers or partners.
Fiat rails are product vision, not a demonstrated integration.

// Speaker notes: Atlas finance staff and Deccan's accounts-receivable team
// should see a business payment, not manage a swap. These are illustrative
// entities and invoice details, not a real transaction or commercial relationship.
// No EUR-to-INR rate or fixed INR payout is being claimed for this example.

== A bank-reviewable trail for invoice DP-2048

#strong[Target audit record --- future work, not implemented in this demo:]

- Business identities, invoice purpose, source-of-funds evidence and screening decisions.
- Proposed route, wallets, tokens, pools and venues; timestamped policy version and pre-bid decision, rechecked before execution.
- Linked EUR bank reference, ramp conversion, deposit/swap/payout receipts and INR bank-payout confirmation.

This supports bank due diligence; #strong[it does not guarantee acceptance].

// Speaker notes: A transaction hash alone cannot explain the business purpose
// or connect bank funding to a beneficiary payout. The goal is a consistent
// evidence chain across fiat and crypto. Banks and providers retain their own
// legal, onboarding and risk decisions. An audit trail complements controls;
// it does not replace licensing, applicable checks or legal obligations.

== The Solver: from inventory to liquidity access
<the-solver-from-inventory-to-liquidity-access>
A Solver is the #strong[liquidity and execution agent], not a new payment network.

The existing Solver needs payout inventory. This project adds a standalone agent that uses verified customer funding to obtain the payout asset through #strong[Uniswap AMMs or a custom Aqua position].

One configured EVM pair, fixed input, one strategy and one active order.


// Speaker notes: The prototype uses Anyflo's existing direct-deposit API.
// Capital is still required in AMM pools or maker wallets; we do not create
// credit. This demo is same-chain, not an Arbitrum-to-Base bridge.

== Inventory: the pre-funded baseline

#strong[Advantages:] no DEX quote or swap on the payment path; fewer external
dependencies and more predictable execution timing.

#strong[Disadvantages:] the Solver must prefund payout assets on destination
chains, monitor balances and rebalance. Capital can sit idle or be unavailable
where the next payment needs it.

#strong[Best fit:] frequent, predictable corridors with well-funded inventory.

// Speaker notes: Inventory is the preexisting Anyflo Solver baseline, not an
// implemented strategy in this standalone repository or a measured comparator.
// Avoiding a DEX swap does not remove gas/finality, asset or compliance risk;
// inventory provenance and treasury rebalancing still need controls.

== Uniswap: pooled liquidity, execution trade-offs

#strong[Advantages:] access LP-funded pools through API routing without the
Solver stocking every payout asset. Quotes and receipts expose the route.

#strong[Disadvantages:] pair/size availability, price impact, pool fees and gas.
Quotes do not reserve liquidity; API/RPC latency and Permit2/router validation
add dependencies and integration work.

#strong[Best fit:] same-chain payments with sufficient, policy-acceptable pools.

// Speaker notes: The Solver trades against pools; it does not become an LP.
// LP inventory risk is not the same as the Solver's execution risk. The demo
// uses one real V3 pool; live read-only probes also found V4 routing. A route
// policy decision cannot certify the identity or compliance of every pool LP.

== Aqua: programmable liquidity, backing matters

#strong[Advantages:] custom position economics on SwapVM; makers retain wallet
custody and can share backing across app allocations.

#strong[Disadvantages:] a usable maker position must exist for the pair/size.
Virtual allocations are not locked funds: wallet balances and allowances can
change. NO SANDBOX.

#strong[Best fit:] configured makers needing programmable liquidity positions.

// Speaker notes: The selected app is permissionless and needs no resolver NFT.
// Known position configuration is not a substitute for counterparty screening.
// Shared wallet backing is capital reuse, not new credit or guaranteed capacity.
// Production/commercial use must satisfy the source-available upstream terms.

== What we built for this hackathon
<what-we-built-for-this-hackathon>
- Public standalone Solver: existing JWT, signed bids/acceptance and CBOR API.
- Uniswap API quotes, bounded Permit2 authorization and validated AMM swaps.
- Permissionless Aqua/SwapVM position app, maker lifecycle tools and execution.
- Durable spend checkpoints and a runnable mock-Hub, real-contract demo.


// Speaker notes: Code: src/solver.ts, src/uniswap.ts, src/aqua.ts,
// src/aqua-position.ts, demo/run.ts. SDKs and upstream swap engines retain
// attribution: we built the application and payment integration, not a new
// Uniswap or SwapVM engine. No monorepo Solver modularization was performed.

== Why compliance must cover the route

Payment providers may need to meet sanctions, AML and internal risk obligations.
Screening the sender and recipient alone does not assess how funds move.

- An AMM route can involve multiple tokens, pools and venues.
- A payment provider needs an auditable route decision consistent with policy.
- Requirements depend on jurisdiction, customer and applicable law.

#strong[Today:] Anyflo screens counterparties; Solver route checks are future work.

// Speaker notes: Existing screening is in the production backend; the mock demo
// does not run it. The solver route checks are a future design, not a legal
// certification or a claim that AMM liquidity is inherently compliant.


== Integration: choose a source, preserve Anyflo settlement
<integration-choose-a-source-preserve-anyflo-settlement>
#box(image(
  "diagrams/diagram-1.svg",
  alt: "Liquidity strategy flow",
  width: 100%,
  height: 100pt,
  fit: "contain",
))

Aqua's executable quote is on-chain. The 1inch HTTP quote is #strong[reference data]. No resolver enrollment, global position crawler or provider fallback.


// Speaker notes: This flowchart explains source choice. The config pins one
// source; the Solver does not compare routes or silently change providers after
// bidding. The same DeliveryAccount boundary settles both strategies. The local
// Hub and Anyflo contracts are labeled test doubles.

== Swimlane: auction and funding
<swimlane-auction-and-funding>
#box(image(
  "diagrams/diagram-2.svg",
  alt: "Auction and funding swimlane",
  width: 100%,
  height: 295pt,
  fit: "contain",
))



// Speaker notes: The first swimlane covers auction and funding, not source
// selection. Uniswap quotes via its API; Aqua quotes by eth_call. DepositAccount
// forwards only solver-net funds. The Solver verifies the receipt independently.

== Swimlane: execution and delivery
<swimlane-execution-and-delivery>
#box(image(
  "diagrams/diagram-3.svg",
  alt: "Execution and delivery swimlane",
  width: 100%,
  height: 210pt,
  fit: "contain",
))

Accepted payout stays fixed. Swap and delivery are separate transactions.


// Speaker notes: The second swimlane starts after funding. The source is the
// configured AMM or SwapVM position, never an automatic fallback. The Solver
// verifies delivery and acknowledges it. Future route checks must run again
// before execution; they are not current compliance behavior.

== Demo: two deposit-funded payments

#raw("bun run demo --strategy both", block: true)

Two independent orders on Anvil (31337), using minted test USDT/USDC:
one via Uniswap, one via Aqua.

1. The mock Hub publishes an order; a real Solver process signs its bid and acceptance.
2. A verified customer deposit funds the actual AMM/SwapVM swap; the Solver starts with zero token inventory.
3. A separate payout delivers USDC. The report checks receipts, fees, premium and recipient balances; Aqua also proves ship/fill/dock.

#strong[Mocked:] Hub, provider HTTP and Anyflo settlement contracts.
No fiat rails, mainnet or real funds.

// Speaker notes: Run bun run demo:setup first to acquire/build public artifacts.
// Both runs use test-only keys and their own local process/config/state. Watch
// the JSON checks and separate swap/delivery hashes, not HTTP success alone.
// Official swap engines and ERC20 transfers are real local execution; the
// settlement doubles and mock backend are not production integration evidence.

== Aqua app: a wallet-backed programmable position
<aqua-app-a-wallet-backed-programmable-position>
Position: #strong[0.99--1.01 band], #strong[5 bps input fee], #strong[30-second decay].

- A separate maker ships a permissionless position on the official SwapVM engine.
- Virtual reserves refer to actual maker-wallet balances and registry allowances.
- Real ship, fill and dock receipts were observed; docking leaves custody intact.


// Speaker notes: The program is built with the official Aqua/SwapVM SDKs, not
// hand-written substitute swap contracts. The demo proves maker/taker token
// movements and registry Pushed/Pulled events, then docks the position and
// checks zero virtual balances with unchanged post-fill maker custody. No
// resolver NFT/access guard is added or stripped from another maker's position.

== Observed local payment results
<observed-local-payment-results>
#figure(
  align(center)[#table(
    columns: 5,
    align: (auto, right, right, right, right),
    fill: (col, row) => if row == 0 { rgb("#ede9fe") },
    table.header([Strategy], [Input], [Swapped], [Delivered USDC], [Checks]),
    table.hline(),
    [Uniswap V3], [10.000000], [9.990000], [9.934087], [11],
    [Aqua / SwapVM], [10.000000], [9.990000], [9.934580], [14],
  )],
  kind: table,
)

Both start with #strong[zero Solver token balances]. Separate protocol fee: 0.100000 test USDT; retained input premium: 0.010000. These are one local run, not rates.


// Speaker notes: Actual commands: bun run demo:setup; bun run demo --strategy
// both. All tokens have six decimals. Customer gross spend is 10.1 test USDT: 10
// solver-net plus 0.1 fee. The solver swaps 9.99 and retains 0.01 input premium.
// Actual swap output may exceed the frozen customer payout; surplus does not
// change accepted terms. The evidence JSON contains local transaction
// references; they are not mainnet explorer links.

== What worked well

- Published Anyflo wire types and helpers let the public Solver reuse the existing API without private backend source.
- Both real local engines swapped deposit-funded tokens; the Solver started with no input/output inventory.
- Receipts proved fee separation, exact customer payout and Aqua ship/fill/dock.
- Focused guards covered unsafe spending, short funding and duplicate delivery.

// Speaker notes: Evidence is the observed local CLI runs, 43 project tests and
// 5 native Forge settlement tests. These are not inventory performance tests,
// production-backend tests or proof of live-chain payment settlement.

== Real-world simulation: USD 250k to AED

#strong[Transfer:] USD 250,000. #strong[Recipient currency:] AED (Emirati dirham).

#table(
  columns: (2fr, 1fr, 1fr),
  align: (left, right, right),
  inset: 5pt,
  fill: (col, row) => if row == 0 { rgb("#ede9fe") },
  table.header([Payment approach], [Fees (USD)], [Fees / principal]),
  [Banking route], [12,000], [4.800%],
  [Inventory (existing)], [4,000], [1.600%],
  [Uniswap], [2,680], [1.072%],
  [1inch Aqua], [2,610], [1.044%],
)

Totals include #strong[estimated on/off-ramp costs] where applicable.
These are supplied scenario estimates, not live quotes or protocol tariffs.

// Speaker notes: All four fee inputs were supplied for this illustrative
// comparison; percentages are calculated against the USD 250,000 principal.
// The 1inch row means the Aqua strategy discussed in this presentation.
// No USD/AED execution rate was supplied, so no net AED payout is calculated.
// This is not a measured transfer, a bank quote or a guaranteed cost saving.

== What did not work as first assumed

- Live quotes took roughly 2--4 seconds: too slow for a 1.5-second auction; the demo used 10 seconds.
- A V3-only Base request found no route; enabling V2/V3/V4 produced a usable AMM quote.
- Permit2/wire/ABI assumptions and a launcher hiding compiler failure caused integration defects; these were corrected.
- Hosted APIs cannot quote Anvil-only tokens: local HTTP mocks are necessary, not live-provider proof.

// Speaker notes: These are observed integration lessons, not current failing
// tests or blanket claims about protocol quality. The Foundry npm 1.7.1
// launcher did not forward native exit status, so the project invokes the
// native binary and verifies real receipts. Quotes still never reserve capital.

== Developer experience: what should improve

- #strong[Version contracts:] a maintained API, Permit2/router and Aqua/SwapVM SDK/ABI compatibility matrix.
- #strong[Complete examples:] quote, fund, bounded authorization, swap, receipt proof; explain permissionless Aqua and both approval directions.
- #strong[Repeatable fixtures:] official test-token deployments and reliable CLI failure codes, rather than bespoke compiler glue.
- #strong[Operability:] typed failure reasons and reconciliation guidance without exposing credentials.

// Speaker notes: We built pinned fixtures and native-status checks locally.
// An upstream-supported fixture and deployed-version matrix would reduce the
// integration burden for the next team. Inventory additionally needs clear
// balance/rebalancing tooling; all strategies need consistent typed quote,
// amount/fee accounting and evidence contracts in the production integration.

== Added value
<added-value>
#strong[Anyflo and business customers:] more liquidity paths without stocking every payout asset in each Solver wallet; the existing order API stays unchanged.

#strong[Uniswap and Aqua:] business-originated payment flow and a potential use case connecting DeFi liquidity to regulated payment rails.

LP capital, execution risk and applicable legal obligations remain.


// Speaker notes: This is a new execution application for existing protocols, not
// a claim that all venues or transactions are legally compliant. Uniswap
// provides AMM routing; Aqua enables a custom wallet-backed position. The
// external backend does not need a new strategy selector or public API.

== Compliance roadmap --- explicitly not built here
<compliance-roadmap-explicitly-not-built-here>
#strong[Existing production context:] Anyflo access controls and counterparty screening. The mock demo does not execute those backend checks.

#strong[Future Solver goal:] inspect the complete execution plan, every route, asset, venue and counterparty #strong[before bidding and again before executing]. A changed quote or route must be checked again.

Transaction-bound validation is implemented; #strong[route AML/policy enforcement is not].


// Speaker notes: No compliance stub, success flag or placeholder checker is part
// of the hackathon. We preserve ordinary funding, amount, recipient, allowance
// and deadline safety, but those checks do not certify the entire transfer as
// compliant. This work belongs to a separate implementation session.

== Evidence and boundaries
<evidence-boundaries-and-next-steps>
#strong[Verified:] 43 Bun tests, 5 native Forge settlement tests, both real local protocol flows, and live read-only API probes. Source pins were also verified.

#strong[Mocked:] Hub/customer role, local provider HTTP and Anyflo settlement doubles. #strong[Not verified:] production backend integration or mainnet settlement.

These observations do not establish a production SLA, a best-price guarantee
or banking/compliance acceptance.

// Speaker notes: The public source must run without access to the private
// parent. The native Foundry wrapper checks real process exit status; we do not
// accept false-green builds. Sponsor sources:
// https://ethglobal.com/events/mumbai/prizes/uniswap-foundation and
// https://ethglobal.com/events/mumbai/prizes/1inch. README includes integration
// pointers and FEEDBACK.md; submitting an external feedback form or hackathon
// entry is still an operator action.


== Next steps: from prototype to bank-facing payments

1. #strong[Production integration:] integrate tested Uniswap/Aqua adapters alongside existing inventory, with reservations, monitoring and receipt-based recovery.
2. #strong[Policy and evidence:] implement pre-bid/requote checks and the audit trail; review requirements with banking/ramp partners.
3. #strong[Controlled pilot:] clear security/license reviews, verify deployments and liquidity, then authorize a capped mainnet test.
4. #strong[Fiat edges:] integrate eligible ramps, FX/fee quotes and payout confirmations against the same invoice record.

// Speaker notes: All four are future work, not newly implemented features.
// Do not enable automatic unknown-spend recovery or real-fund execution merely
// from this roadmap. UniswapX remains information-only future research; it is
// not an implemented liquidity strategy or a requirement for this pilot.
