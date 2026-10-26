import { createHash } from 'node:crypto';

/** A deliberately narrow adapter to the existing authorized Workspace reader.
 * It never loads the general MCP tool catalog or exposes an arbitrary path. */
export async function readHelpKnowledge(
  url: string,
  subject: string,
  secret: string | undefined,
  id: string,
): Promise<{ version: string; url: string; content: string }> {
  if (!secret || !subject || !/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(id))
    throw new Error('KNOWLEDGE_UNAVAILABLE');
  async function read(path: string, maximum: number): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Garden-Workspace-Subject': subject,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'workspace_read',
          arguments: { scope: 'company', path, max_bytes: maximum },
        },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok || !response.body) throw new Error('KNOWLEDGE_UNAVAILABLE');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    // MCP may return both structured and JSON-string content, including base64.
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > maximum * 4 + 65536) {
        await reader.cancel();
        throw new Error('KNOWLEDGE_UNAVAILABLE');
      }
      parts.push(item.value);
    }
    const rpc = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const result =
      rpc.result?.structuredContent ??
      JSON.parse(
        rpc.result?.content?.find((p: { type: string }) => p.type === 'text')?.text ?? '{}',
      );
    if (
      result.ok !== true ||
      result.truncated !== false ||
      typeof result.content_base64 !== 'string'
    )
      throw new Error('KNOWLEDGE_UNAVAILABLE');
    const bytes = Buffer.from(result.content_base64, 'base64');
    if (bytes.length > maximum) throw new Error('KNOWLEDGE_UNAVAILABLE');
    return bytes.toString('utf8');
  }
  // Manifest and document must belong to one immutable version, even during activation.
  const raw = await read('Help/manifest.json', 32768);
  const manifest = JSON.parse(raw);
  if (!/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.documents))
    throw new Error('KNOWLEDGE_UNAVAILABLE');
  const entry = manifest.documents.find((document: { id: string }) => document.id === id);
  if (!entry || typeof entry.url !== 'string') throw new Error('KNOWLEDGE_UNAVAILABLE');
  const content = await read(`Help/${id}.md`, 131072);
  if (createHash('sha256').update(content).digest('hex') !== entry.sha256)
    throw new Error('KNOWLEDGE_UNAVAILABLE');
  return { version: manifest.version, url: entry.url, content };
}
