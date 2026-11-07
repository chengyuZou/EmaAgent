import type { LogInput } from './types.js';
import { createLogRow } from './internal/record.js';
import { redactLogRow } from './internal/redact.js';
import { encodeLogWithinLimit } from './internal/limit.js';
import { writeLogLine } from './fileWriter.js';

export function logging(input: LogInput): void {
  const row = createLogRow(input);
  const redacted = redactLogRow(row);
  writeLogLine(encodeLogWithinLimit(redacted));
}
