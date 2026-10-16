import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { bridgeContract, operationNamed, validateOperation, validateBridgeMessage } from './contract.js';
import { boundedResult, storeArtifact, textResult, MAX_PAGE_BYTES } from './artifacts.js';
import { setToolExecutionMiddleware, setToolMetadataProvider, type ToolResult } from './mcp.js';
import { getProjectManager, ProjectStateManager, withLocalProject } from './state.js';
import { resolveProjectPath } from './project-path.js';
import { BrowserOperationError, type WebSocketServerTransport } from './transport/websocket.js';
import { EMPTY_CELL, parseCellKey, type CanvasData } from './types.js';
import { contentPatch } from './content-patch.js';
import { differencePage } from './cell-diff.js';
import { getCanvasRender, MAX_CANVAS_RENDER_FRAMES } from './tools/preview.js';
import { PROJECT_TEMPLATES } from './tools/project.js';
import { legacyToolMetadata } from './tool-metadata.js';

const CellOutSchema = z.object({
  x: z.number().int(), y: z.number().int(), char: z.string(), color: z.string(), bgColor: z.string(),
});

let transport: WebSocketServerTransport | undefined;
let toolQueue: Promise<void> = Promise.resolve();
const generatedToolNames = new Set<string>();
const toolContext = new AsyncLocalStorage<{
  readRevision?: number; readDocumentId?: string; lastRevision?: number; lastDocumentId?: string;
  signal?: AbortSignal;
}>();

export function configureBrowserBridge(browser: WebSocketServerTransport | undefined): void {
  transport = browser;
  browser?.setMessageValidator(validateBridgeMessage);
}

export function isBrowserBridgeConfigured(): boolean { return transport !== undefined; }

export function markGeneratedTool(name: string): void { generatedToolNames.add(name); }

export async function executeBridgeOperation(
  name: string, input: Record<string, unknown>, expectedRevision?: number,
): Promise<Record<string, unknown>> {
  const operation = operationNamed(name);
  if (toolContext.getStore()?.signal?.aborted) throw new BrowserOperationError('BUSY', 'Tool request cancelled before dispatch');
  if (!operation) throw new BrowserOperationError('UNKNOWN_OPERATION', `Unknown operation: ${name}`);
  try {
    validateOperation(name, 'input', input);
  } catch (error) {
    throw new BrowserOperationError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
  if (!transport) return executeHeadlessOperation(name);
  const hello = transport.browserHello;
  if (!hello) {
    throw new BrowserOperationError('UNSUPPORTED',
      'Connect an ASCII Motion app with bridge v3 support. Legacy apps cannot safely apply this tool.');
  }
  if (hello.contractHash !== bridgeContract.contractHash) {
    throw new BrowserOperationError('UNSUPPORTED',
      'The app and MCP bridge contracts differ. Use matching builds before reading or editing this document.',
      { appContractHash: hello.contractHash, mcpContractHash: bridgeContract.contractHash });
  }
  if (!hello.capabilities.operations?.includes(name)) {
    throw new BrowserOperationError('UNSUPPORTED', `The connected app does not support "${name}". Update the app.`);
  }
  const context = toolContext.getStore();
  if (context?.readDocumentId && context.readDocumentId !== hello.document.documentId) {
    throw new BrowserOperationError('CONFLICT', 'The connected document changed after this tool read it; retry against the current document.');
  }
  const acknowledged = await transport.requestBrowserCommand(
    { type: name, ...input }, operation.kind === 'io' ? 120_000 : 15_000,
    result => {
      try {
        validateOperation(name, 'result', result.applied);
      } catch (error) {
        throw new BrowserOperationError('INTERNAL',
          `Incompatible response after "${name}". Refresh before retrying any mutation.`,
          { acknowledgedOperation: name, browserApplied: true, cause: error instanceof Error ? error.message : String(error) });
      }
      if (!Number.isInteger(result.revision) || typeof result.documentId !== 'string') {
        throw new BrowserOperationError('INTERNAL', 'Incomplete v3 acknowledgement; refresh before retrying',
          { acknowledgedOperation: name, browserApplied: true });
      }
      if (result.applied?.revision !== undefined && result.applied.revision !== result.revision
        || result.applied?.documentId !== undefined && result.applied.documentId !== result.documentId) {
        throw new BrowserOperationError('INTERNAL', 'Acknowledgement identity/revision mismatch; refresh before retrying',
          { acknowledgedOperation: name, browserApplied: true });
      }
    }, undefined, expectedRevision ?? toolContext.getStore()?.readRevision
      ?? (operation.kind === 'mutation' ? 'current' : undefined), 3, context?.signal,
  );
  if (context && operation.kind === 'read' && context.readRevision === undefined) {
    context.readRevision = acknowledged.revision;
    context.readDocumentId = acknowledged.documentId;
  }
  if (context) {
    context.lastRevision = acknowledged.revision;
    context.lastDocumentId = acknowledged.documentId;
  }
  const applied = z.record(z.string(), z.unknown()).parse(acknowledged.applied);
  if (name === 'get_document') {
    getProjectManager().loadFromBrowserSnapshot({
      document: applied.document, revision: applied.revision, documentId: applied.documentId,
    });
  }
  return applied;
}

function executeHeadlessOperation(name: string): Record<string, unknown> {
  const pm = getProjectManager();
  if (name === 'get_document') {
    return { document: pm.toNativeSessionData(), documentId: 'headless', revision: 0 };
  }
  if (name === 'get_capabilities') {
    return { capabilities: {
      mode: 'headless', protocolVersion: 3, contractVersion: bridgeContract.contractVersion,
      contractHash: bridgeContract.contractHash,
      browserRequired: bridgeContract.operations.filter(op => !['get_document', 'get_capabilities'].includes(op.name)).map(op => op.name),
      limitations: ['No compositing, procedural rendering, shaders, browser media conversion or cloud authentication'],
    } };
  }
  throw new BrowserOperationError('UNSUPPORTED', `"${name}" requires a connected ASCII Motion app. Start with --live.`);
}

export function bridgeFailure(error: unknown): ToolResult {
  return textResult({
    success: false,
    error: {
      code: error instanceof BrowserOperationError ? error.code : 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof BrowserOperationError && error.details !== undefined ? { details: error.details } : {}),
    },
  }, true);
}

const BrowserArtifactSchema = z.object({
  filename: z.string(), mimeType: z.string(), bytes: z.number().int().min(0),
  encoding: z.enum(['base64', 'utf8']), data: z.string(),
});

export async function operationToolResult(
  name: string, input: Record<string, unknown>, filePath?: string, expectedRevision?: number,
  checkResult?: (result: Record<string, unknown>) => void,
): Promise<ToolResult> {
  const result = await executeBridgeOperation(name, input, expectedRevision);
  checkResult?.(result);
  const revision = toolContext.getStore()?.lastRevision ?? result.revision;
  const documentId = toolContext.getStore()?.lastDocumentId ?? result.documentId;
  if (result.artifact) {
    const artifact = BrowserArtifactSchema.parse(result.artifact);
    const bytes = Buffer.from(artifact.data, artifact.encoding === 'base64' ? 'base64' : 'utf8');
    if (artifact.encoding === 'base64' && bytes.toString('base64') !== artifact.data) {
      throw new Error('Browser returned invalid base64 artifact data');
    }
    if (bytes.length !== artifact.bytes) throw new Error('Browser artifact byte count does not match its payload');
    const saved = await storeArtifact(bytes, artifact.filename, artifact.mimeType, filePath);
    return textResult({ success: true, operation: name, revision, documentId, inline: false, artifact: saved, summary: result.result });
  }
  return boundedResult(textResult({ success: true, operation: name, revision, documentId, result }));
}

function pick(args: Readonly<Record<string, unknown>>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}

function target(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return args.frameIndex === undefined ? {} : { target: { frame: args.frameIndex } };
}

function readTarget(result: Record<string, unknown>): Record<string, unknown> {
  return {
    frame: result.frame, layerId: result.layerId,
    ...(typeof result.contentFrameId === 'string' ? { contentFrameId: result.contentFrameId } : {}),
  };
}

async function legacyExportTool(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  const suffix = name.slice('export_'.length);
  const extension = typeof args.filePath === 'string' ? path.extname(args.filePath).toLowerCase() : '';
  const format = suffix === 'image'
    ? String(args.format ?? (extension === '.jpg' || extension === '.jpeg' ? 'jpg' : extension === '.svg' ? 'svg' : 'png'))
    : suffix === 'video' ? String(args.format ?? (extension === '.webm' ? 'webm' : 'mp4')) : suffix;
  let settings: Record<string, unknown>;
  let componentName: string | undefined;
  const singleFrame = async () => {
    const frame = args.frameIndex ?? z.object({ timeline: z.object({ currentFrame: z.number().int() }) })
      .parse(await executeBridgeOperation('get_document_summary', {})).timeline.currentFrame;
    return { start: frame, end: frame };
  };
  switch (suffix) {
    case 'image':
      settings = pick(args, 'sizeMultiplier', 'includeGrid');
      settings.frame = args.frameIndex ?? 'current';
      if (format === 'jpg') settings.quality = args.quality;
      if (format === 'svg') {
        if (args.sizeMultiplier !== undefined && args.sizeMultiplier !== 1) {
          throw new BrowserOperationError('UNSUPPORTED', 'SVG uses vector dimensions; sizeMultiplier is supported only for raster images.');
        }
        delete settings.sizeMultiplier;
      }
      break;
    case 'video':
      settings = pick(args, 'sizeMultiplier', 'frameRate', 'includeGrid', 'loops', 'frameRange');
      if (format === 'webm') settings.quality = args.quality;
      else settings.crf = args.quality === 'high' ? 18 : args.quality === 'low' ? 32 : 24;
      break;
    case 'text':
      settings = {
        ...pick(args, 'includeMetadata'),
        frameRange: args.allFrames ? 'all' : await singleFrame(),
        removeLeadingSpaces: args.trimEmpty, removeTrailingSpaces: args.trimEmpty,
        removeLeadingLines: args.trimEmpty, removeTrailingLines: args.trimEmpty,
      };
      break;
    case 'json':
      if (args.includeEmptyCells) {
        throw new BrowserOperationError('UNSUPPORTED', 'The app JSON exporter is sparse. Use read_cells for an explicit rectangular grid.');
      }
      settings = pick(args, 'includeMetadata', 'humanReadable');
      break;
    case 'ansi':
      settings = { ...pick(args, 'colorMode'), outputMode: 'single-frame', frameRange: await singleFrame() };
      break;
    case 'html':
      if (args.includeControls === false || args.loops !== undefined && args.loops !== 'infinite') {
        throw new BrowserOperationError('UNSUPPORTED', 'The app HTML exporter always includes controls and loops indefinitely.');
      }
      settings = pick(args, 'backgroundColor', 'fontFamily', 'fontSize', 'animationSpeed');
      break;
    case 'react':
    case 'ink':
    case 'opentui':
      if (args.className !== undefined) {
        throw new BrowserOperationError('UNSUPPORTED',
          'OpenTUI exports TypeScript, not Python. Remove className and use componentName with a .tsx output path.');
      }
      componentName = z.string().parse(args.componentName);
      if (!/^[A-Z][A-Za-z0-9]*$/.test(componentName)) {
        throw new BrowserOperationError('UNSUPPORTED', 'Component names must be PascalCase alphanumeric identifiers for the app exporter.');
      }
      settings = { ...pick(args, 'typescript', 'includeControls'), fileName: componentName.replace(/[A-Z]/g, '-$&').slice(1) };
      if (suffix !== 'react') settings.frameRange = args.includeAnimation ? 'all' : await singleFrame();
      break;
    case 'bubbletea':
      if (args.modelName !== 'Model') {
        throw new BrowserOperationError('UNSUPPORTED', 'The app Bubble Tea exporter uses modelName "Model". Set modelName to "Model".');
      }
      if (typeof args.packageName !== 'string' || !/^[a-z][a-z0-9]*$/.test(args.packageName)) {
        throw new BrowserOperationError('UNSUPPORTED', 'The app Bubble Tea exporter requires a lowercase alphanumeric packageName.');
      }
      settings = { packageName: args.packageName, frameRange: args.includeAnimation ? 'all' : await singleFrame() };
      break;
    default:
      throw new BrowserOperationError('UNSUPPORTED', `No verified export adapter for "${name}". Use the canonical export tool.`);
  }
  return operationToolResult('export', {
    format, settings,
    ...(typeof args.filePath === 'string' ? { filename: path.basename(args.filePath) } : {}),
  }, typeof args.filePath === 'string' ? args.filePath : undefined, undefined, result => {
    const metadata = z.record(z.unknown()).parse(result.result);
    if (componentName !== undefined && metadata.componentName !== componentName) {
      throw new BrowserOperationError('INTERNAL', 'The app exporter changed the requested component name; no output file was saved.',
        { requested: componentName, actual: metadata.componentName });
    }
  });
}

async function documentForTarget(): Promise<ReturnType<typeof getProjectManager>> {
  await executeBridgeOperation('get_document', {});
  return getProjectManager();
}

async function readCellFrame(frame?: unknown, region?: unknown, scope = 'composite') {
  let normalizedRegion: Record<string, number> | undefined;
  if (region !== undefined) {
    const requested = z.object({
      x: z.number().int().default(0), y: z.number().int().default(0),
      width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
    }).parse(region);
    if (requested.width !== undefined && requested.height !== undefined) normalizedRegion = { ...requested, width: requested.width, height: requested.height };
    else {
      const summary = await executeBridgeOperation('get_document_summary', {});
      const canvas = z.object({ width: z.number(), height: z.number() }).parse(summary.canvas);
      normalizedRegion = { ...requested, width: requested.width ?? canvas.width - requested.x, height: requested.height ?? canvas.height - requested.y };
    }
  }
  const result = await executeBridgeOperation('read_cells', {
    frame, region: normalizedRegion, scope, format: 'cells',
  });
  const cells = z.array(CellOutSchema).parse(result.cells);
  const data: CanvasData = Object.fromEntries(cells.map(({ x, y, ...cell }) => [`${x},${y}`, cell]));
  return { result, cells, data };
}

async function liveCanvasRender(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  const summary = await executeBridgeOperation('get_document_summary', {});
  const canvas = z.object({ width: z.number(), height: z.number(), backgroundColor: z.string() }).parse(summary.canvas);
  const timeline = z.object({ frameRate: z.number(), durationFrames: z.number(), currentFrame: z.number() }).parse(summary.timeline);
  if (args.allFrames && timeline.durationFrames > MAX_CANVAS_RENDER_FRAMES) {
    throw new BrowserOperationError('LIMIT_REACHED', `Use a single frame or export; ANSI previews are limited to ${MAX_CANVAS_RENDER_FRAMES} timeline frames.`);
  }
  const input = z.object({
    frameIndex: z.number().int().optional(), allFrames: z.boolean().optional(),
    colorMode: z.enum(['16', '256', 'truecolor']).optional(),
    maxWidth: z.number().optional(), trimEmpty: z.boolean().optional(),
  }).parse(args);
  const indices = args.allFrames ? Array.from({ length: timeline.durationFrames }, (_, i) => i)
    : [input.frameIndex ?? timeline.currentFrame];
  const frames = new Map<number, { id: string; name: string; duration: number; data: CanvasData }>();
  const revision = transport?.browserHello?.document.revision;
  for (const index of indices) {
    const { data } = await readCellFrame(index);
    frames.set(index, { id: `sample-${index}`, name: `Timeline Frame ${index + 1}`, duration: 1000 / timeline.frameRate, data });
  }
  if (transport?.browserHello?.document.revision !== revision) throw new BrowserOperationError('CONFLICT', 'Document changed during preview; retry.');
  return getCanvasRender(input, {
    ensureFreshState: async () => undefined,
    getState: () => ({ ...canvas, frames: [], currentFrameIndex: timeline.currentFrame }),
    getFrameCount: () => timeline.durationFrames,
    getFrameAtTime: frame => {
      const sample = frames.get(frame);
      if (!sample) throw new Error(`Frame ${frame} was not sampled`);
      return sample;
    },
  });
}

async function legacyLiveTool(name: string, a: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  const run = operationToolResult;
  switch (name) {
    case 'new_project': {
      const preset = Object.entries(PROJECT_TEMPLATES).find(([name]) => name === a.template)?.[1];
      if (a.template && !preset) throw new BrowserOperationError('INVALID_INPUT', `Unknown template: ${a.template}`);
      return run(name, { ...pick(a, 'width', 'height', 'name'), ...preset });
    }
    case 'load_project': {
      const filename = await resolveProjectPath(z.string().parse(a.filePath));
      return run(name, { session: JSON.parse(await fs.readFile(filename, 'utf8')) });
    }
    case 'save_project':
    case 'export_session': {
      const document = await executeBridgeOperation('get_document', {});
      let filename = z.string().parse(a.filePath);
      if (!filename.endsWith('.asciimtn')) filename += '.asciimtn';
      const saved = await storeArtifact(JSON.stringify(document.document, null, 2),
        path.basename(filename), 'application/json', filename);
      getProjectManager().setFilePath(saved.filePath);
      getProjectManager().markClean();
      return textResult({ success: true, filePath: saved.filePath, artifact: saved });
    }
    case 'set_project_name': return run('set_project_metadata', { name: a.name });
    case 'create_group': {
      if (!Array.isArray(a.layerIds) || new Set(a.layerIds).size < 2) {
        throw new BrowserOperationError('UNSUPPORTED', 'The app requires two distinct, ungrouped layerIds; empty groups are not supported.');
      }
      return run(name, { ...a });
    }
    case 'get_project_info':
    case 'get_layers':
    case 'list_frames':
    case 'describe_animation': return run('get_document_summary', {});
    case 'get_history_status': return run('get_history', {});
    case 'refresh_state_from_browser': return run('get_document_summary', {});
    case 'get_canvas_render': return liveCanvasRender(a);
    case 'get_canvas_summary': {
      const { result, cells } = await readCellFrame(a.frameIndex);
      const region = z.object({ width: z.number(), height: z.number() }).parse(result.region);
      const characters = new Map<string, number>();
      for (const cell of cells) characters.set(cell.char, (characters.get(cell.char) ?? 0) + 1);
      return textResult({
        ...region, frame: result.frame, scope: 'composite', cellCount: result.cellCount, isEmpty: cells.length === 0,
        boundingBox: cells.length ? {
          minX: Math.min(...cells.map(cell => cell.x)), maxX: Math.max(...cells.map(cell => cell.x)),
          minY: Math.min(...cells.map(cell => cell.y)), maxY: Math.max(...cells.map(cell => cell.y)),
        } : null,
        topCharacters: [...characters].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([char, count]) => ({ char, count })),
      });
    }
    case 'get_canvas_preview': {
      const { result, cells } = await readCellFrame(a.frameIndex, a.region);
      const offset = z.number().int().min(0).parse(a.offset ?? 0);
      const limit = z.number().int().min(1).max(500).parse(a.maxCells ?? 50);
      const page = cells.sort((a, b) => a.y - b.y || a.x - b.x).slice(offset, offset + limit);
      const nextOffset = offset + page.length < cells.length ? offset + page.length : null;
      return textResult({
        frame: result.frame, region: result.region, scope: 'composite', totalCells: result.cellCount,
        cellCount: page.length, cells: page, nextOffset, truncated: nextOffset !== null,
      });
    }
    case 'get_frame_diff':
    case 'compare_frames': {
      const first = await readCellFrame(a.frameA);
      const revision = transport?.browserHello?.document.revision;
      const second = await readCellFrame(a.frameB);
      if (transport?.browserHello?.document.revision !== revision) throw new BrowserOperationError('CONFLICT', 'Document changed during comparison; retry.');
      return textResult({
        frameA: a.frameA, frameB: a.frameB, scope: 'composite',
        ...differencePage(first.data, second.data,
          z.number().int().min(0).parse(a.offset ?? 0),
          z.number().int().min(1).max(500).parse(a.maxCells ?? 50), a.showUnchanged === true),
      });
    }
    case 'get_cell': {
      const result = await executeBridgeOperation('read_cells', {
        scope: 'composite', format: 'cells', frame: a.frameIndex,
        region: { x: a.x, y: a.y, width: 1, height: 1 },
      });
      const cells = z.array(z.object({ char: z.string(), color: z.string(), bgColor: z.string() })).parse(result.cells);
      return textResult({ x: a.x, y: a.y, cell: cells[0] ?? EMPTY_CELL, frame: result.frame });
    }
    case 'get_canvas_ascii': {
      const { result, cells, data } = await readCellFrame(a.frameIndex, a.region);
      const region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).parse(result.region);
      let bounds = region;
      if (!a.region && a.trimEmpty && cells.length) {
        const x = Math.min(...cells.map(cell => cell.x));
        const y = Math.min(...cells.map(cell => cell.y));
        bounds = { x, y, width: Math.max(...cells.map(cell => cell.x)) - x + 1, height: Math.max(...cells.map(cell => cell.y)) - y + 1 };
      }
      const frame = z.number().int().parse(result.frame);
      const previous = a.overlayPreviousFrame && frame > 0 ? (await readCellFrame(frame - 1)).data : {};
      const lines = Array.from({ length: bounds.height }, (_, row) => Array.from({ length: bounds.width }, (_, column) => {
        const key = `${bounds.x + column},${bounds.y + row}`;
        return data[key]?.char ?? (previous[key] ? '\u00b7' : ' ');
      }).join(''));
      return boundedResult(textResult({
        success: true, frame: result.frame, scope: 'composite',
        bounds, isEmpty: cells.length === 0,
        ascii: a.trimEmpty && !a.region && !cells.length ? '' : lines.join('\n'),
      }));
    }
    case 'set_cell': {
      const { result, cells } = await readCellFrame(undefined, { x: a.x, y: a.y, width: 1, height: 1 }, 'layer');
      return run('set_cells', {
        target: readTarget(result),
        cells: [{ ...(cells[0] ?? EMPTY_CELL), ...pick(a, 'x', 'y', 'char', 'color', 'bgColor') }],
      });
    }
    case 'clear_cell': return run('set_cells', { cells: [{ x: a.x, y: a.y, clear: true }] });
    case 'set_cells_batch': {
      const requested = z.array(z.object({
        x: z.number().int(), y: z.number().int(), char: z.string().optional(),
        color: z.string().optional(), bgColor: z.string().optional(),
      })).max(10_000).parse(a.cells);
      const { result, data } = await readCellFrame(undefined, undefined, 'layer');
      if (!requested.length) return textResult({ success: true, browserSynced: true, cellsChanged: 0, noChange: true });
      const cells = requested.map(({ x, y, ...style }) => {
        const current = { ...EMPTY_CELL, ...data[`${x},${y}`] };
        const cell = { ...current, ...Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) };
        data[`${x},${y}`] = cell;
        return { x, y, ...cell };
      });
      return run('set_cells', { target: readTarget(result), cells });
    }
    case 'clear_canvas': return run('clear_cells', {});
    case 'paste_ascii_block': return run('import_text', {
      ...pick(a, 'text', 'x', 'y'), style: pick(a, 'color', 'bgColor'), keepSpaces: a.preserveSpaces,
    });
    case 'fill_region': return run('fill_area', {
      ...pick(a, 'x', 'y', 'contiguous'),
      match: { char: a.matchChar ?? true, color: a.matchColor ?? true, bgColor: a.matchBgColor ?? true },
      style: pick(a, 'char', 'color', 'bgColor'),
    });
    case 'set_frame_rate': return run('set_timeline', { frameRate: a.fps });
    case 'set_timeline_duration': return run('set_timeline', { durationFrames: a.durationFrames });
    case 'go_to_frame': return run('seek', { frame: a.index });
    case 'rename_layer': return run('update_layer', pick(a, 'layerId', 'name'));
    case 'set_layer_visibility': return run('update_layer', pick(a, 'layerId', 'visible', 'solo', 'locked', 'opacity'));
    case 'reorder_layers': {
      const pm = await documentForTarget();
      const layer = pm.getState().layers[z.number().int().parse(a.fromIndex)];
      if (!layer) throw new BrowserOperationError('NOT_FOUND', 'Layer index does not exist');
      return run('reorder_layer', { layerId: layer.id, toIndex: a.toIndex });
    }
    case 'add_content_frame': {
      const data = a.data === undefined ? {} : z.record(z.string(), z.object({
        char: z.string(), color: z.string(), bgColor: z.string(),
      })).parse(a.data);
      return run(name, {
        ...pick(a, 'layerId', 'startFrame', 'durationFrames'),
        cells: Object.entries(data).map(([key, cell]) => ({ ...parseCellKey(key), ...cell })),
      });
    }
    case 'add_keyframe': return run('set_keyframes', {
      ...pick(a, 'layerId', 'propertyPath'),
      keyframes: [pick(a, 'frame', 'value', 'easing')],
    });
    case 'remove_keyframe': {
      const pm = await documentForTarget();
      const track = pm.getLayer(z.string().parse(a.layerId))?.propertyTracks.find(track => track.id === a.trackId);
      if (!track) throw new BrowserOperationError('NOT_FOUND', 'Transform track not found');
      return run('remove_keyframes', { layerId: a.layerId, propertyPath: track.propertyPath, keyframeIds: [a.keyframeId] });
    }
    case 'ungroup_layers': return run('ungroup', { groupId: a.groupId });
    case 'add_effect_block': {
      const pm = await documentForTarget();
      const owner = a.ownerId == null || a.ownerId === 'global' ? { global: true }
        : pm.getState().layers.some(layer => layer.id === a.ownerId) ? { layerId: a.ownerId } : { groupId: a.ownerId };
      return run('add_effect', { owner, ...pick(a, 'effectType', 'startFrame', 'durationFrames', 'settings') });
    }
    case 'update_effect_block': return run('update_effect', pick(a, 'blockId', 'startFrame', 'durationFrames', 'enabled', 'settings'));
    case 'remove_effect_block': return run('remove_effect', { blockId: a.blockId });
    case 'add_effect_keyframe': return run('set_effect_keyframes', {
      ...pick(a, 'blockId', 'propertyPath'), keyframes: [pick(a, 'frame', 'value')],
    });
    case 'remove_effect_keyframe': {
      const pm = await documentForTarget();
      const state = pm.getState();
      const tracks = [...state.globalEffects, ...state.layers.flatMap(layer => layer.effectTracks ?? []),
        ...state.layerGroups.flatMap(group => group.effectTracks ?? [])];
      const block = tracks.find(track => track.effectBlock.id === a.blockId)?.effectBlock;
      const track = block?.propertyTracks.find(track => track.keyframes.some(key => key.id === a.keyframeId));
      if (!track) throw new BrowserOperationError('NOT_FOUND', 'Effect keyframe not found');
      return run('remove_effect_keyframes', { blockId: a.blockId, propertyPath: track.propertyPath, keyframeIds: [a.keyframeId] });
    }
    case 'shift_frame_content': return run('shift_content', { ...target(a), ...pick(a, 'dx', 'dy', 'wrap') });
    case 'flip_region': return run('flip_content', { ...target(a), axis: a.direction, ...pick(a, 'region') });
    case 'batch_recolor': {
      const properties = a.target === 'foreground' ? ['color'] : a.target === 'background' ? ['bgColor'] : ['color', 'bgColor'];
      return run('apply_operations', { operations: properties.map(property => ({
        op: 'replace_in_cells',
        input: { ...target(a), match: { [property]: a.oldColor }, replace: { [property]: a.newColor } },
      })) });
    }
    case 'batch_replace_char': return run('replace_in_cells', {
      ...target(a), match: { char: a.oldChar }, replace: { char: a.newChar },
    });
    case 'select_rectangle': return run('set_selection', {
      mode: 'rectangle', region: pick(a, 'x', 'y', 'width', 'height'),
    });
    case 'select_by_color': {
      const { cells, result } = await readCellFrame(undefined, { x: a.x, y: a.y, width: 1, height: 1 }, 'layer');
      const source = cells[0] ?? EMPTY_CELL;
      const match = {
        ...(a.matchChar ? { char: source.char } : {}),
        ...(a.matchColor ? { color: source.color } : {}),
        ...(a.matchBgColor ? { bgColor: source.bgColor } : {}),
      };
      return run('set_selection', {
        mode: Object.keys(match).length ? 'match' : 'all', target: readTarget(result),
        ...(Object.keys(match).length ? { match } : {}),
        ...(a.contiguous ? { contiguousFrom: { x: a.x, y: a.y } } : {}),
      });
    }
    case 'apply_to_selection': {
      if (a.operation === 'clear') return run('clear_cells', { useSelection: true });
      if (a.operation === 'fill') return run('fill_region', {
        useSelection: true, cell: { char: a.char ?? '@', color: a.color ?? '#FFFFFF', bgColor: a.bgColor ?? 'transparent' },
      });
      return run('replace_in_cells', { useSelection: true, match: {}, replace: pick(a, 'color', 'bgColor') });
    }
    case 'get_selection': {
      const selection = await executeBridgeOperation('get_selection', {});
      const cells = selection.cells === undefined ? undefined : z.array(z.unknown()).parse(selection.cells);
      const limit = z.number().int().min(1).max(500).parse(a.maxCells ?? 100);
      return textResult({
        ...selection, cells: a.includeCells ? cells?.slice(0, limit) : undefined,
        truncated: !!selection.truncated || (a.includeCells === true && !!cells && cells.length > limit),
      });
    }
    case 'delete_selection_content': return run('clear_cells', { useSelection: true });
    case 'set_foreground_color': return run('set_tool_state', { foregroundColor: a.color });
    case 'set_background_color': return run('set_tool_state', { backgroundColor: a.color });
    case 'set_selected_character': return run('set_tool_state', { character: a.character });
    case 'list_generator_types': {
      const catalog = await executeBridgeOperation('get_catalog', { family: 'generators' });
      const entries = z.array(z.object({
        type: z.string(), name: z.string(), description: z.string().optional(), mode: z.string().optional(),
        properties: z.array(z.object({ category: z.string().optional() }).passthrough()),
        defaultSettings: z.record(z.unknown()), initialSettings: z.record(z.unknown()).optional(),
      }).passthrough()).parse(catalog.entries);
      if (!a.generatorType) return textResult({
        catalogSource: 'browser',
        generators: entries.map(entry => ({
          type: entry.type, name: entry.name, description: entry.description, mode: entry.mode,
          propertyCount: entry.properties.length, categories: [...new Set(entry.properties.map(property => property.category))],
        })),
        next: 'Pass generatorType and optionally category to inspect property schemas and defaults.',
      });
      const entry = entries.find(entry => entry.type === a.generatorType);
      if (!entry) throw new BrowserOperationError('NOT_FOUND', `Generator "${a.generatorType}" not found`);
      const properties = entry.properties.filter(property =>
        !a.category || property.category?.toLowerCase() === String(a.category).toLowerCase());
      const grouped: Record<string, unknown[]> = {};
      for (const property of properties) (grouped[property.category ?? 'Other'] ??= []).push(property);
      return boundedResult(textResult({
        catalogSource: 'browser', type: entry.type, name: entry.name, description: entry.description, mode: entry.mode,
        defaultSettings: entry.defaultSettings, creationDefaults: entry.initialSettings,
        propertiesByCategory: grouped,
      }));
    }
    case 'get_generator_layers': {
      if (a.layerId) return run('get_generator_state', pick(a, 'layerId', 'frame'));
      const pm = await documentForTarget();
      const layers = [];
      for (const layer of pm.getGeneratorLayers()) {
        layers.push(await executeBridgeOperation('get_generator_state', { layerId: layer.id, ...pick(a, 'frame') }));
      }
      return textResult({ success: true, layers });
    }
    case 'list_character_palettes':
    case 'list_color_palettes':
    case 'get_character_palette':
    case 'get_color_palette': {
      const catalog = await executeBridgeOperation('get_catalog', { family: 'palettes' });
      const entries = z.array(z.record(z.string(), z.unknown())).parse(
        name.includes('character') ? catalog.characterPalettes : catalog.colorPalettes);
      if (name.startsWith('list_')) return textResult({ palettes: entries });
      const palette = entries.find(palette => palette.id === a.paletteId);
      if (!palette) throw new BrowserOperationError('NOT_FOUND', `Palette "${a.paletteId}" not found`);
      return textResult({ palette });
    }
    case 'get_active_colors': {
      const catalog = await executeBridgeOperation('get_catalog', { family: 'tools' });
      return textResult({ current: catalog.current });
    }
    case 'get_color_stats': {
      const { cells } = await readCellFrame(a.frameIndex);
      const count = (values: string[]) => {
        const counts = new Map<string, number>();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1]);
      };
      const foreground = count(cells.map(cell => cell.color));
      const background = count(a.includeBackground ? cells.filter(cell => cell.bgColor !== 'transparent').map(cell => cell.bgColor) : []);
      return textResult({
        scope: 'composite', totalCells: cells.length,
        foregroundColors: foreground.slice(0, 20).map(([color, count]) => ({ color, count })),
        backgroundColors: background.slice(0, 20).map(([color, count]) => ({ color, count })),
        uniqueForegroundColors: foreground.length, uniqueBackgroundColors: background.length,
        topCharacters: count(cells.map(cell => cell.char)).slice(0, 20).map(([char, count]) => ({ char, count })),
      });
    }
    case 'import_ascii_text': {
      const text = await fs.readFile(await resolveProjectPath(z.string().parse(a.filePath)), 'utf8');
      return run('import_text', {
        ...target(a), text, x: a.offsetX, y: a.offsetY, style: pick(a, 'color', 'bgColor'), keepSpaces: a.replaceSpaces,
      });
    }
    case 'import_image':
    case 'import_video': {
      const filename = await resolveProjectPath(z.string().parse(a.filePath));
      const extension = path.extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      };
      const mimeType = mimeTypes[extension];
      if (!mimeType) throw new BrowserOperationError('UNSUPPORTED', `Unsupported media extension: ${extension}`);
      if (a.colorMode === 'background' || a.colorMode === 'both') {
        throw new BrowserOperationError('UNSUPPORTED',
          'The app does not import exact source-color backgrounds. Use import_media with an explicit background palette.');
      }
      if (a.dithering !== undefined && a.dithering !== 'none') {
        throw new BrowserOperationError('UNSUPPORTED',
          'Legacy brightness dithering is not supported by the app importer. Use import_media for native palette-color dithering.');
      }
      if (a.charset === '') throw new BrowserOperationError('INVALID_INPUT', 'Import charset must not be empty');
      const settings: Record<string, unknown> = {
        characterSet: Array.from(z.string().parse(a.charset)),
        enableCharacterMapping: true, characterMappingStyle: 'character-palette', cropMode: 'top-left',
        enableTextColorMapping: a.colorMode !== 'none', enableBackgroundColorMapping: false,
        textColorPaletteId: null, useOriginalColors: true, colorQuantization: 'none',
        textColorMappingMode: 'closest', nudgeX: a.offsetX ?? 0, nudgeY: a.offsetY ?? 0,
      };
      return run('import_media', {
        ...target(a), data: (await fs.readFile(filename)).toString('base64'), mimeType,
        filename: path.basename(filename), mode: name === 'import_image' ? 'overlay' : 'new_layer',
        width: a.targetWidth, height: a.targetHeight,
        settings,
        ...(name === 'import_video' ? { video: {
          frameRate: a.fps, ...pick(a, 'maxFrames', 'startTime', 'duration'),
        } } : {}),
      });
    }
    default: {
      if (name.startsWith('export_')) {
        return legacyExportTool(name, a);
      }
      if (operationNamed(name)) return run(name, { ...a });
      throw new BrowserOperationError('UNSUPPORTED', `Legacy tool "${name}" has no verified v3 adapter yet.`);
    }
  }
}

const contentComputations = new Set([
  'copy_frame_and_modify', 'copy_region_to_frame', 'interpolate_frames', 'apply_effect',
  'run_generator', 'add_frame', 'delete_frame', 'duplicate_frame', 'set_frame_duration', 'set_frame_name',
]);
const headlessViews = new Set([
  'undo', 'redo', 'save_project', 'go_to_frame', 'set_active_layer', 'select_rectangle',
  'select_by_color', 'clear_selection', 'set_foreground_color', 'set_background_color', 'set_selected_character',
]);

async function computedContentTool(name: string, next: () => Promise<ToolResult>): Promise<ToolResult> {
  const native = await executeBridgeOperation('get_document', {});
  const summary = await executeBridgeOperation('get_document_summary', {});
  const manager = new ProjectStateManager();
  manager.loadFromUnknownSessionData(native.document);
  if (typeof summary.activeLayerId === 'string') manager.setActiveLayer(summary.activeLayerId);
  const timeline = z.object({ currentFrame: z.number().int().min(0) }).parse(summary.timeline);
  manager.goToFrame(timeline.currentFrame);
  const before = manager.toSessionDataV2();
  const response = await withLocalProject(manager, next);
  if (response.isError) return response;
  const operations = contentPatch(before, manager.toSessionDataV2());
  if (!operations.length) return response;
  const revision = z.number().int().min(0).parse(native.revision);
  const applied = await executeBridgeOperation('apply_operations', { operations }, revision);
  return boundedResult(textResult({
    success: true, operation: name, browserSynced: true, result: applied,
  }));
}

async function animatedTextTool(next: () => Promise<ToolResult>): Promise<ToolResult> {
  const native = await executeBridgeOperation('get_document', {});
  const manager = new ProjectStateManager();
  manager.loadFromUnknownSessionData(native.document);
  const ids = new Set(manager.getState().layers.map(layer => layer.id));
  const preview = await withLocalProject(manager, next);
  if (preview.isError) return preview;
  const added = manager.getGeneratorLayers().find(layer => !ids.has(layer.id));
  const source = added?.generator;
  if (!added || !source) throw new Error('Animated Text configuration did not create a generator');
  return operationToolResult('add_generator_layer', {
    name: added.name, generatorType: source.generatorType,
    startFrame: source.startFrame, durationFrames: source.durationFrames, settings: source.settings,
    keyframes: source.propertyTracks.map(track => ({
      propertyPath: track.propertyPath, replace: true, loop: track.loopKeyframes,
      keyframes: track.keyframes.map(key => ({ frame: key.frame, value: key.value, easing: key.easing })),
    })),
  });
}

setToolMetadataProvider(legacyToolMetadata);
setToolExecutionMiddleware((name, args, next, requestContext) => {
  const signal = requestContext.mcpReq.signal;
  const execution = toolQueue.then(() => toolContext.run({ signal }, async () => {
    try {
      if (signal.aborted) throw new BrowserOperationError('BUSY', 'Tool request cancelled before execution');
      if (typeof args.filePath === 'string') await resolveProjectPath(args.filePath);
      if (!transport && !generatedToolNames.has(name) && !headlessViews.has(name)
        && !/^(get_|list_|export_|describe_|compare_|preview_|refresh_|read_)/.test(name)) {
        return await boundedResult(await getProjectManager().transaction(name, next, result => !!result.isError || signal.aborted));
      }
      if (generatedToolNames.has(name) || !transport
        || ['get_connection_status', 'get_auth_token', 'list_project_files', 'read_artifact'].includes(name)) {
        return await boundedResult(await next(), name === 'read_artifact' ? MAX_PAGE_BYTES : undefined);
      }
      if (contentComputations.has(name)) return await computedContentTool(name, next);
      if (name === 'add_animated_text') return await animatedTextTool(next);
      if (['get_effect_blocks', 'get_layer_properties', 'preview_generator', 'suggest_palette_for_style'].includes(name)) {
        if (!await transport.requestStateFromBrowser()) throw new Error('Browser state refresh timed out');
        return await boundedResult(await next());
      }
      return await boundedResult(await legacyLiveTool(name, args));
    } catch (error) {
      return await boundedResult(bridgeFailure(error));
    }
  }));
  toolQueue = execution.then(() => undefined, () => undefined);
  return execution;
});
