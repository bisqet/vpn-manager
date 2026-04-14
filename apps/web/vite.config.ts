import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Default `host: "localhost"` can bind IPv4-only while some browsers resolve
    // `localhost` to IPv6 first → ERR_CONNECTION_REFUSED (-102). Listening on
    // all local addresses avoids that split on Windows/Chrome.
    host: true,
    proxy: {
      // Use IPv4 literal: Node may resolve `localhost` to ::1; proxy then hits
      // ::1:3000 while Bun/API often listens on 127.0.0.1 only → EACCES / failures.
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        // Required for browser SSH (`ws://` → `/api/profiles/:id/ssh`); string shorthand does not proxy upgrades.
        ws: true,
      },
    },
  },
});
