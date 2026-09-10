const secretValues = new WeakMap<RedactedString, string>();

/** A string whose normal inspection and serialization are always redacted. */
export class RedactedString {
  readonly _tag = "RedactedString" as const;

  private constructor() {}

  static make(value: string): RedactedString {
    const redacted = Object.freeze(new RedactedString());
    secretValues.set(redacted, value);
    return redacted;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

/** Unwrap a secret only for the final I/O operation that consumes it. */
export async function withRedactedString<T>(
  secret: RedactedString,
  use: (value: string) => Promise<T> | T,
): Promise<T> {
  const value = secretValues.get(secret);
  if (value === undefined) {
    throw new Error("Redacted string invariant violated");
  }
  return use(value);
}
