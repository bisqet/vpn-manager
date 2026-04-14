import { spawn, spawnSync } from "node:child_process";

export type SshExecArgs = {
  host: string;
  port: number;
  user: string;
  password: string;
  remoteScript: string;
  timeoutMs: number;
  knownHostsFile?: string;
};

export type SshExecResult = { code: number; stdout: string; stderr: string };

export type SshExecFn = (args: SshExecArgs) => Promise<SshExecResult>;

const MAX_CAPTURE = 16_384;

function truncate(s: string): string {
  if (s.length <= MAX_CAPTURE) return s;
  return `${s.slice(0, MAX_CAPTURE)}\n… [truncated]`;
}

export function sshpassAvailable(): boolean {
  const r = spawnSync("which", ["sshpass"], { stdio: "ignore" });
  return r.status === 0;
}

export function buildSshExecUsingSpawn(): SshExecFn {
  return (args) =>
    new Promise((resolve, reject) => {
      const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", "-p", String(args.port), `${args.user}@${args.host}`, "bash", "-s"];
      if (args.knownHostsFile) {
        sshArgs.unshift("-o", `UserKnownHostsFile=${args.knownHostsFile}`, "-o", "StrictHostKeyChecking=yes");
        const idx = sshArgs.indexOf("StrictHostKeyChecking=accept-new");
        if (idx !== -1) sshArgs.splice(idx, 1);
      }

      const child = spawn("sshpass", ["-e", "ssh", ...sshArgs], {
        env: { ...process.env, SSHPASS: args.password },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`SSH timed out after ${args.timeoutMs}ms`));
      }, args.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        });
      });

      child.stdin?.write(args.remoteScript);
      child.stdin?.end();
    });
}
