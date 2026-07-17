/** Logs to STDERR only: stdout is reserved for the MCP stdio protocol. */
function write(level: string, message: string): void {
  process.stderr.write(`${new Date().toISOString()} opencode-mcp ${level} ${message}\n`);
}

export const log = {
  info: (message: string): void => write("INFO", message),
  warn: (message: string): void => write("WARN", message),
  error: (message: string): void => write("ERROR", message),
};
