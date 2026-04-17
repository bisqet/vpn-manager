/**
 * IPv6 literals that parse as global-unicast “public” for `isPublicIpLiteral` / panel derivation.
 * Prefer `*.example.com` (or other hostnames) in tests; use these only when a literal is required.
 */
export const SYNTH_PUBLIC_V6 = "3fff:dead:beef::7" as const;
export const SYNTH_PUBLIC_V6_ALT = "3fff:dead:beef::20" as const;
export const SYNTH_PUBLIC_V6_PATCH_A = "3fff:dead:beef::21" as const;
export const SYNTH_PUBLIC_V6_PATCH_B = "3fff:dead:beef::22" as const;
export const SYNTH_PUBLIC_V6_MENU = "3fff:dead:beef::a" as const;
export const SYNTH_PUBLIC_V6_SETUP = "3fff:dead:beef::3" as const;
