import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpServer, ToolResult } from './mcp.js';
import { resolveProjectPath } from './project-path.js';

export const DEFAULT_RESPONSE_BYTES = 16 * 1024;
export const MAX_PAGE_BYTES = 64 * 1024;
interface Artifact {
  id: string; uri: string; filePath: string; mimeType: string; bytes: number;
}
const artifacts = new Map<string, Artifact & { signature: string }>();

function signature(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export async function storeArtifact(
  data: Buffer | string, filename: string, mimeType: string, requestedPath?: string,
): Promise<Artifact> {
  const id = randomUUID();
  const safeName = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
  const filePath = await resolveProjectPath(requestedPath ?? `.ascii-motion/artifacts/${id}-${safeName}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  const artifact = {
    id, uri: `ascii-motion://artifacts/${id}`, filePath, mimeType,
    bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
  };
  artifacts.set(id, { ...artifact, signature: signature(await fs.stat(filePath, { bigint: true })) });
  return artifact;
}

export function textResult(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export async function boundedResult(response: ToolResult, budget = DEFAULT_RESPONSE_BYTES): Promise<ToolResult> {
  const json = JSON.stringify(response);
  if (Buffer.byteLength(json) <= budget) return response;
  const artifact = await storeArtifact(json, 'tool-result.json', 'application/json');
  const body = response.structuredContent;
  const result = body && typeof body === 'object' && 'result' in body && typeof body.result === 'object' && body.result !== null
    ? body.result as Record<string, unknown> : undefined;
  const ids = result && typeof result.ids === 'object' && result.ids !== null
    ? Object.fromEntries(Object.entries(result.ids).filter(([key, value]) => key.length <= 64
      && (typeof value === 'string' && value.length <= 128
        || Array.isArray(value) && value.length <= 10
          && value.every(item => typeof item === 'string' && item.length <= 128))).slice(0, 10)) : undefined;
  const rawRevision = result?.revision ?? (body && typeof body === 'object' && 'revision' in body ? body.revision : undefined);
  const rawDocumentId = result?.documentId ?? (body && typeof body === 'object' && 'documentId' in body ? body.documentId : undefined);
  const summary = result ? {
    ids, revision: typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : undefined,
    documentId: typeof rawDocumentId === 'string' && rawDocumentId.length <= 128 ? rawDocumentId : undefined,
  } : undefined;
  const redirect = () => textResult({
    success: !response.isError,
    inline: false,
    reason: 'Full result saved because it exceeds the default response budget',
    artifact,
    ...(summary ? { summary } : {}),
    read: { tool: 'read_artifact', artifactId: artifact.id, offset: 0, length: 4096 },
  }, !!response.isError);
  if (Buffer.byteLength(JSON.stringify(redirect())) > budget && summary) summary.ids = undefined;
  const responsePage = redirect();
  if (Buffer.byteLength(JSON.stringify(responsePage)) > budget) throw new Error('Artifact descriptor exceeds the response budget');
  return responsePage;
}

async function readArtifact(
  id: string, offset: number, length: number, requestedEncoding: 'auto' | 'utf8' | 'base64',
): Promise<Record<string, unknown>> {
  const artifact = artifacts.get(id);
  if (!artifact) throw new Error('Artifact not found in this server session');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.bytes) throw new Error('Artifact offset out of range');
  if (!Number.isSafeInteger(length) || length < 1 || length > 8192) throw new Error('Artifact length must be 1..8192 bytes');
  const handle = await fs.open(await resolveProjectPath(artifact.filePath), 'r');
  try {
    const buffer = Buffer.alloc(Math.min(length, artifact.bytes - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (signature(await handle.stat({ bigint: true })) !== artifact.signature || bytesRead !== buffer.length) {
      throw new Error('Artifact file changed; create a new export or result before continuing');
    }
    const encoding = requestedEncoding === 'auto'
      ? (/^(text\/|application\/(json|javascript))/.test(artifact.mimeType) ? 'utf8' : 'base64') : requestedEncoding;
    if (encoding === 'utf8' && bytesRead && (buffer[0] & 0xc0) === 0x80) {
      throw new Error('UTF-8 offset must point to a character boundary; use the returned nextOffset');
    }
    const data = encoding === 'utf8' ? new StringDecoder('utf8').write(buffer.subarray(0, bytesRead))
      : buffer.subarray(0, bytesRead).toString('base64');
    const consumed = encoding === 'utf8' ? Buffer.byteLength(data) : bytesRead;
    if (encoding === 'utf8' && !Buffer.from(data).equals(buffer.subarray(0, consumed))) {
      throw new Error('Artifact bytes are not valid UTF-8; request base64 encoding');
    }
    if (!consumed && bytesRead) throw new Error('Page length is too short for the next UTF-8 character');
    const nextOffset = offset + consumed < artifact.bytes ? offset + consumed : null;
    return {
      artifactId: id, offset, bytes: consumed, totalBytes: artifact.bytes,
      encoding, data, nextOffset,
    };
  } finally {
    await handle.close();
  }
}

export function registerArtifactAccess(server: McpServer): void {
  server.tool('read_artifact', 'Read bounded artifact pages. Text defaults to UTF-8; binary uses base64. Continue at nextOffset.', {
    artifactId: z.string(),
    offset: z.number().int().min(0).default(0),
    length: z.number().int().min(1).max(8192).default(4096),
    encoding: z.enum(['auto', 'utf8', 'base64']).default('auto'),
  }, async ({ artifactId, offset, length, encoding }) => textResult(await readArtifact(artifactId, offset, length, encoding)));
  server.registerResource('artifact', new ResourceTemplate(
    'ascii-motion://artifacts/{artifactId}{?offset,length,encoding}', { list: undefined },
  ), { description: 'Bounded artifact byte pages; optional offset and length (max 8192).' },
  async (uri, variables) => {
    const id = variables.artifactId;
    if (typeof id !== 'string') throw new Error('Invalid artifact ID');
    const page = await readArtifact(id, Number(uri.searchParams.get('offset') ?? 0),
      Number(uri.searchParams.get('length') ?? 4096),
      z.enum(['auto', 'utf8', 'base64']).parse(uri.searchParams.get('encoding') ?? 'auto'));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(page) }] };
  });
}
