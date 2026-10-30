// stdout is reserved for JSON-RPC with the Copilot runtime, so all diagnostics go to stderr.
export function log(level, message, extra) {
  const line = `[docker-canvas] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  try {
    process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${safeJson(extra)}\n`);
  } catch {
    // Never let logging break the extension.
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
