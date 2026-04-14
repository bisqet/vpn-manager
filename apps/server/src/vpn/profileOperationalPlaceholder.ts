/** Placeholder until real SSH / health checks exist. Always succeeds. */
export async function verifyProfileHealthPlaceholder(): Promise<"working"> {
  await new Promise((r) => setTimeout(r, 10));
  return "working";
}

/** Simulates remote setup work (SSH, package install, etc.). */
export async function simulateSetupWork(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}
