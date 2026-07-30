const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/u;

export function validateTablePath(value) {
  if (typeof value !== "string") throw new TypeError("Outbox table name must be a string");
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new TypeError("Outbox table must be an unquoted table name or schema.table using safe MySQL identifiers");
  }
  return value;
}

export function quoteTablePath(value) {
  validateTablePath(value);
  const parts = value.split(".");
  return parts.map((part) => `\`${part}\``).join(".");
}
