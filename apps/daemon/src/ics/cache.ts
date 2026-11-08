/** Rendered ICS bodies by key, least recently used evicted first once the total exceeds `maxBytes`. */
export function createByteLru(maxBytes: number) {
  const entries = new Map<string, Uint8Array<ArrayBuffer>>();
  let bytes = 0;

  const remove = (key: string) => {
    const value = entries.get(key);
    if (!value) return;
    entries.delete(key);
    bytes -= value.byteLength;
  };

  return {
    get(key: string) {
      const value = entries.get(key);
      if (!value) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    /** Stores `value` unless it alone exceeds the bound, then evicts until the total fits. */
    set(key: string, value: Uint8Array<ArrayBuffer>) {
      remove(key);
      if (value.byteLength > maxBytes) return;
      entries.set(key, value);
      bytes += value.byteLength;
      for (const oldest of entries.keys()) {
        if (bytes <= maxBytes) break;
        remove(oldest);
      }
    },
    get bytes() {
      return bytes;
    },
  };
}
