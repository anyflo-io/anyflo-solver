// Native Typst is the source; diagrams are rendered from Mermaid.
// Level-2 headings delimit slides; speaker notes are source comments.
#import "@preview/touying:0.8.0": *
#import themes.simple: *

#show: simple-theme.with(
  aspect-ratio: "16-9",
  config-common(slide-heading-level: 2),
  config-page(
    paper: "presentation-16-9",
    margin: (top: 56pt, x: 46pt, bottom: 30pt),
    background: align(top + right, move(dy: 38pt, image("../assets/logo.webp", width: 7%))),
  ),
)


#set text(font: "Noto Sans", size: 18pt)
#show heading.where(level: 2): set text(size: 26pt)

#let figure(body, caption: none, ..options) = std.figure(body, caption: caption, ..options)

= Anyflo DeFi Provider
<anyflo-defi-provider>
== Anyflo in one slide
<anyflo-in-one-slide>
#strong[Non-custodial stablecoin payment orchestration for businesses.]

- Customers create payment intents; independent Solvers bid to execute them.
- Existing Gateway, Coordinator and Solver Hub coordinate access and order state.
- Chain receipts establish funding and delivery; Anyflo does not custody the funds.


// Speaker notes: Anyflo is the preexisting system, not something newly built in
// this hackathon. Its backend is private. This public repository can run
// independently through published contracts and a local mock Hub. The local demo
// does not run the production backend or its screening.

== The Solver: from inventory to liquidity access
<the-solver-from-inventory-to-liquidity-access>
A Solver is the #strong[liquidity and execution agent], not a new payment network.

The existing Solver needs payout inventory. This project adds a standalone agent that uses verified customer funding to obtain the payout asset through #strong[Uniswap AMMs or a custom Aqua position].

One configured EVM pair, fixed input, one strategy and one active order.


// Speaker notes: The prototype uses Anyflo's existing direct-deposit API.
// Capital is still required in AMM pools or maker wallets; we do not create
// credit. This demo is same-chain, not an Arbitrum-to-Base bridge.

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

== Integration: choose a source, preserve Anyflo settlement
<integration-choose-a-source-preserve-anyflo-settlement>
#box(image("diagrams/diagram-1.svg", alt: "Liquidity strategy flow", width: 100%, height: 100pt, fit: "contain"))

Aqua's executable quote is on-chain. The 1inch HTTP quote is #strong[reference data]. No resolver enrollment, global position crawler or provider fallback.


// Speaker notes: This flowchart explains source choice. The config pins one
// source; the Solver does not compare routes or silently change providers after
// bidding. The same DeliveryAccount boundary settles both strategies. The local
// Hub and Anyflo contracts are labeled test doubles.

== Swimlane: auction and funding
<swimlane-auction-and-funding>
#box(image("diagrams/diagram-2.svg", alt: "Auction and funding swimlane", width: 100%, height: 210pt, fit: "contain"))

The Hub is mocked. Chain evidence is real. #strong[FUTURE] policy is not implemented.


// Speaker notes: The first swimlane covers auction and funding, not source
// selection. Uniswap quotes via its API; Aqua quotes by eth_call. DepositAccount
// forwards only solver-net funds. The Solver verifies the receipt independently.

== Swimlane: execution and delivery
<swimlane-execution-and-delivery>
#box(image("diagrams/diagram-3.svg", alt: "Execution and delivery swimlane", width: 100%, height: 210pt, fit: "contain"))

Accepted payout stays fixed. Swap and delivery are separate transactions.


// Speaker notes: The second swimlane starts after funding. The source is the
// configured AMM or SwapVM position, never an automatic fallback. The Solver
// verifies delivery and acknowledges it. Future route checks must run again
// before execution; they are not current compliance behavior.

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
    align: (auto,right,right,right,right,),
    table.header([Strategy], [Input], [Swapped], [Delivered USDC], [Checks],),
    table.hline(),
    [Uniswap V3], [10.000000], [9.990000], [9.934087], [11],
    [Aqua / SwapVM], [10.000000], [9.990000], [9.934580], [14],
  )]
  , kind: table
  )

Both start with #strong[zero Solver token balances]. Separate protocol fee: 0.100000 test USDT; retained input premium: 0.010000. These are one local run, not rates.


// Speaker notes: Actual commands: bun run demo:setup; bun run demo --strategy
// both. All tokens have six decimals. Customer gross spend is 10.1 test USDT: 10
// solver-net plus 0.1 fee. The solver swaps 9.99 and retains 0.01 input premium.
// Actual swap output may exceed the frozen customer payout; surplus does not
// change accepted terms. The evidence JSON contains local transaction
// references; they are not mainnet explorer links.

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

== Evidence, boundaries and next steps
<evidence-boundaries-and-next-steps>
#strong[Verified:] 43 Bun tests, 5 native Forge settlement tests, both real local protocol flows, and live read-only API probes. Source pins were also verified.

#strong[Mocked:] Hub/customer role, local provider HTTP and Anyflo settlement doubles. #strong[Not verified:] production backend integration or mainnet settlement.

Next: production Solver modularization and separately scoped route compliance. UniswapX remains future research only.

// Speaker notes: The public source must run without access to the private
// parent. The native Foundry wrapper checks real process exit status; we do not
// accept false-green builds. Sponsor sources:
// https://ethglobal.com/events/mumbai/prizes/uniswap-foundation and
// https://ethglobal.com/events/mumbai/prizes/1inch. README includes integration
// pointers and FEEDBACK.md; submitting an external feedback form or hackathon
// entry is still an operator action.

