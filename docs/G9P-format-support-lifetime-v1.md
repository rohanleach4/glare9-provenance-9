# G9P format support lifetime v1

## Approved commitment

When a G9P evidence profile is promoted from Candidate to Stable, Glare•9 Provenance will retain read-only verification support in the maintained open-source verifier for at least **ten years after the last Glare•9 Provenance release capable of writing that profile**.

The commitment is governed by these rules:

1. A Stable profile receives at least 24 months' public notice before becoming Retired for Writing.
2. Retirement for writing does not shorten its ten-year maintained-verification period.
3. Valid sealed bytes are never reinterpreted or rewritten; incompatible authenticated meaning requires a new profile/version.
4. Specifications, conformance vectors, independent-verifier source and historical release source remain publicly available under their existing licences after maintained verification ends.
5. A security or ambiguity correction must preserve the meaning of already valid bytes or publish a new version and an explicit affected-history notice.
6. A longer contractual support period may be purchased separately, but paid service cannot weaken the public format or give a private implementation a different authenticated meaning.

## Meaning of support

This is a format-compatibility and maintained-source commitment, not a warranty, service-level agreement, hosted verification promise or obligation to support every future operating system/runtime. The project may require a supported runtime or publish a portable archived verifier environment while keeping the format and verification algorithm available.

## Approval

The product owner approved this commitment on 23 August 2026. Approval establishes the support lifetime required for future Stable profiles; it does not itself promote the current Candidate profiles to Stable or claim that an installation is production-qualified.
