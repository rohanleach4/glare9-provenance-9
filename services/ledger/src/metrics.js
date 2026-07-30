function metric(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

export function ledgerMetrics(info) {
  return [
    metric("g9p_ledger_ready", "Whether the ledger has no recorded background failure.", info.backgroundError === null ? 1 : 0),
    metric("g9p_ledger_known_events", "Events reconstructed from sealed verified history.", info.knownEvents),
    metric("g9p_ledger_accepted_events", "Events retained in durable accepted intake.", info.acceptedEvents),
    metric("g9p_ledger_accepted_bytes", "Canonical bytes retained in durable accepted intake.", info.acceptedBytes),
    metric("g9p_ledger_provisional_events", "Events in completed provisional blocks.", info.provisionalEvents),
    metric("g9p_ledger_active_segments", "Active epoch-scoped shard segments.", info.activeSegments),
    metric("g9p_ledger_active_block_bytes", "Aggregate uncompressed bytes in active memory blocks.", info.activeBlockBytes),
    metric("g9p_ledger_routing_ledgers", "Ledgers with verified signed routing history.", info.knownRoutingLedgers),
    metric("g9p_ledger_intake_event_capacity", "Configured durable intake event capacity.", info.lifecycle.maxAcceptedEvents),
    metric("g9p_ledger_intake_byte_capacity", "Configured durable intake byte capacity.", info.lifecycle.maxAcceptedBytes),
    metric("g9p_ledger_active_block_byte_capacity", "Configured aggregate active-block memory capacity.", info.lifecycle.maxActiveBlockBytes),
  ].join("");
}
