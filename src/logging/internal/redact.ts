import type { LogError, LogRow, LogValue } from '../types.js';

let protectedValues: readonly string[] = [];
const secretKeys = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey',
  'apikey', 'token', 'accesstoken', 'refreshtoken', 'password', 'secret', 'clientsecret',
]);

export function setDiagnosticSecrets(values: readonly string[]): void {
  protectedValues = [...new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]))]
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string): string {
  let text = value;
  for (const secret of protectedValues) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|secret|password|access_token|refresh_token)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

function redactValue(value: LogValue): LogValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
      const redacted = secretKeys.has(normalizedKey) ? '[REDACTED]' : redactValue(item);
      return [key, redacted];
    });
    return Object.fromEntries(entries);
  }
  return value;
}

export function redactLogRow(row: LogRow): LogRow {
  return {
    ...row,
    message: row.message === undefined ? undefined : redactText(row.message),
    error: row.error === undefined ? undefined : redactError(row.error),
    body: redactValue(row.body) as LogRow['body'],
  };
}

function redactError(error: LogError): LogError {
  return {
    ...error,
    name: error.name === undefined ? undefined : redactText(error.name),
    message: redactText(error.message),
    stack: error.stack === undefined ? undefined : redactText(error.stack),
    code: typeof error.code === 'string' ? redactText(error.code) : error.code,
    cause: error.cause === undefined ? undefined : redactError(error.cause),
  };
}
