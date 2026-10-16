import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { McpServer } from './mcp.js';
import { boundedResult, DEFAULT_RESPONSE_BYTES, MAX_PAGE_BYTES, registerArtifactAccess, storeArtifact, textResult } from './artifacts.js';

describe('bounded results and artifact access', () => {
  let directory: string;
  let previousDirectory: string | undefined;
  let server: McpServer;
  let client: Client;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ascii-motion-artifacts-'));
    previousDirectory = process.env.ASCII_MOTION_PROJECT_DIR;
    process.env.ASCII_MOTION_PROJECT_DIR = directory;
    server = new McpServer({ name: 'artifacts-test', version: '1' });
    registerArtifactAccess(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'artifacts-test', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    if (previousDirectory === undefined) delete process.env.ASCII_MOTION_PROJECT_DIR;
    else process.env.ASCII_MOTION_PROJECT_DIR = previousDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function page(id: string, offset: number, length: number, encoding = 'auto') {
    const result = await client.callTool({ name: 'read_artifact', arguments: { artifactId: id, offset, length, encoding } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const body = z.object({
      data: z.string(), bytes: z.number(), nextOffset: z.number().nullable(), encoding: z.string(),
    }).parse(result.structuredContent);
    expect(result.isError).not.toBe(true);
    return body;
  }

  it('budgets the entire serialized reply and preserves the complete result and useful IDs', async () => {
    const original = textResult({
      success: true, result: { ids: { layerId: 'created' }, revision: 12, documentId: 'document', text: 'X'.repeat(9000) },
    });
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(DEFAULT_RESPONSE_BYTES);
    const bounded = await boundedResult(original);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTES);
    const body = z.object({
      summary: z.object({ ids: z.object({ layerId: z.string() }), revision: z.number(), documentId: z.string() }),
      artifact: z.object({ filePath: z.string(), id: z.string() }),
    }).parse(bounded.structuredContent);
    expect(body.summary).toEqual({ ids: { layerId: 'created' }, revision: 12, documentId: 'document' });
    expect(JSON.parse(await fs.readFile(body.artifact.filePath, 'utf8'))).toEqual(original);
  });

  it('recovers a full Unicode text across exact continuation boundaries', async () => {
    const text = 'A\u{1f600}\u00e9Z'.repeat(200);
    const artifact = await storeArtifact(text, 'unicode.txt', 'text/plain');
    let offset = 0;
    let recovered = '';
    do {
      const result = await page(artifact.id, offset, 11);
      recovered += result.data;
      expect(Buffer.byteLength(result.data)).toBe(result.bytes);
      if (result.nextOffset === null) break;
      expect(result.nextOffset).toBe(offset + result.bytes);
      offset = result.nextOffset;
    } while (offset < artifact.bytes);
    expect(recovered).toBe(text);
    const invalid = await client.callTool({
      name: 'read_artifact', arguments: { artifactId: artifact.id, offset: 2, length: 10 },
    });
    expect(invalid.isError).toBe(true);
  });

  it('round trips binary bytes through base64 pages and a resource-template query', async () => {
    const bytes = Buffer.from(Array.from({ length: 9000 }, (_, index) => index % 256));
    const artifact = await storeArtifact(bytes, 'image.bin', 'application/octet-stream');
    const first = await page(artifact.id, 0, 8192);
    const second = await page(artifact.id, first.nextOffset!, 8192);
    expect(first.encoding).toBe('base64');
    expect(second.nextOffset).toBeNull();
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')])).toEqual(bytes);
    const resource = await client.readResource({ uri: `${artifact.uri}?offset=8190&length=4&encoding=base64` });
    const content = z.object({ text: z.string() }).parse(resource.contents[0]);
    expect(JSON.parse(content.text)).toMatchObject({ offset: 8190, data: bytes.subarray(8190, 8194).toString('base64') });
  });

  it('rejects missing handles, invalid ranges and invalid UTF-8 without inventing data', async () => {
    const artifact = await storeArtifact(Buffer.from([255]), 'bad.txt', 'text/plain');
    for (const arguments_ of [
      { artifactId: 'not-found' }, { artifactId: artifact.id, offset: 2 },
      { artifactId: artifact.id, length: 8193 }, { artifactId: artifact.id, encoding: 'utf8' },
    ]) expect((await client.callTool({ name: 'read_artifact', arguments: arguments_ })).isError).toBe(true);
    expect((await page(artifact.id, 0, 1, 'base64')).data).toBe('/w==');
  });

  it('rejects replaced/truncated artifact files instead of returning a stuck cursor', async () => {
    const artifact = await storeArtifact('original', 'document.txt', 'text/plain');
    await fs.writeFile(artifact.filePath, '');
    const result = await client.callTool({ name: 'read_artifact', arguments: { artifactId: artifact.id } });
    expect(result.isError).toBe(true);
  });
});
