# Governance

## Purpose

Provenance•9 is an open-source project maintained in public for independent use and verification and stewarded by Glare•9. Glare•9 funds and directs the reference implementation while welcoming review, compatible implementations, documentation and code contributions.

## Decision making

The project owner appoints maintainers and retains final responsibility for releases, security response, the Provenance•9 and Glare•9 brands, and the authenticated G9P formats. Routine implementation decisions use public issues and pull requests. Maintainers should explain material decisions and prefer evidence, compatibility and recoverability over convenience.

Changes to sealed bytes, trust semantics, cryptography, release controls or security boundaries require:

1. a public design proposal describing compatibility and threat impact;
2. updated specifications and conformance vectors where applicable;
3. agreement across the primary and independent verifiers;
4. passing automated assurance; and
5. two-person review when two eligible maintainers are available.

If only one maintainer is available, the change remains unreleased until a second qualified review is recorded unless it is an urgent private security fix. An urgent fix receives retrospective public review after coordinated disclosure.

## Contributions

Contributors retain copyright in their work and submit it under Apache License 2.0 using the Developer Certificate of Origin process in `CONTRIBUTING.md`. Acceptance does not transfer ownership of a contributor’s unrelated work or grant rights to Provenance•9 or Glare•9 trademarks.

Maintainers may decline changes that weaken schema neutrality, independent verification, deterministic encoding, bounded hostile-input handling, self-contained installation or the no-third-party-dependency principle. Rejection should include a concise technical reason.

## Independence and commercial activity

The open core may be used commercially without a project royalty. Glare•9 may separately charge for consultancy, integration, support, training, assurance, managed operation, maintenance and bespoke development. Paid work does not receive a hidden format advantage and must consume the public core through supported interfaces rather than a permanently divergent private fork.

## Appeals and succession

A contributor may ask for reconsideration in the applicable public issue. The project owner records the final decision and rationale. The owner may appoint or remove maintainers and should nominate successor maintainers before becoming unavailable. If the reference project becomes unmaintained, the Apache licence continues to permit independent use and forks under their own branding.
