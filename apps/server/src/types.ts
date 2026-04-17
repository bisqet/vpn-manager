import { z } from "zod";
import type { ResolveProfileSetupTerminalResult } from "./vpn/profileSetupTerminalGate";
import type { ResolveProfileSshTerminalResult } from "./vpn/profileSshTerminalGate";

type SshTerminalGateSuccess = Extract<ResolveProfileSshTerminalResult, { ok: true }>;
type SetupTerminalGateSuccess = Extract<ResolveProfileSetupTerminalResult, { ok: true }>;

declare module "hono" {
  interface ContextVariableMap {
    userId: number;
    sshTerminalGate: SshTerminalGateSuccess;
    setupTerminalGate: SetupTerminalGateSuccess;
  }
}

function refinePanelAdminCredentialsPair(
  data: { panelAdminUsername?: string | undefined; panelAdminPassword?: string | undefined },
  ctx: z.RefinementCtx,
) {
  const username = (data.panelAdminUsername ?? "").trim();
  const password = (data.panelAdminPassword ?? "").trim();
  const usernameEmpty = username === "";
  const passwordEmpty = password === "";
  if (usernameEmpty !== passwordEmpty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Panel admin username and password must both be set or both be empty.",
      path: ["panelAdminPassword"],
    });
  }
}

export const vpnProfileCreate = z
  .object({
    label: z.string().min(1),
    host: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    sshPassword: z.string().min(1),
    /** Omitted or empty allowed when `host` is a public IP (server derives panel). */
    panelHostname: z.string().optional(),
    panelAdminUsername: z.string().optional(),
    panelAdminPassword: z.string().optional(),
    panelWebBasePath: z.string().optional(),
    panelHttpsPort: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((data, ctx) => {
    refinePanelAdminCredentialsPair(data, ctx);
  });

export const vpnProfileUpdate = z
  .object({
    label: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshUser: z.string().min(1).optional(),
    sshPassword: z.string().min(1).optional(),
    /** Send empty string to clear to derived-from-host when IP or Host is a public IP. */
    panelHostname: z.string().optional(),
    panelAdminUsername: z.string().optional(),
    panelAdminPassword: z.string().optional(),
    panelWebBasePath: z.string().optional(),
    panelHttpsPort: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((data, ctx) => {
    refinePanelAdminCredentialsPair(data, ctx);
  });

export {};
