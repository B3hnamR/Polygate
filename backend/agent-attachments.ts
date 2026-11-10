export const MAX_AGENT_FILES = 8;
export const MAX_AGENT_FILE_BYTES = 10 * 1024 * 1024;
export type AgentFile = { name: string; mime: string; data: string; source: { type: 'inline' } };

// OpenCode 2.2.5 PromptInput takes URIs; projected Prompt.FileAttachment records carry bytes instead.
export const engineFiles = (files: AgentFile[]) => files.map(f => ({ name: f.name, uri: `data:${f.mime};base64,${f.data}`, source: f.source }));
// Returned names are optional and source may describe a file URI. Re-sending uses the returned bytes, never that path.
export function fromEngineFiles(value: unknown): AgentFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(f => typeof f?.mime === 'string' && typeof f?.data === 'string'
    ? [{ name: typeof f.name === 'string' && f.name.trim() ? f.name : 'Attached file', mime: f.mime.toLowerCase(), data: f.data, source: { type: 'inline' as const } }]
    : []);
}

// Only inline bytes are accepted from the dashboard, never a client-supplied URL or local file path.
export function agentFiles(value: unknown): AgentFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_FILES) throw new Error(`Attach up to ${MAX_AGENT_FILES} files per message.`);
  let total = 0;
  return value.map(f => {
    if (!f || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 255 || /[\x00-\x1f]/.test(f.name)) throw new Error('Each attachment needs a valid file name.');
    if (typeof f.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(f.mime)) throw new Error('Each attachment needs a valid file type.');
    if (typeof f.data !== 'string' || !f.data.length || f.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw new Error('An attachment contains invalid file data.');
    const bytes = Buffer.from(f.data, 'base64');
    if (bytes.toString('base64') !== f.data) throw new Error('An attachment contains invalid file data.');
    total += bytes.length;
    if (total > MAX_AGENT_FILE_BYTES) throw new Error('Attachments must total 10 MiB or less per message.');
    return { name: f.name, mime: f.mime.toLowerCase(), data: f.data, source: { type: 'inline' } };
  });
}
