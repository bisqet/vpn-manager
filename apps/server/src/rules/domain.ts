export function normalizeDomainSuffix(input: string): string {
  const s = input.trim().toLowerCase();
  if (s.startsWith("*.")) return "." + s.slice(2);
  if (s.startsWith("*")) return "." + s.slice(1);
  return s;
}

export function assertValidDomainRule(normalized: string) {
  if (!normalized.startsWith(".")) {
    throw new Error("Domain rule must start with '.' after normalization (e.g. '.ru')");
  }
}
