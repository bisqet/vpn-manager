import { z } from "zod";

declare module "hono" {
  interface ContextVariableMap {
    userId: number;
  }
}

const panelHostnameSchema = z
  .string()
  .min(1)
  .regex(
    /^([a-zA-Z0-9](-*[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/,
    "panelHostname must be a DNS name (FQDN)",
  );

export const vpnProfileCreate = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string().min(1),
  sshPassword: z.string().min(1),
  panelHostname: panelHostnameSchema,
});

export const vpnProfileUpdate = z.object({
  label: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).optional(),
  sshPassword: z.string().min(1).optional(),
  panelHostname: panelHostnameSchema.optional(),
});

export {};
