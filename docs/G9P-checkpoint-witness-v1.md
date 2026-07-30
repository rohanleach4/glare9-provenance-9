# G9P checkpoint, witness receipt and threshold policy protocol v1

## Status

This document specifies the implemented experimental protocol. It does not alter segment versions 1 or 2. Checkpoint and witness containers have primary and independent verification plus conformance vectors, but owner/protocol approval remains required before their formats are stable.

## Checkpoint descriptor

A checkpoint uses container version 2 and exact frames `CHK1`, `SIG1`, `END!`. Its canonical descriptor contains `kind`, `protocolVersion`, `ledgerId`, `checkpointNumber`, `createdAt`, `previousCheckpointHash`, `routingEpochNumber`, `routingEpochHash`, complete ordered `shardHeads` and `publisher`. Each head contains epoch, shard ID, segment number/hash or an explicit empty statement.

The logical commitment is `SHA256-domain("checkpoint-v1", CHK1 payload)`, the signature input is `SHA256-domain("checkpoint-signature-v1", CHK1 payload)`, and the exact file commitment is `SHA256-domain("checkpoint-file-v1", every byte through END!)`.

## Witness receipt

A separately administered witness first verifies the checkpoint signature and an explicitly configured publisher trust set. It then writes container version 2 frames `WIT1`, `SIG1`, `END!`. The receipt binds ledger/checkpoint identity, logical checkpoint hash, exact checkpoint file hash, observation time and witness identity.

Domains are `witness-receipt-v1`, `witness-signature-v1` and `witness-file-v1`. A version 1 receipt proves only that the identified witness verified the checkpoint container and configured publisher trust before signing the exact checkpoint commitment. It does not prove that the witness independently possessed or traversed every referenced segment. A future stronger evidence-validation policy requires a new receipt protocol version or separately authenticated policy field.

## Threshold attestation

The canonical threshold policy has exact fields `kind: "g9p-threshold-policy"`, `version: 1`, positive `threshold` and a sorted unique list of registered witness key IDs. A threshold attestation is the checkpoint plus distinct valid witness receipts satisfying that external policy. Receipt order is irrelevant; duplicate keys count once. The bundle itself needs no new trust-bearing signature because every constituent receipt is independently signed.

Witnesses must be operationally independent of the ledger writer to improve assurance. A witness outage reduces finality and must never be represented as witnessed success.

## Implemented operation

The ledger exposes a separately authenticated checkpoint-administration operation. Publication first seals accepted/provisional work, records the current head or explicit emptiness of every shard in the active signed routing epoch, links to the previous checkpoint and publishes create-only `.g9p` bytes under a distinct checkpoint-publisher key.

The reference witness is a one-shot, separately deployable workspace under `services/witness`. It reads a copied checkpoint, trusts only configured publisher key IDs, uses its own externally supplied key and writes one create-only receipt. The threshold verifier accepts only a sorted unique witness membership, validates every receipt and counts each matching trusted witness key once.

Generated local checkpoint-publisher keys and the reference witness file-key adapter are development facilities. Production signer custody, operational independence and stronger full-history witness policy remain approval and deployment gates.
