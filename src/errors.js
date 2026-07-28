export class G9pError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "G9pError";
    this.code = code;
  }
}

export function fail(code, message, cause) {
  throw new G9pError(code, message, cause === undefined ? {} : { cause });
}

export function invariant(condition, code, message) {
  if (!condition) {
    fail(code, message);
  }
}
