import { validateLifecycleReceipt } from "./client.js";
import { ProvenanceServiceError } from "./errors.js";

const stage = Object.freeze({ accepted: 0, provisional: 1, sealed: 2 });

function conflict(message) {
  throw new ProvenanceServiceError(message, {
    code: "RECEIPT_RECONCILIATION_CONFLICT",
    retryable: false,
  });
}

export function reconcileLifecycleReceipt(storedReceipt, currentReceipt) {
  validateLifecycleReceipt(storedReceipt);
  validateLifecycleReceipt(currentReceipt);
  if (currentReceipt.eventId !== storedReceipt.eventId) {
    conflict("Ledger receipt identifies a different event");
  }
  if (currentReceipt.ledgerId !== storedReceipt.ledgerId) {
    conflict("Ledger receipt identifies a different ledger");
  }
  if (currentReceipt.recordHash !== storedReceipt.recordHash) {
    conflict("Ledger receipt identifies different canonical event content");
  }
  if (stage[currentReceipt.status] < stage[storedReceipt.status]) {
    conflict("Ledger receipt state regressed during reconciliation");
  }
  return {
    advanced: stage[currentReceipt.status] > stage[storedReceipt.status],
    receipt: currentReceipt,
  };
}
