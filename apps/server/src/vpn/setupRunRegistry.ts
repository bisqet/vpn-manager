const controllers = new Map<number, AbortController>();

export function beginSetupRun(
  profileId: number,
): { ok: true; signal: AbortSignal } | { ok: false } {
  if (controllers.has(profileId)) {
    return { ok: false };
  }
  const ac = new AbortController();
  controllers.set(profileId, ac);
  return { ok: true, signal: ac.signal };
}

export function endSetupRun(profileId: number): void {
  controllers.delete(profileId);
}

export function signalSetupRunCancel(profileId: number): void {
  controllers.get(profileId)?.abort();
}

export function isSetupRunActive(profileId: number): boolean {
  return controllers.has(profileId);
}
