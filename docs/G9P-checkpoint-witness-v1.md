# G9P checkpoint, witness receipt and threshold policy protocol v1

## Status

This document specifies a candidate protocol. It does not alter segment versions 1 or 2. Checkpoint and witness containers require implementation, conformance vectors and owner/protocol approval before their formats are stable.

## Checkpoint descriptor

A checkpoint uses container version 2 and exact frames `CHK1`, `SIG1`, `END!`. Its canonical descriptor contains `kind`, `protocolVersion`, `ledgerId`, `checkpointNumber`, `createdAt`, `previousCheckpointHash`, `routingEpochNumber`, `routingEpochHash`, complete ordered `shardHeads` and `publisher`. Each head contains epoch, shard ID, segment number/hash or an explicit empty statement.

The logical commitment is `SHA256-domain("checkpoint-v1", CHK1 payload)`, the signature input is `SHA256-domain("checkpoint-signature-v1", CHK1 payload)`, and the exact file commitment is `SHA256-domain("checkpoint-file-v1", every byte through END!)`.

## Witness receipt

A separately administered witness first verifies the checkpoint, its publisher trust, routing descriptor and every referenced shard head. It then writes container version 2 frames `WIT1`, `SIG1`, `END!`. The receipt binds ledger/checkpoint identity, logical checkpoint hash, exact checkpoint file hash, observation time and witness identity.

Domains are `witness-receipt-v1`, `witness-signature-v1` and `witness-file-v1`. A receipt proves only that the identified witness signed the exact checkpoint commitment under its stated verification policy.

## Threshold attestation

The canonical threshold policy has exact fields `kind: "g9p-threshold-policy"`, `version: 1`, positive `threshold` and a sorted unique list of registered witness key IDs. A threshold attestation is the checkpoint plus distinct valid witness receipts satisfying that external policy. Receipt order is irrelevant; duplicate keys count once. The bundle itself needs no new trust-bearing signature because every constituent receipt is independently signed.

Witnesses must be operationally independent of the ledger writer to improve assurance. A witness outage reduces finality and must never be represented as witnessed success.
