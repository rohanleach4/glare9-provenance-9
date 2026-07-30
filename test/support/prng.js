export function deterministicRandom(seed = 0x9e37_79b9) {
  let state = seed >>> 0;
  return {
    integer(maxExclusive) {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) throw new TypeError("maxExclusive must be positive");
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % maxExclusive;
    },
    boolean() {
      return this.integer(2) === 1;
    },
    bytes(length) {
      return Uint8Array.from({ length }, () => this.integer(256));
    },
    seed() {
      return state;
    },
  };
}
