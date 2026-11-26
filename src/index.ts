#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkCredentialsPermissionsOnStartup, formatGscError } from "./gsc-client.js";
import { createGscServer } from "./server.js";

async function main() {
  checkCredentialsPermissionsOnStartup();
  const server = createGscServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gsc-mcp server running on stdio (read-only)");
}

main().catch((error) => {
  console.error("Fatal error starting gsc-mcp:", formatGscError(error));
  process.exit(1);
});
