#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runDoctor } from "../src/cli/doctor.js";
import { runInstallMobile } from "../src/cli/install_mobile.js";
import { runReplay } from "../src/cli/replay.js";
import { buildServer, SERVER_VERSION } from "../src/server.js";
import { log } from "../src/util/log.js";

const HELP = `rolepod-uiproof ${SERVER_VERSION}

Usage:
  rolepod-uiproof                 Start the MCP server on stdio (default)
  rolepod-uiproof doctor          Health check (Node, Playwright, Appium, SDKs)
  rolepod-uiproof install:mobile  Install Appium + drivers (add --checklist to only print steps)
  rolepod-uiproof replay <file>   Re-run a verify_ui_flow replay bundle
  rolepod-uiproof --version       Print version
  rolepod-uiproof --help          This help
`;

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  switch (sub) {
    case undefined:
    case "serve":
      return startServer();
    case "doctor":
      process.exit(await runDoctor());
      return;
    case "install:mobile":
    case "install":
      process.exit(await runInstallMobile(rest));
      return;
    case "replay": {
      const target = rest[0];
      if (!target) {
        process.stderr.write("Usage: rolepod-uiproof replay <bundle.json>\n");
        process.exit(2);
      }
      process.exit(await runReplay(target));
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${SERVER_VERSION}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n${HELP}`);
      process.exit(2);
  }
}

async function startServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info("shutting down", { signal });
    await server.shutdown().catch((err: unknown) =>
      log.error("shutdown failed", { err: String(err) }),
    );
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // MCP hosts that die without signaling us just close the stdio pipe.
  // Without this, spawned children (Appium daemon, browsers) would keep
  // this process — and themselves — alive as orphans.
  process.stdin.on("end", () => void shutdown("SIGHUP"));
  process.stdin.on("close", () => void shutdown("SIGHUP"));

  await server.mcp.connect(transport);
  log.info("rolepod-uiproof connected on stdio");
}

main().catch((err: unknown) => {
  log.error("fatal startup error", {
    err: err instanceof Error ? err.stack : String(err),
  });
  process.exit(1);
});
