import { z } from "zod";

declare module "hono" {
  interface ContextVariableMap {
    userId: number;
  }
}

export const vpnProfileCreate = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string().min(1),
  sshPassword: z.string().min(1),
  /** Omitted or empty allowed when `host` is a public IP (server derives panel). */
  panelHostname: z.string().optional(),
});

export const vpnProfileUpdate = z.object({
  label: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).optional(),
  sshPassword: z.string().min(1).optional(),
  /** Send empty string to clear to derived-from-host when host is a public IP. */
  panelHostname: z.string().optional(),
});

export {};
