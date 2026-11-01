// A provider's error often arrives as its raw JSON body ({"code":429,"reason":"TOKEN_LIMIT_EXCEEDED","message":"…"}). This keeps the
// sentence a person can read, with the code after it. No imports: the dashboard uses it too.
export function plainError(raw: unknown): string {
  const text = String(raw ?? '').trim(); const at = text.indexOf('{');
  if (at < 0) return text;
  try {
    const body = JSON.parse(text.slice(at, text.lastIndexOf('}') + 1));
    const e = body && typeof body.error === 'object' && body.error ? body.error : body;
    const message = typeof e?.message === 'string' ? e.message.trim() : typeof body?.error === 'string' ? body.error.trim() : '';
    if (!message) return text;
    const code = [e.code ?? e.status, e.reason ?? e.type].filter(x => x !== undefined && x !== null && x !== '').join(' ');
    const before = text.slice(0, at).trim().replace(/[:(\s]+$/, '');
    return `${before ? before + ': ' : ''}${message}${code ? ` (${code})` : ''}`;
  } catch { return text; }
}
