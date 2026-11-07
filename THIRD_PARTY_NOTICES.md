# Third-party code and licenses

The project's own code is covered by [MPL-2.0](LICENSE). That does not replace or
extend the licenses of its dependencies or the upstream contracts used by the
demo. Dependencies are fetched from public distributions; upstream source and
license notices are retained in those distributions.

## Runtime SDKs

- `@anyflo/lib` 0.1.0: MPL-2.0. Published public wire contracts and helpers.
- `@uniswap/universal-router-sdk` 5.16.2: MIT.
  Source: <https://github.com/Uniswap/sdks>.
- `@1inch/aqua-sdk` 0.4.0:
  `LicenseRef-Degensoft-Aqua-Source-1.1`.
- `@1inch/swap-vm-sdk` 0.5.0:
  `LicenseRef-Degensoft-SwapVM-1.1`.
  Both 1inch SDKs come from <https://github.com/1inch/sdks>.

The 1inch licenses are source-available licenses with their own conditions;
they must not be described as MIT or as unrestricted commercial grants.

## Local protocol deployments

`scripts/setup-foundry.ts` records the exact public releases, commits and archive
checksums. It acquires unchanged Aqua, SwapVM, Uniswap, Permit2, OpenZeppelin,
Solmate and forge-std source/artifacts inside ignored `foundry/vendor/`.
Their original license files and source notices remain authoritative. In
particular, the Solmate code carries AGPL-3.0-only notices; Aqua/SwapVM have their
own upstream terms. The setup does not turn those contracts into project-owned
or newly authored swap engines.

The small Anyflo settlement contracts in `foundry/contracts/` are explicitly
labeled test doubles. They are not copies or proof of the private production
contracts.

Before production or commercial deployment, verify the applicable upstream
terms and obtain any required permission. A local hackathon demonstration is not
license clearance or regulatory certification.
