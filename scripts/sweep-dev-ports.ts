import killPort from "kill-port";

await Promise.all([killPort(3000), killPort(5173)]);
