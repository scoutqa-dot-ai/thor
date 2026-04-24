export interface PolicyArgFlag {
  name: string;
  kind: "boolean" | "value";
  aliases: readonly string[];
}

export interface ParsedPolicyArgs {
  positionals: string[];
  booleanFlags: Map<string, number>;
  valueFlags: Map<string, string[]>;
}

export function scanPolicyArgs(
  args: readonly string[],
  startIndex: number,
  flags: readonly PolicyArgFlag[],
): ParsedPolicyArgs | null {
  const exactAliases = new Map<string, PolicyArgFlag>();
  const inlineValueAliases: Array<{ prefix: string; name: string }> = [];

  for (const flag of flags) {
    for (const alias of flag.aliases) {
      exactAliases.set(alias, flag);
      if (flag.kind === "value" && alias.startsWith("--")) {
        inlineValueAliases.push({ prefix: `${alias}=`, name: flag.name });
      }
    }
  }

  const parsed: ParsedPolicyArgs = {
    positionals: [],
    booleanFlags: new Map<string, number>(),
    valueFlags: new Map<string, string[]>(),
  };

  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];

    if (!arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }

    const exact = exactAliases.get(arg);
    if (exact) {
      if (exact.kind === "boolean") {
        parsed.booleanFlags.set(exact.name, (parsed.booleanFlags.get(exact.name) ?? 0) + 1);
        continue;
      }

      if (i + 1 >= args.length) return null;
      const values = parsed.valueFlags.get(exact.name) ?? [];
      values.push(args[i + 1]);
      parsed.valueFlags.set(exact.name, values);
      i += 1;
      continue;
    }

    const inline = inlineValueAliases.find(({ prefix }) => arg.startsWith(prefix));
    if (inline) {
      const value = arg.slice(inline.prefix.length);
      if (value.length === 0) return null;
      const values = parsed.valueFlags.get(inline.name) ?? [];
      values.push(value);
      parsed.valueFlags.set(inline.name, values);
      continue;
    }

    return null;
  }

  return parsed;
}

export function booleanFlagCount(parsed: ParsedPolicyArgs, name: string): number {
  return parsed.booleanFlags.get(name) ?? 0;
}

export function valueFlagValues(parsed: ParsedPolicyArgs, name: string): string[] {
  return parsed.valueFlags.get(name) ?? [];
}
