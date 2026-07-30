# G9P hostile-input resource-limit review v1

## Scope

This review covers request admission, canonical decoding, frame parsing, record framing, compressed-block expansion, sealed-object loading, routing descriptors, active state and durable intake. Its objective is to ensure attacker-controlled lengths and counts are rejected before unbounded allocation or iteration.

## Enforced limits

| Boundary | Default ceiling |
| --- | ---: |
| HTTP request body | 8 MiB |
| Events per HTTP batch | 500 |
| Canonical decode input/value bytes | 64 MiB |
| Canonical collection entries | 1,000,000 |
| Canonical nesting depth | 64 |
| Segment object | 512 MiB |
| Routing-epoch object | 64 MiB |
| Individual frame | 64 MiB |
| Decompressed block | 64 MiB |
| Canonical event record | 16 MiB |
| Blocks per segment | 65,536 |
| Records per segment verifier run | 10,000,000 |
| Previous shard heads | 65,536 |
| Durable intake record | 64 MiB |
| Provisional active-segment state | 128 MiB |

Deployment configuration imposes tighter normal admission defaults: 1 MiB active blocks, 32 MiB logical segments, 1,000 records per block, 10,000 records per segment and an 8 MiB HTTP request.

## Findings

- File-backed readers check `stat` size before reading; storage adapters apply bounded reads.
- Byte verifiers check whole-object size before frame parsing.
- Frame and record length prefixes are compared with configured maxima before payload slicing.
- Canonical lengths must fit JavaScript's safe-integer range; collection counts and recursive depth are bounded before loops recurse.
- Zstandard expansion receives `maxOutputLength`, and the authenticated declared length must fit the verifier ceiling before decompression begins.
- Block count and total record count are bounded before full verification completes.
- HTTP bodies are accumulated only up to the configured request limit, and event count is checked before ledger admission.
- Accepted intake, provisional state and active memory have separate back-pressure ceilings.

No unbounded allocation path was identified within the reviewed parser and verifier entry points. The high protocol maxima are hostile-input safety ceilings, not recommended deployment sizing. Operators should lower them when their evidence profile permits.

## Automated evidence and residual risk

`test/resource-limits.test.js` supplies hostile declared lengths, excessive collections, excessive nesting and decompression expansion claims and confirms rejection at the intended boundary. Existing tamper tests cover truncation, frame ordering, commitments and signatures.

Residual work belongs to continuous fuzzing, property testing, dependency review and deployment load testing. Native Zstandard and the Node.js runtime remain part of the trusted implementation base and must receive security updates.
