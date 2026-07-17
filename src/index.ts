#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAskCodebase } from "./ask-codebase.ts";
import {
  AGENT,
  MANIFEST_FILE,
  OPENCODE_BIN,
  REPOS_DIR,
  RUN_TIMEOUT_MS,
  TTL_MS,
} from "./config.ts";
import { log } from "./logger.ts";

const server = new McpServer({ name: "opencode-mcp", version: "1.0.0" });
registerAskCodebase(server);

log.info(
  `starting — bin=${OPENCODE_BIN} agent=${AGENT || "(default)"} repos=${REPOS_DIR} ` +
    `manifest=${MANIFEST_FILE} ttl=${(TTL_MS / 86_400_000).toFixed(1)}d ` +
    `hard_timeout=${(RUN_TIMEOUT_MS / 1000).toFixed(0)}s`,
);

try {
  await server.connect(new StdioServerTransport());
} catch (err) {
  log.error(`fatal: ${String(err)}`);
  process.exit(1);
}
