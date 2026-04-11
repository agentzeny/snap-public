export function getRecordField(
  value: Record<string, unknown>,
  ...names: string[]
): unknown {
  for (const name of names) {
    if (name in value) {
      return value[name];
    }
  }

  return undefined;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }

  throw new Error(`SNAP: Cannot convert value to number: ${String(value)}`);
}

export function normalizeBytesMatrix(value: unknown): Uint8Array[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => Uint8Array.from(entry as ArrayLike<number>));
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}
