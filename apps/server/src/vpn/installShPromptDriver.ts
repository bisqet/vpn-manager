/**
 * Expect-style prompt handling for MHSanaei/3x-ui `install.sh` over a PTY.
 * `whenIncludes` strings are matched against decoded plaintext (see `ptyPlaintext.ts`).
 *
 * The result `status: "completed"` is reserved for a future session hook that can signal
 * stream end alongside the `subscribeData` cleanup path; today callers end the driver with
 * `AbortSignal` or `globalTimeoutMs`.
 */

export type PromptRule = {
  id: string;
  whenIncludes: string;
  send: string;
  /** Reserved for per-rule idle detection; v1 uses {@link RunPromptDriverOptions.globalTimeoutMs} only. */
  timeoutMs: number;
};

export type CreateInstallShPromptRulesCtx = {
  panelHostname: string;
  isPanelIp: boolean;
};

function sortRulesByWhenIncludesLengthDesc(rules: PromptRule[]): PromptRule[] {
  return [...rules].sort((a, b) => b.whenIncludes.length - a.whenIncludes.length);
}

/**
 * Ordered rules for 3x-ui `install.sh` (see upstream `read -rp` prompts).
 * Rules are sorted by descending `whenIncludes` length so shorter shared prefixes
 * do not answer earlier prompts.
 */
export function createInstallShPromptRules(ctx: CreateInstallShPromptRulesCtx): PromptRule[] {
  const sslSend = ctx.isPanelIp ? "2" : "1";
  const rules: PromptRule[] = [
    {
      id: "panel-port-customize",
      whenIncludes: "Would you like to customize the Panel Port settings?",
      send: "n",
      timeoutMs: 120_000,
    },
    {
      id: "panel-cert-for-panel",
      whenIncludes: "Would you like to set this certificate for the panel?",
      send: "y",
      timeoutMs: 120_000,
    },
    {
      id: "acme-http01-port",
      whenIncludes: "Port to use for ACME HTTP-01 listener (default 80):",
      send: "\n",
      timeoutMs: 120_000,
    },
    {
      id: "web-port-default-80",
      whenIncludes: "Please choose which port to use (default is 80):",
      send: "\n",
      timeoutMs: 120_000,
    },
    {
      id: "ipv6-include",
      whenIncludes: "Do you have an IPv6 address to include?",
      send: "\n",
      timeoutMs: 120_000,
    },
    {
      id: "ssl-menu-ip-vs-domain",
      whenIncludes: "Choose an option (default 2 for IP):",
      send: sslSend,
      timeoutMs: 120_000,
    },
    {
      id: "acme-reloadcmd",
      whenIncludes: "Would you like to modify --reloadcmd",
      send: "n",
      timeoutMs: 120_000,
    },
    {
      id: "domain-name",
      whenIncludes: "Please enter your domain name:",
      send: `${ctx.panelHostname}`,
      timeoutMs: 120_000,
    },
  ];
  return sortRulesByWhenIncludesLengthDesc(rules);
}

export type RunPromptDriverOptions = {
  write: (s: string) => void;
  subscribeData: (cb: (chunk: Uint8Array) => void) => () => void;
  rules: PromptRule[];
  plaintext: {
    append(chunk: Uint8Array): void;
    getPlaintext(): string;
  };
  globalTimeoutMs: number;
  signal: AbortSignal;
};

export type RunPromptDriverResult =
  | { status: "completed"; lastRuleId?: string }
  | { status: "timeout"; lastRuleId?: string }
  | { status: "aborted"; lastRuleId?: string };

function lineForReadRp(send: string): string {
  return send.endsWith("\n") ? send : `${send}\n`;
}

/**
 * Matches install prompts in PTY plaintext and writes replies. Global idle timer starts on
 * the first chunk and resets after each successful rule write.
 */
export async function runPromptDriver(options: RunPromptDriverOptions): Promise<RunPromptDriverResult> {
  const { write, subscribeData, rules, plaintext, globalTimeoutMs, signal } = options;

  let settled = false;
  let lastRuleId: string | undefined;
  let userUnsubscribe: (() => void) | undefined;

  let globalTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGlobalTimer = () => {
    if (globalTimer !== undefined) {
      clearTimeout(globalTimer);
      globalTimer = undefined;
    }
  };

  let settle!: (r: RunPromptDriverResult) => void;
  const done = new Promise<RunPromptDriverResult>((resolve) => {
    settle = (r: RunPromptDriverResult) => {
      if (settled) return;
      settled = true;
      clearGlobalTimer();
      signal.removeEventListener("abort", onAbort);
      userUnsubscribe?.();
      resolve(r);
    };
  });

  const bumpGlobalTimer = () => {
    clearGlobalTimer();
    globalTimer = setTimeout(() => {
      settle({ status: "timeout", lastRuleId });
    }, globalTimeoutMs);
  };

  const fired = new Set<string>();

  const onAbort = () => {
    settle({ status: "aborted", lastRuleId });
  };

  if (signal.aborted) {
    return { status: "aborted" };
  }
  signal.addEventListener("abort", onAbort, { once: true });

  /** At most one rule per incoming chunk (see unit tests for substring ordering). */
  const processPlaintextOnce = () => {
    const text = plaintext.getPlaintext();
    for (const rule of rules) {
      if (fired.has(rule.id)) continue;
      if (!text.includes(rule.whenIncludes)) continue;
      fired.add(rule.id);
      lastRuleId = rule.id;
      write(lineForReadRp(rule.send));
      bumpGlobalTimer();
      return;
    }
  };

  const onChunk = (chunk: Uint8Array) => {
    plaintext.append(chunk);
    if (globalTimer === undefined) {
      bumpGlobalTimer();
    }
    processPlaintextOnce();
  };

  userUnsubscribe = subscribeData(onChunk);

  return await done;
}
