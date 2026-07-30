function metric(name, help, value, type = "gauge") {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

function timestamp(value) {
  if (value === null) return 0;
  const milliseconds = new Date(value).valueOf();
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0;
}

export function connectorMetrics(snapshot, ready, outbox) {
  const processMetrics = [
    metric("g9p_mysql_connector_ready", "Whether the connector can query its MySQL dependency.", ready ? 1 : 0),
    metric("g9p_mysql_connector_running", "Whether the connector worker loop reports running state.", snapshot.state === "running" ? 1 : 0),
    metric("g9p_mysql_connector_in_flight", "Outbox events in the currently claimed batch.", snapshot.inFlight),
    metric("g9p_mysql_connector_delivered_events_total", "Events delivered since process start.", snapshot.deliveredEvents, "counter"),
    metric("g9p_mysql_connector_failed_batches_total", "Failed delivery or loop batches since process start.", snapshot.failedBatches, "counter"),
    metric("g9p_mysql_connector_last_success_timestamp_seconds", "Unix timestamp of the last successful delivery.", timestamp(snapshot.lastSuccessAt)),
    metric("g9p_mysql_connector_last_error_timestamp_seconds", "Unix timestamp of the last delivery or loop error.", timestamp(snapshot.lastErrorAt)),
  ];
  if (outbox !== undefined) {
    processMetrics.push(
      metric("g9p_mysql_outbox_ready_events", "Outbox events currently available for lease.", outbox.readyCount),
      metric("g9p_mysql_outbox_leased_events", "Undelivered outbox events with unexpired leases.", outbox.leasedCount),
      metric("g9p_mysql_outbox_delivered_events", "Outbox rows with persisted custody receipts.", outbox.deliveredCount),
      metric("g9p_mysql_outbox_dead_lettered_events", "Outbox rows quarantined for operator review.", outbox.deadLetteredCount),
      metric("g9p_mysql_outbox_oldest_ready_age_seconds", "Age of the oldest currently available outbox event.", outbox.oldestReadyAgeSeconds),
    );
  }
  return processMetrics.join("");
}
