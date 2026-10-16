import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const entry = resolve(root, 'dist/index.js');
const artifacts = resolve(root, `.protocol-test-artifacts-${process.pid}`);
const packageVersion = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string;
}).version;
const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'raw-protocol-test', version: '1.0.0' },
};

const legacyNames = `
add_animated_text add_content_frame add_effect_block add_effect_keyframe add_frame
add_generator_layer add_keyframe add_layer apply_effect apply_to_selection bake_generator_layer
batch_recolor batch_replace_char clear_canvas clear_cell clear_selection compare_frames
copy_frame_and_modify copy_region_to_frame create_group delete_frame delete_selection_content
describe_animation duplicate_frame duplicate_layer export_ansi export_bubbletea export_html
export_image export_ink export_json export_opentui export_react export_session export_text
export_video fill_region flip_region get_active_colors get_auth_token get_canvas_ascii
get_canvas_preview get_canvas_render get_canvas_summary get_cell get_character_palette
get_color_palette get_color_stats get_connection_status get_effect_blocks get_frame_diff
get_generator_layers get_history_status get_layer_properties get_layers get_project_info
get_selection go_to_frame import_ascii_text import_image import_video interpolate_frames
list_character_palettes list_color_palettes list_frames list_generator_types list_project_files
load_project new_project paste_ascii_block preview_generator randomize_generator_seed redo
refresh_state_from_browser remove_content_frame remove_effect_block remove_effect_keyframe
remove_generator_keyframes remove_keyframe remove_layer rename_layer render_generator_frames
reorder_layers reset_generator resize_canvas run_generator save_project select_by_color
select_rectangle set_active_layer set_background_color set_cell set_cells_batch
set_foreground_color set_frame_duration set_frame_name set_frame_rate set_generator_keyframes
set_generator_property set_layer_visibility set_project_name set_selected_character
set_timeline_duration shift_frame_content suggest_palette_for_style undo ungroup_layers
update_effect_block update_generator_layer
`.trim().split(/\s+/);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

function assertLegacySchemas(tools: Array<{ name: string; inputSchema: unknown }>) {
  const original = tools.filter(({ name }) => legacyNames.includes(name))
    .map(({ name, inputSchema }) => ({ name, inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(original.map(({ name }) => name)).toEqual(legacyNames);
  // Pagination, easing, app enums and modern export options intentionally repair nine schemas.
  const extendedSchemas = ['get_canvas_preview', 'get_frame_diff', 'set_generator_keyframes', 'add_keyframe', 'compare_frames', 'add_effect_block', 'set_frame_rate', 'export_opentui', 'export_bubbletea'];
  const unchanged = original.filter(({ name }) => !extendedSchemas.includes(name));
  // Digest of the other 100 audited v1 schemas, including descriptions/defaults.
  expect(createHash('sha256').update(JSON.stringify(canonical(unchanged))).digest('hex'))
    .toBe('68c648957e5b39a0bf89cc77cf4b66fd586aefe96703c1acea6b4133100be3c9');
}

interface Reply {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const sessions = new Set<RawSession>();
class RawSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  stderr = '';
  invalidStdout: string[] = [];
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(args: string[] = [], binaryEntry = entry) {
    sessions.add(this);
    this.child = spawn(process.execPath, [binaryEntry, ...args], { cwd: root });
    this.child.stderr.on('data', (data: Buffer) => { this.stderr += data.toString(); });
    this.exited = new Promise((done) => {
      this.child.once('close', (code) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Server exited (${code}): ${this.stderr}`));
        }
        this.pending.clear();
        done(code);
      });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        this.invalidStdout.push(line);
        return;
      }
      const pending = this.pending.get(reply.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(reply.id);
        pending.resolve(reply);
      }
    });
  }

  async request(method: string, params: Record<string, unknown> = {}, modern = false) {
    const id = this.nextId++;
    const reply = new Promise<Reply>((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}: ${this.stderr}`));
      }, 8000);
      this.pending.set(id, { resolve: done, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: modern ? { ...params, _meta: modernMeta } : params,
    })}\n`);
    const response = await reply;
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result!;
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async finish(signal?: NodeJS.Signals) {
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    const code = await Promise.race([
      this.exited,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server did not exit: ${this.stderr}`)), 4000);
        this.exited.finally(() => clearTimeout(timer));
      }),
    ]);
    expect(this.invalidStdout).toEqual([]);
    return code;
  }
}

async function initialize(session: RawSession) {
  const initialized = await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-legacy-test', version: '1.0.0' },
  });
  session.notify('notifications/initialized');
  expect(initialized).toMatchObject({
    protocolVersion: '2025-11-25',
    serverInfo: { name: 'ascii-motion-mcp', version: packageVersion },
  });
}

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((done, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', done);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  return address.port;
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
}, 120_000);

afterEach(async () => {
  for (const session of sessions) {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill('SIGKILL');
    }
    await session.exited;
  }
  sessions.clear();
});

afterAll(() => { rmSync(artifacts, { recursive: true, force: true }); });

describe('real dual-era stdio entrypoint', () => {
  for (const modern of [false, true]) {
    it(`supports raw ${modern ? '2026 discovery' : '2025 initialize'}, schemas, calls, reads, prompts and EOF`, async () => {
      const session = new RawSession();
      if (modern) {
        expect(await session.request('server/discover', {}, true)).toMatchObject({
          supportedVersions: ['2026-07-28'],
          resultType: 'complete',
          capabilities: { tools: {}, resources: {}, prompts: {} },
        });
      } else {
        await initialize(session);
      }
      const listed = await session.request('tools/list', {}, modern);
      assertLegacySchemas(listed.tools as Array<{ name: string; inputSchema: unknown }>);
      const called = await session.request('tools/call', {
        name: 'get_project_info', arguments: {},
      }, modern);
      expect(called.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
      expect(called.isError).not.toBe(true);
      const invalid = await session.request('tools/call', {
        name: 'set_cell', arguments: { x: 'not-a-number', y: 0 },
      }, modern);
      expect(invalid.isError).toBe(true);
      const listedResources = await session.request('resources/list', {}, modern);
      expect((listedResources.resources as unknown[]).length).toBeGreaterThanOrEqual(9);
      expect(await session.request('resources/read', { uri: 'project://state' }, modern))
        .toMatchObject({ contents: [{ uri: 'project://state', mimeType: 'application/json' }] });
      const listedPrompts = await session.request('prompts/list', {}, modern);
      expect((listedPrompts.prompts as unknown[]).length).toBeGreaterThanOrEqual(7);
      expect(await session.request('prompts/get', {
        name: 'create-animation', arguments: { subject: 'test' },
      }, modern)).toMatchObject({ messages: [{ role: 'user', content: { type: 'text' } }] });
      // Cancellation notifications must not break subsequent dispatch.
      session.notify('notifications/cancelled', {
        requestId: 99999, reason: 'No longer needed',
        ...(modern ? { _meta: modernMeta } : {}),
      });
      expect((await session.request('tools/list', {}, modern)).tools).toBeDefined();
      expect(await session.finish()).toBe(0);
    }, 20_000);
  }

  for (const mode of ['legacy', 'auto', { pin: '2026-07-28' }] as const) {
    it(`supports an SDK client (${typeof mode === 'string' ? mode : 'modern pin'})`, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [entry], cwd: root, stderr: 'pipe',
      });
      const client = new Client({ name: 'sdk-test', version: '1' }, {
        versionNegotiation: { mode },
      });
      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe(mode === 'legacy' ? 'legacy' : 'modern');
        assertLegacySchemas((await client.listTools()).tools);
        expect(await client.callTool({ name: 'get_project_info', arguments: {} }))
          .toMatchObject({ content: [{ type: 'text' }] });
        expect((await client.readResource({ uri: 'project://state' })).contents).toHaveLength(1);
        expect((await client.listPrompts()).prompts.length).toBeGreaterThanOrEqual(7);
      } finally {
        await client.close();
      }
    }, 20_000);
  }

  it('does not bind a browser port for repeated discovery or SDK probe processes', async () => {
    const port = await availablePort();
    const active = new RawSession(['--live', '--port', String(port)]);
    await initialize(active);
    const discoveryOnly = new RawSession(['--live', '--port', String(port)]);
    for (let i = 0; i < 3; i++) {
      expect(await discoveryOnly.request('server/discover', {}, true))
        .toMatchObject({ supportedVersions: ['2026-07-28'] });
    }
    expect(await discoveryOnly.finish()).toBe(0);
    expect(discoveryOnly.stderr).not.toContain('Live mode enabled');
    expect(await active.request('ping')).toBeDefined();
    expect(await active.finish()).toBe(0);

    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry, '--live', '--port', String(port)], stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    const client = new Client({ name: 'live-auto-test', version: '1' }, {
      versionNegotiation: { mode: 'auto' },
    });
    try {
      await client.connect(transport);
      await client.listTools();
      expect(stderr.match(/Live mode enabled/g)).toHaveLength(1);
      expect(stderr).not.toContain('EADDRINUSE');
    } finally {
      await client.close();
    }
  }, 20_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`closes a live bridge on ${signal} and allows port reuse`, async () => {
      const port = await availablePort();
      const first = new RawSession(['--live', '--port', String(port)]);
      await initialize(first);
      expect(await first.finish(signal)).toBe(0);
      const second = new RawSession(['--live', '--port', String(port)]);
      await initialize(second);
      expect(await second.finish()).toBe(0);
    });
  }

  it('fails cleanly on an occupied live port without protocol stdout noise', async () => {
    const port = await availablePort();
    const first = new RawSession(['--live', '--port', String(port)]);
    await initialize(first);
    const second = new RawSession(['--live', '--port', String(port)]);
    const request = second.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'conflict', version: '1' },
    });
    await expect(request).rejects.toThrow();
    expect(await second.exited).toBe(1);
    expect(second.stderr).toMatch(/EADDRINUSE|address already in use/);
    expect(second.invalidStdout).toEqual([]);
    expect(await first.finish()).toBe(0);
  });

  it('validates CLI values and respects environment defaults with CLI precedence', async () => {
    for (const args of [
      ['--port', 'nope'], ['--port', '0'], ['--port', '65536'], ['--port', '42junk'],
      ['--port'], ['--project-dir'], ['--project-dir', 'package.json'], ['--unknown'],
    ]) {
      const session = new RawSession(args);
      expect(await session.exited).toBe(1);
      expect(session.invalidStdout).toEqual([]);
    }
    const env = { ...process.env, ASCII_MOTION_PROJECT_DIR: resolve(root, 'src') };
    const launch = (args: string[]) => execFileSync(process.execPath, [entry, ...args], {
      cwd: root, env, input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(launch(['--version'])).toBe(`ascii-motion-mcp v${packageVersion}\n`);
    const byEnv = spawn(process.execPath, [entry], { cwd: root, env });
    let stderr = '';
    byEnv.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    byEnv.stdin.end();
    await new Promise<void>((done) => byEnv.once('close', () => done()));
    expect(stderr).toContain(`Project directory: ${resolve(root, 'src')}`);
    const overridden = spawn(process.execPath, [entry, '--project-dir', root], { cwd: root, env });
    let overriddenStderr = '';
    overridden.stderr.on('data', (data: Buffer) => { overriddenStderr += data.toString(); });
    overridden.stdin.end();
    await new Promise<void>((done) => overridden.once('close', () => done()));
    expect(overriddenStderr).toContain(`Project directory: ${root}\n`);
  }, 20_000);

  it('ships a runnable packed entrypoint with package-derived version and modern discovery', async () => {
    mkdirSync(artifacts, { recursive: true });
    const output = execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', artifacts,
    ], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const [{ filename }] = JSON.parse(output) as Array<{ filename: string }>;
    execFileSync('tar', ['-xzf', resolve(artifacts, filename), '-C', artifacts]);
    const packedEntry = resolve(artifacts, 'package/dist/index.js');
    expect(execFileSync(process.execPath, [packedEntry, '--version'], { encoding: 'utf8' }))
      .toBe(`ascii-motion-mcp v${packageVersion}\n`);
    const packed = new RawSession(['--project-dir', root], packedEntry);
    expect(await packed.request('server/discover', {}, true))
      .toMatchObject({ supportedVersions: ['2026-07-28'] });
    expect((await packed.request('tools/list', {}, true)).tools).toBeDefined();
    expect(await packed.finish()).toBe(0);
  }, 30_000);
});
