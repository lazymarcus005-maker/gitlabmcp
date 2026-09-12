/**
 * Audit logger (NFR-2): one JSON line per tool call on stdout.
 * Non-blocking: failures are swallowed and never break tool execution.
 * Content is passed through the redaction layer; no tokens are logged.
 */
import { redact } from "../security/redaction.js";

export interface AuditRecord {
  request_id: string;
  gitlab: { host: string; user_id: number; username: string };
  tool: string;
  result: "success" | "error";
  duration_ms: number;
}

function writeLine(record: AuditRecord): void {
  try {
    const safe = redact(record);
    process.stdout.write(`${JSON.stringify(safe)}\n`);
  } catch {
    // Audit failures must never block tool execution.
  }
}

export function auditToolCall(record: AuditRecord): void {
  // stdout writes are synchronous enough for our purposes; the try/catch
  // guarantees tool execution is never blocked by logging.
  writeLine(record);
}
