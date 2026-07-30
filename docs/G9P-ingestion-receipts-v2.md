# G9P Ingestion and Receipt Contract Version 2

## Status and scope

This document specifies the stable accepted-first HTTP ingestion and receipt-polling contract implemented by the reference ledger service and shared connector client.

It is a service contract, not a G9P container-format revision. It does not change canonical event bytes, block frames, segment commitments, signatures or offline verification.

## Authentication

All endpoints in this contract require the ledger ingestion bearer credential. Receipt lookup does not use the separate routing-administration credential.

Transport TLS and production service identity remain deployment requirements outside this local reference profile.

## Accepted-first ingestion

```text
POST /v2/events:batch
Authorization: Bearer <ingestion credential>
Content-Type: application/json
```

The request contains exactly the versioned contract selector and an ordered non-empty event array:

```json
{
  "contractVersion": 2,
  "events": []
}
```

A successful response uses HTTP 202 and contains one receipt for each request event in the same order:

```json
{
  "contractVersion": 2,
  "receipts": [],
  "requestId": "diagnostic request identity"
}
```

HTTP 202 means that every returned event reached at least the receipt state stated in its receipt. It does not imply that every event is already sealed.

Submission is idempotent by `eventId` and canonical event content. Repeating identical content returns its current receipt state. Reusing an event ID for different canonical content returns `EVENT_ID_CONFLICT`.

## Receipt states

State progression is monotonic:

```text
accepted → provisional → sealed
```

A response may skip a visible intermediate state when processing advances before the response or poll.

### Accepted

`accepted` means the canonical event is durably retained in topology-neutral intake. No routing epoch, shard or segment position is promised yet.

```text
eventId
status              "accepted"
ledgerId
recordHash          64 lowercase hexadecimal characters
intakeSequence      non-negative safe integer
acceptedAt          canonical UTC timestamp
```

Durable accepted state transfers custody from a connector to the ledger. A connector may mark its source outbox row delivered after it has validated and stored this receipt.

### Provisional

`provisional` means the event is assigned to a completed, synchronised compressed block in active service state. It does not have a final segment hash or producer signature.

```text
all accepted fields
status              "provisional"
shardId
routingEpochNumber  non-negative safe integer
segmentNumber       non-negative safe integer
blockIndex          non-negative safe integer
recordIndex         non-negative safe integer within the segment
openedAt            canonical UTC timestamp for the active segment
```

Provisional placement is recovered and reconciled with durable intake after restart. It may advance to sealed during recovery but must not regress to accepted after it has been returned successfully.

### Sealed

`sealed` means the event is included in a verified final `.g9p` segment.

```text
eventId
status              "sealed"
ledgerId
recordHash          64 lowercase hexadecimal characters
shardId
routingEpochNumber  non-negative safe integer
segmentNumber       non-negative safe integer
recordIndex         non-negative safe integer within the segment
segmentHash         64 lowercase hexadecimal characters
signerKeyId         64 lowercase hexadecimal characters
```

The embedded signer identity and receipt do not independently establish signer trust. Trust still requires the applicable external key and routing policies and, when required, offline segment verification.

## Receipt polling

```text
GET /v2/receipts/<percent-encoded-event-id>?recordHash=<expected-record-hash>
Authorization: Bearer <ingestion credential>
```

The expected record hash is mandatory. It binds the lookup to the canonical content the caller submitted rather than event identity alone.

A successful response uses HTTP 200:

```json
{
  "contractVersion": 2,
  "receipt": {},
  "requestId": "diagnostic request identity"
}
```

Polling is read-only and idempotent. Clients choose their own bounded retry interval and stop when they reach the finality required by their policy. Version 2 defines polling but no server-initiated callback, webhook or delivery guarantee.

## Error semantics

Representative stable errors are:

```text
401 UNAUTHORISED          missing or invalid ingestion credential
404 RECEIPT_NOT_FOUND     no accepted or sealed event has that identity
409 EVENT_ID_CONFLICT     event identity exists with a different record hash or content
413 REQUEST_TOO_LARGE     ingestion request exceeds the configured byte limit
429 LEDGER_BACKPRESSURE   capacity was not available before acceptance; retryable
503 service/storage error durable completion could not be confirmed; retryable
```

Every error response contains `code`, `message`, `retryable` and `requestId`. A caller receiving an uncertain transport or acknowledgement failure retries the identical event. It must not generate a replacement event ID merely because the response was lost.

## Retention and recovery

- Accepted and provisional receipts remain queryable while their durable intake is retained.
- Sealed receipts are reconstructed from verified segment history after restart.
- Intake is retired only after the corresponding sealed segment is authoritative.
- A crash after acceptance or sealing but before acknowledgement does not create a second event.
- Routing transitions force-seal the complete old-epoch barrier before activating the new descriptor; retained post-barrier intake is assigned only under the new epoch.

## Version 1 compatibility

`POST /v1/events:batch` remains available as the synchronous sealed-only compatibility contract. Its response is not reinterpreted as version 2, and connectors must validate the contract version they selected.
