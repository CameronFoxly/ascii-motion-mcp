/**
 * Project State Manager
 * 
 * Manages the in-memory state for an Ascii-Motion project.
 * This is the central data store that all tools operate on.
 * 
 * v2.0.0: Supports both legacy frame-based projects and layer-based timeline projects.
 */

import {
  type Cell,
  type Frame,
  type CanvasData,
  type SessionData,
  type SessionDataV2,
  type Selection,
  type ToolState,
  type TypographySettings,
  type MCPLayer,
  type MCPContentFrame,
  type MCPPropertyTrack,
  type MCPKeyframe,
  type MCPLayerGroup,
  type TimelineConfig,
  type PropertyPath,
  type EasingCurve,
  EMPTY_CELL,
  createCellKey,
  parseCellKey,
  isInBounds,
  generateFrameId,
  generateLayerId,
  generateContentFrameId,
  generatePropertyTrackId,
  generateKeyframeId,
  generateLayerGroupId,
  detectSessionVersion,
  recordToMap,
  SessionDataSchema,
  SessionDataV2Schema,
} from './types.js';

// ============================================================================
// History Entry Types
// ============================================================================

interface HistoryEntry {
  type: string;
  description: string;
  timestamp: number;
  undo: () => void;
  redo: () => void;
}

// ============================================================================
// Project State Interface
// ============================================================================

export interface ProjectState {
  // Project metadata
  name: string;
  description: string;
  filePath: string | null;
  isDirty: boolean;
  
  // Canvas
  width: number;
  height: number;
  backgroundColor: string;
  showGrid: boolean;
  
  // Legacy animation (v1 compat, used when layers is empty)
  frames: Frame[];
  currentFrameIndex: number;
  frameRate: number;
  looping: boolean;
  
  // Layer timeline (v2)
  layers: MCPLayer[];
  layerGroups: MCPLayerGroup[];
  activeLayerId: string | null;
  timelineConfig: TimelineConfig;
  
  // Tools
  toolState: ToolState;
  
  // Typography
  typography: TypographySettings;
  
  // Selection
  selection: Selection | null;
  
  // History
  historyStack: HistoryEntry[];
  historyIndex: number;
  maxHistorySize: number;
}

// ============================================================================
// Default State
// ============================================================================

const DEFAULT_FRAME_DURATION = 100; // ms

function createDefaultFrame(): Frame {
  return {
    id: generateFrameId(),
    name: 'Frame 1',
    duration: DEFAULT_FRAME_DURATION,
    data: {},
  };
}

function createDefaultLayer(name = 'Layer 1', canvasWidth = 80, canvasHeight = 24): MCPLayer {
  const anchorX = Math.floor(canvasWidth / 2);
  const anchorY = Math.floor(canvasHeight / 2);
  return {
    id: generateLayerId(),
    name,
    visible: true,
    solo: false,
    locked: false,
    opacity: 100,
    contentFrames: [{
      id: generateContentFrameId(),
      name: 'Frame 1',
      startFrame: 0,
      durationFrames: 1,
      data: {},
    }],
    propertyTracks: [],
    staticProperties: {
      'transform.anchorPoint.x': anchorX,
      'transform.anchorPoint.y': anchorY,
    },
  };
}

function createDefaultState(): ProjectState {
  return {
    name: 'Untitled Project',
    description: '',
    filePath: null,
    isDirty: false,
    
    width: 80,
    height: 24,
    backgroundColor: '#000000',
    showGrid: true,
    
    frames: [createDefaultFrame()],
    currentFrameIndex: 0,
    frameRate: 12,
    looping: true,
    
    layers: [],
    layerGroups: [],
    activeLayerId: null,
    timelineConfig: {
      frameRate: 12,
      durationFrames: 12,
    },
    
    toolState: {
      activeTool: 'pencil',
      selectedColor: '#FFFFFF',
      selectedBgColor: 'transparent',
      selectedCharacter: '@',
      paintBucketContiguous: true,
      rectangleFilled: false,
    },
    
    typography: {
      fontSize: 16,
      characterSpacing: 0,
      lineSpacing: 0,
      selectedFontId: 'jetbrains-mono',
    },
    
    selection: null,
    
    historyStack: [],
    historyIndex: -1,
    maxHistorySize: 100,
  };
}

// ============================================================================
// Project State Manager Class
// ============================================================================

export class ProjectStateManager {
  private state: ProjectState;
  
  constructor() {
    this.state = createDefaultState();
  }
  
  // ==========================================================================
  // State Access
  // ==========================================================================
  
  getState(): Readonly<ProjectState> {
    return this.state;
  }

  /**
   * Whether the project is in layer mode (v2 timeline).
   */
  isLayerMode(): boolean {
    return this.state.layers.length > 0;
  }

  getCurrentFrame(): Frame {
    return this.state.frames[this.state.currentFrameIndex];
  }
  
  getCurrentFrameData(): Map<string, Cell> {
    return recordToMap(this.getCurrentFrame().data);
  }
  
  // ==========================================================================
  // Canvas Operations (work on active layer in layer mode)
  // ==========================================================================
  
  getCell(x: number, y: number): Cell {
    if (!isInBounds(x, y, this.state.width, this.state.height)) {
      return EMPTY_CELL;
    }
    const key = createCellKey(x, y);

    if (this.isLayerMode()) {
      const cf = this.getActiveContentFrame();
      if (!cf) return EMPTY_CELL;
      return cf.data[key] ?? EMPTY_CELL;
    }

    const frame = this.getCurrentFrame();
    return frame.data[key] ?? EMPTY_CELL;
  }
  
  setCell(x: number, y: number, cell: Cell, recordHistory = true): boolean {
    if (!isInBounds(x, y, this.state.width, this.state.height)) {
      return false;
    }
    
    const key = createCellKey(x, y);
    const isEmpty = cell.char === ' ' && cell.color === '#FFFFFF' && cell.bgColor === 'transparent';

    if (this.isLayerMode()) {
      const layer = this.getActiveLayer();
      if (!layer || layer.locked) return false;
      const cf = this.getActiveContentFrame();
      if (!cf) return false;
      const previousCell = cf.data[key];

      if (recordHistory) {
        this.pushHistory({
          type: 'set_cell',
          description: `Set cell at (${x}, ${y}) on layer "${layer.name}"`,
          timestamp: Date.now(),
          undo: () => { if (previousCell) cf.data[key] = previousCell; else delete cf.data[key]; },
          redo: () => { if (isEmpty) delete cf.data[key]; else cf.data[key] = { ...cell }; },
        });
      }
      if (isEmpty) delete cf.data[key]; else cf.data[key] = { ...cell };
      this.state.isDirty = true;
      return true;
    }

    // Legacy frame mode
    const frame = this.getCurrentFrame();
    const previousCell = frame.data[key];
    
    if (recordHistory) {
      this.pushHistory({
        type: 'set_cell',
        description: `Set cell at (${x}, ${y})`,
        timestamp: Date.now(),
        undo: () => { if (previousCell) frame.data[key] = previousCell; else delete frame.data[key]; },
        redo: () => { if (isEmpty) delete frame.data[key]; else frame.data[key] = { ...cell }; },
      });
    }
    
    if (isEmpty) delete frame.data[key]; else frame.data[key] = { ...cell };
    this.state.isDirty = true;
    return true;
  }
  
  setCells(cells: Array<{ x: number; y: number; cell: Cell }>, recordHistory = true): number {
    if (this.isLayerMode()) {
      const layer = this.getActiveLayer();
      if (!layer || layer.locked) return 0;
      const cf = this.getActiveContentFrame();
      if (!cf) return 0;
      const previousData = { ...cf.data };
      let count = 0;
      for (const { x, y, cell } of cells) {
        if (!isInBounds(x, y, this.state.width, this.state.height)) continue;
        const key = createCellKey(x, y);
        const isEmpty = cell.char === ' ' && cell.color === '#FFFFFF' && cell.bgColor === 'transparent';
        if (isEmpty) delete cf.data[key]; else cf.data[key] = { ...cell };
        count++;
      }
      if (recordHistory && count > 0) {
        const newData = { ...cf.data };
        this.pushHistory({
          type: 'set_cells_batch',
          description: `Set ${count} cells on layer "${layer.name}"`,
          timestamp: Date.now(),
          undo: () => { Object.keys(cf.data).forEach(k => delete cf.data[k]); Object.assign(cf.data, previousData); },
          redo: () => { Object.keys(cf.data).forEach(k => delete cf.data[k]); Object.assign(cf.data, newData); },
        });
      }
      if (count > 0) this.state.isDirty = true;
      return count;
    }

    // Legacy mode
    const frame = this.getCurrentFrame();
    const previousData = { ...frame.data };
    let count = 0;
    
    for (const { x, y, cell } of cells) {
      if (!isInBounds(x, y, this.state.width, this.state.height)) continue;
      const key = createCellKey(x, y);
      if (cell.char === ' ' && cell.color === '#FFFFFF' && cell.bgColor === 'transparent') {
        delete frame.data[key];
      } else {
        frame.data[key] = { ...cell };
      }
      count++;
    }
    
    if (recordHistory && count > 0) {
      const newData = { ...frame.data };
      this.pushHistory({
        type: 'set_cells_batch',
        description: `Set ${count} cells`,
        timestamp: Date.now(),
        undo: () => { frame.data = previousData; },
        redo: () => { frame.data = newData; },
      });
    }
    
    if (count > 0) this.state.isDirty = true;
    return count;
  }
  
  clearCell(x: number, y: number, recordHistory = true): boolean {
    return this.setCell(x, y, EMPTY_CELL, recordHistory);
  }
  
  clearCanvas(recordHistory = true): void {
    if (this.isLayerMode()) {
      const layer = this.getActiveLayer();
      if (!layer || layer.locked) return;
      const cf = this.getActiveContentFrame();
      if (!cf) return;
      const previousData = { ...cf.data };
      if (recordHistory) {
        this.pushHistory({
          type: 'clear_canvas',
          description: `Clear canvas on layer "${layer.name}"`,
          timestamp: Date.now(),
          undo: () => { Object.keys(cf.data).forEach(k => delete cf.data[k]); Object.assign(cf.data, previousData); },
          redo: () => { Object.keys(cf.data).forEach(k => delete cf.data[k]); },
        });
      }
      Object.keys(cf.data).forEach(k => delete cf.data[k]);
      this.state.isDirty = true;
      return;
    }

    const frame = this.getCurrentFrame();
    const previousData = { ...frame.data };
    if (recordHistory) {
      this.pushHistory({
        type: 'clear_canvas',
        description: 'Clear canvas',
        timestamp: Date.now(),
        undo: () => { frame.data = previousData; },
        redo: () => { frame.data = {}; },
      });
    }
    frame.data = {};
    this.state.isDirty = true;
  }
  
  resizeCanvas(width: number, height: number, recordHistory = true): void {
    const previousWidth = this.state.width;
    const previousHeight = this.state.height;
    width = Math.max(4, Math.min(200, width));
    height = Math.max(4, Math.min(100, height));
    
    const previousFrameData = this.state.frames.map(f => ({ ...f.data }));
    
    if (recordHistory) {
      this.pushHistory({
        type: 'resize_canvas',
        description: `Resize canvas to ${width}x${height}`,
        timestamp: Date.now(),
        undo: () => {
          this.state.width = previousWidth;
          this.state.height = previousHeight;
          this.state.frames.forEach((frame, i) => { frame.data = previousFrameData[i]; });
        },
        redo: () => {
          this.state.width = width;
          this.state.height = height;
          this.state.frames.forEach(frame => {
            const newData: CanvasData = {};
            Object.entries(frame.data).forEach(([key, cell]) => {
              const { x, y } = parseCellKey(key);
              if (x < width && y < height) newData[key] = cell;
            });
            frame.data = newData;
          });
        },
      });
    }
    
    this.state.width = width;
    this.state.height = height;
    this.state.frames.forEach(frame => {
      const newData: CanvasData = {};
      Object.entries(frame.data).forEach(([key, cell]) => {
        const { x, y } = parseCellKey(key);
        if (x < width && y < height) newData[key] = cell;
      });
      frame.data = newData;
    });
    this.state.isDirty = true;
  }
  
  // ==========================================================================
  // Fill Operations
  // ==========================================================================
  
  fillRegion(
    startX: number,
    startY: number,
    fillCell: Cell,
    options: {
      contiguous?: boolean;
      matchChar?: boolean;
      matchColor?: boolean;
      matchBgColor?: boolean;
    } = {},
    recordHistory = true
  ): number {
    const {
      contiguous = true,
      matchChar = false,
      matchColor = false,
      matchBgColor = false,
    } = options;
    
    const targetCell = this.getCell(startX, startY);
    
    const matches = (cell: Cell): boolean => {
      if (matchChar && cell.char !== targetCell.char) return false;
      if (matchColor && cell.color !== targetCell.color) return false;
      if (matchBgColor && cell.bgColor !== targetCell.bgColor) return false;
      return true;
    };
    
    const cellsToFill: Set<string> = new Set();
    
    if (contiguous) {
      const visited = new Set<string>();
      const queue: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
      while (queue.length > 0) {
        const { x, y } = queue.shift()!;
        const key = createCellKey(x, y);
        if (visited.has(key)) continue;
        if (!isInBounds(x, y, this.state.width, this.state.height)) continue;
        visited.add(key);
        const currentCell = this.getCell(x, y);
        if (!matches(currentCell)) continue;
        cellsToFill.add(key);
        queue.push({ x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 });
      }
    } else {
      for (let y = 0; y < this.state.height; y++) {
        for (let x = 0; x < this.state.width; x++) {
          if (matches(this.getCell(x, y))) cellsToFill.add(createCellKey(x, y));
        }
      }
    }
    
    // Get the data target (layer content frame or legacy frame)
    const dataTarget = this.isLayerMode() ? this.getActiveContentFrame()?.data : this.getCurrentFrame().data;
    if (!dataTarget) return 0;

    const previousData = { ...dataTarget };
    const isEmpty = fillCell.char === ' ' && fillCell.color === '#FFFFFF' && fillCell.bgColor === 'transparent';
    
    for (const key of cellsToFill) {
      if (isEmpty) delete dataTarget[key]; else dataTarget[key] = { ...fillCell };
    }
    
    if (recordHistory && cellsToFill.size > 0) {
      const newData = { ...dataTarget };
      this.pushHistory({
        type: 'fill_region',
        description: `Fill ${cellsToFill.size} cells`,
        timestamp: Date.now(),
        undo: () => { Object.keys(dataTarget).forEach(k => delete dataTarget[k]); Object.assign(dataTarget, previousData); },
        redo: () => { Object.keys(dataTarget).forEach(k => delete dataTarget[k]); Object.assign(dataTarget, newData); },
      });
    }
    
    if (cellsToFill.size > 0) this.state.isDirty = true;
    return cellsToFill.size;
  }
  
  // ==========================================================================
  // Legacy Frame Operations (v1 compat)
  // ==========================================================================
  
  addFrame(atIndex?: number, canvasData?: CanvasData, duration?: number, recordHistory = true): Frame {
    const newFrame: Frame = {
      id: generateFrameId(),
      name: `Frame ${this.state.frames.length + 1}`,
      duration: duration ?? DEFAULT_FRAME_DURATION,
      data: canvasData ? { ...canvasData } : {},
    };
    const insertIndex = atIndex ?? this.state.frames.length;
    if (recordHistory) {
      this.pushHistory({
        type: 'add_frame',
        description: `Add frame at index ${insertIndex}`,
        timestamp: Date.now(),
        undo: () => {
          this.state.frames.splice(insertIndex, 1);
          if (this.state.currentFrameIndex >= this.state.frames.length)
            this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
        },
        redo: () => { this.state.frames.splice(insertIndex, 0, newFrame); },
      });
    }
    this.state.frames.splice(insertIndex, 0, newFrame);
    this.state.isDirty = true;
    return newFrame;
  }
  
  deleteFrame(index: number, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) return false;
    if (this.state.frames.length === 1) return false;
    
    const deletedFrame = this.state.frames[index];
    const previousCurrentIndex = this.state.currentFrameIndex;
    if (recordHistory) {
      this.pushHistory({
        type: 'delete_frame',
        description: `Delete frame ${index}`,
        timestamp: Date.now(),
        undo: () => {
          this.state.frames.splice(index, 0, deletedFrame);
          this.state.currentFrameIndex = previousCurrentIndex;
        },
        redo: () => {
          this.state.frames.splice(index, 1);
          if (this.state.currentFrameIndex >= this.state.frames.length)
            this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
        },
      });
    }
    this.state.frames.splice(index, 1);
    if (this.state.currentFrameIndex >= this.state.frames.length)
      this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
    this.state.isDirty = true;
    return true;
  }
  
  duplicateFrame(index: number, recordHistory = true): Frame | null {
    if (index < 0 || index >= this.state.frames.length) return null;
    const sourceFrame = this.state.frames[index];
    const newFrame: Frame = {
      id: generateFrameId(),
      name: `${sourceFrame.name} (copy)`,
      duration: sourceFrame.duration,
      data: { ...sourceFrame.data },
    };
    const insertIndex = index + 1;
    if (recordHistory) {
      this.pushHistory({
        type: 'duplicate_frame',
        description: `Duplicate frame ${index}`,
        timestamp: Date.now(),
        undo: () => { this.state.frames.splice(insertIndex, 1); },
        redo: () => { this.state.frames.splice(insertIndex, 0, newFrame); },
      });
    }
    this.state.frames.splice(insertIndex, 0, newFrame);
    this.state.isDirty = true;
    return newFrame;
  }
  
  goToFrame(index: number): boolean {
    if (this.isLayerMode()) {
      if (index < 0 || index >= this.state.timelineConfig.durationFrames) return false;
      this.state.currentFrameIndex = index;
      return true;
    }
    if (index < 0 || index >= this.state.frames.length) return false;
    this.state.currentFrameIndex = index;
    return true;
  }
  
  setFrameDuration(index: number, duration: number, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) return false;
    duration = Math.max(10, Math.min(60000, duration));
    const frame = this.state.frames[index];
    const previousDuration = frame.duration;
    if (recordHistory) {
      this.pushHistory({
        type: 'set_frame_duration',
        description: `Set frame ${index} duration to ${duration}ms`,
        timestamp: Date.now(),
        undo: () => { frame.duration = previousDuration; },
        redo: () => { frame.duration = duration; },
      });
    }
    frame.duration = duration;
    this.state.isDirty = true;
    return true;
  }
  
  setFrameName(index: number, name: string, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) return false;
    const frame = this.state.frames[index];
    const previousName = frame.name;
    if (recordHistory) {
      this.pushHistory({
        type: 'set_frame_name',
        description: `Rename frame ${index} to "${name}"`,
        timestamp: Date.now(),
        undo: () => { frame.name = previousName; },
        redo: () => { frame.name = name; },
      });
    }
    frame.name = name;
    this.state.isDirty = true;
    return true;
  }
  
  // ==========================================================================
  // Layer Operations (v2)
  // ==========================================================================

  getActiveLayer(): MCPLayer | null {
    if (!this.state.activeLayerId) return null;
    return this.state.layers.find(l => l.id === this.state.activeLayerId) ?? null;
  }

  getActiveContentFrame(): MCPContentFrame | null {
    const layer = this.getActiveLayer();
    if (!layer) return null;
    return this.getContentFrameAtTime(layer, this.state.currentFrameIndex);
  }

  getContentFrameAtTime(layer: MCPLayer, frame: number): MCPContentFrame | null {
    for (const cf of layer.contentFrames) {
      if (cf.hidden) continue;
      if (frame >= cf.startFrame && frame < cf.startFrame + cf.durationFrames) return cf;
    }
    return null;
  }

  addLayer(name?: string): MCPLayer {
    const layer = createDefaultLayer(
      name ?? `Layer ${this.state.layers.length + 1}`,
      this.state.width,
      this.state.height,
    );
    this.state.layers.push(layer);
    this.state.activeLayerId = layer.id;
    if (this.state.timelineConfig.durationFrames < 1) {
      this.state.timelineConfig.durationFrames = 12;
    }
    this.state.isDirty = true;
    return layer;
  }

  removeLayer(layerId: string): boolean {
    const index = this.state.layers.findIndex(l => l.id === layerId);
    if (index < 0) return false;
    if (this.state.layers.length <= 1) return false;
    this.state.layers.splice(index, 1);
    for (const group of this.state.layerGroups) {
      group.childLayerIds = group.childLayerIds.filter(id => id !== layerId);
    }
    this.state.layerGroups = this.state.layerGroups.filter(g => g.childLayerIds.length > 0);
    if (this.state.activeLayerId === layerId) {
      this.state.activeLayerId = this.state.layers[Math.min(index, this.state.layers.length - 1)]?.id ?? null;
    }
    this.state.isDirty = true;
    return true;
  }

  duplicateLayer(layerId: string): MCPLayer | null {
    const source = this.state.layers.find(l => l.id === layerId);
    if (!source) return null;
    const newLayer: MCPLayer = JSON.parse(JSON.stringify(source));
    newLayer.id = generateLayerId();
    newLayer.name = `${source.name} (copy)`;
    newLayer.contentFrames = newLayer.contentFrames.map((cf: MCPContentFrame) => ({
      ...cf, id: generateContentFrameId(),
    }));
    newLayer.propertyTracks = newLayer.propertyTracks.map((pt: MCPPropertyTrack) => ({
      ...pt,
      id: generatePropertyTrackId(),
      keyframes: pt.keyframes.map((kf: MCPKeyframe) => ({ ...kf, id: generateKeyframeId() })),
    }));
    const sourceIndex = this.state.layers.findIndex(l => l.id === layerId);
    this.state.layers.splice(sourceIndex + 1, 0, newLayer);
    this.state.activeLayerId = newLayer.id;
    this.state.isDirty = true;
    return newLayer;
  }

  setActiveLayer(layerId: string): boolean {
    if (!this.state.layers.find(l => l.id === layerId)) return false;
    this.state.activeLayerId = layerId;
    return true;
  }

  renameLayer(layerId: string, name: string): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    layer.name = name;
    this.state.isDirty = true;
    return true;
  }

  reorderLayers(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.state.layers.length) return false;
    if (toIndex < 0 || toIndex >= this.state.layers.length) return false;
    const [layer] = this.state.layers.splice(fromIndex, 1);
    this.state.layers.splice(toIndex, 0, layer);
    this.state.isDirty = true;
    return true;
  }

  setLayerVisibility(layerId: string, visible: boolean): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    layer.visible = visible;
    this.state.isDirty = true;
    return true;
  }

  setLayerSolo(layerId: string, solo: boolean): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    layer.solo = solo;
    this.state.isDirty = true;
    return true;
  }

  setLayerLocked(layerId: string, locked: boolean): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    layer.locked = locked;
    this.state.isDirty = true;
    return true;
  }

  setLayerOpacity(layerId: string, opacity: number): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    layer.opacity = Math.max(0, Math.min(100, opacity));
    this.state.isDirty = true;
    return true;
  }

  getLayers(): MCPLayer[] {
    return this.state.layers;
  }

  getLayer(layerId: string): MCPLayer | null {
    return this.state.layers.find(l => l.id === layerId) ?? null;
  }

  // ==========================================================================
  // Content Frame Operations
  // ==========================================================================

  addContentFrame(layerId: string, startFrame: number, durationFrames: number, data?: CanvasData): MCPContentFrame | null {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return null;
    const endFrame = startFrame + durationFrames;
    for (const cf of layer.contentFrames) {
      const cfEnd = cf.startFrame + cf.durationFrames;
      if (startFrame < cfEnd && endFrame > cf.startFrame) return null;
    }
    const cf: MCPContentFrame = {
      id: generateContentFrameId(),
      name: `Frame ${layer.contentFrames.length + 1}`,
      startFrame,
      durationFrames: Math.max(1, durationFrames),
      data: data ? { ...data } : {},
    };
    layer.contentFrames.push(cf);
    layer.contentFrames.sort((a, b) => a.startFrame - b.startFrame);
    if (startFrame + durationFrames > this.state.timelineConfig.durationFrames) {
      this.state.timelineConfig.durationFrames = startFrame + durationFrames;
    }
    this.state.isDirty = true;
    return cf;
  }

  removeContentFrame(layerId: string, contentFrameId: string): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const index = layer.contentFrames.findIndex(cf => cf.id === contentFrameId);
    if (index < 0) return false;
    layer.contentFrames.splice(index, 1);
    this.state.isDirty = true;
    return true;
  }

  updateContentFrameData(layerId: string, contentFrameId: string, data: CanvasData): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const cf = layer.contentFrames.find(cf => cf.id === contentFrameId);
    if (!cf) return false;
    cf.data = { ...data };
    this.state.isDirty = true;
    return true;
  }

  updateContentFrameTiming(layerId: string, contentFrameId: string, startFrame: number, durationFrames: number): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const cf = layer.contentFrames.find(cf => cf.id === contentFrameId);
    if (!cf) return false;
    const endFrame = startFrame + durationFrames;
    for (const other of layer.contentFrames) {
      if (other.id === contentFrameId) continue;
      const otherEnd = other.startFrame + other.durationFrames;
      if (startFrame < otherEnd && endFrame > other.startFrame) return false;
    }
    cf.startFrame = startFrame;
    cf.durationFrames = Math.max(1, durationFrames);
    if (startFrame + durationFrames > this.state.timelineConfig.durationFrames) {
      this.state.timelineConfig.durationFrames = startFrame + durationFrames;
    }
    layer.contentFrames.sort((a, b) => a.startFrame - b.startFrame);
    this.state.isDirty = true;
    return true;
  }

  // ==========================================================================
  // Keyframe Operations
  // ==========================================================================

  addPropertyTrack(layerId: string, propertyPath: PropertyPath): MCPPropertyTrack | null {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return null;
    if (layer.propertyTracks.find(t => t.propertyPath === propertyPath)) return null;
    const track: MCPPropertyTrack = {
      id: generatePropertyTrackId(),
      propertyPath,
      keyframes: [],
      loopKeyframes: false,
    };
    layer.propertyTracks.push(track);
    this.state.isDirty = true;
    return track;
  }

  removePropertyTrack(layerId: string, trackId: string): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const index = layer.propertyTracks.findIndex(t => t.id === trackId);
    if (index < 0) return false;
    layer.propertyTracks.splice(index, 1);
    this.state.isDirty = true;
    return true;
  }

  addKeyframe(layerId: string, propertyPath: PropertyPath, frame: number, value: number, easing?: EasingCurve): MCPKeyframe | null {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return null;
    let track = layer.propertyTracks.find(t => t.propertyPath === propertyPath);
    if (!track) {
      const newTrack = this.addPropertyTrack(layerId, propertyPath);
      if (!newTrack) return null;
      track = newTrack;
    }
    track.keyframes = track.keyframes.filter(kf => kf.frame !== frame);
    const kf: MCPKeyframe = {
      id: generateKeyframeId(),
      frame,
      value,
      easing: easing ?? { type: 'linear' },
    };
    track.keyframes.push(kf);
    track.keyframes.sort((a, b) => a.frame - b.frame);
    if (frame >= this.state.timelineConfig.durationFrames) {
      this.state.timelineConfig.durationFrames = frame + 1;
    }
    this.state.isDirty = true;
    return kf;
  }

  removeKeyframe(layerId: string, trackId: string, keyframeId: string): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const track = layer.propertyTracks.find(t => t.id === trackId);
    if (!track) return false;
    const index = track.keyframes.findIndex(kf => kf.id === keyframeId);
    if (index < 0) return false;
    track.keyframes.splice(index, 1);
    this.state.isDirty = true;
    return true;
  }

  updateKeyframe(layerId: string, trackId: string, keyframeId: string, updates: Partial<MCPKeyframe>): boolean {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return false;
    const track = layer.propertyTracks.find(t => t.id === trackId);
    if (!track) return false;
    const kf = track.keyframes.find(kf => kf.id === keyframeId);
    if (!kf) return false;
    if (updates.frame !== undefined) kf.frame = updates.frame;
    if (updates.value !== undefined) kf.value = updates.value;
    if (updates.easing !== undefined) kf.easing = updates.easing;
    track.keyframes.sort((a, b) => a.frame - b.frame);
    this.state.isDirty = true;
    return true;
  }

  getLayerProperties(layerId: string): Record<string, { value: number; isKeyframed: boolean; keyframeCount: number }> {
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return {};
    const ALL_PROPERTIES: PropertyPath[] = [
      'transform.position.x', 'transform.position.y',
      'transform.scale.x', 'transform.scale.y',
      'transform.rotation',
      'transform.anchorPoint.x', 'transform.anchorPoint.y',
    ];
    const DEFAULTS: Record<string, number> = {
      'transform.position.x': 0, 'transform.position.y': 0,
      'transform.scale.x': 1, 'transform.scale.y': 1,
      'transform.rotation': 0,
      'transform.anchorPoint.x': Math.floor(this.state.width / 2),
      'transform.anchorPoint.y': Math.floor(this.state.height / 2),
    };
    const result: Record<string, { value: number; isKeyframed: boolean; keyframeCount: number }> = {};
    for (const prop of ALL_PROPERTIES) {
      const track = layer.propertyTracks.find(t => t.propertyPath === prop);
      const staticVal = layer.staticProperties?.[prop];
      if (track && track.keyframes.length > 0) {
        const value = this.interpolatePropertyValue(track, this.state.currentFrameIndex);
        result[prop] = { value, isKeyframed: true, keyframeCount: track.keyframes.length };
      } else if (staticVal !== undefined) {
        result[prop] = { value: staticVal, isKeyframed: false, keyframeCount: 0 };
      } else {
        result[prop] = { value: DEFAULTS[prop] ?? 0, isKeyframed: false, keyframeCount: 0 };
      }
    }
    return result;
  }

  private interpolatePropertyValue(track: MCPPropertyTrack, frame: number): number {
    const kfs = track.keyframes;
    if (kfs.length === 0) return 0;
    if (kfs.length === 1) return kfs[0].value as number;
    if (frame <= kfs[0].frame) return kfs[0].value as number;
    if (frame >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value as number;
    for (let i = 0; i < kfs.length - 1; i++) {
      if (frame >= kfs[i].frame && frame < kfs[i + 1].frame) {
        const prev = kfs[i];
        const next = kfs[i + 1];
        if (prev.easing.type === 'hold') return prev.value as number;
        const t = (frame - prev.frame) / (next.frame - prev.frame);
        return Math.round((prev.value as number) + ((next.value as number) - (prev.value as number)) * t);
      }
    }
    return kfs[kfs.length - 1].value as number;
  }

  // ==========================================================================
  // Layer Group Operations
  // ==========================================================================

  createGroup(name?: string, layerIds?: string[]): MCPLayerGroup {
    const group: MCPLayerGroup = {
      id: generateLayerGroupId(),
      name: name ?? `Group ${this.state.layerGroups.length + 1}`,
      childLayerIds: layerIds ?? [],
      visible: true,
      solo: false,
      locked: false,
      collapsed: false,
    };
    this.state.layerGroups.push(group);
    for (const lid of group.childLayerIds) {
      const layer = this.state.layers.find(l => l.id === lid);
      if (layer) layer.parentGroupId = group.id;
    }
    this.state.isDirty = true;
    return group;
  }

  ungroupLayers(groupId: string): boolean {
    const index = this.state.layerGroups.findIndex(g => g.id === groupId);
    if (index < 0) return false;
    const group = this.state.layerGroups[index];
    for (const lid of group.childLayerIds) {
      const layer = this.state.layers.find(l => l.id === lid);
      if (layer) delete layer.parentGroupId;
    }
    this.state.layerGroups.splice(index, 1);
    this.state.isDirty = true;
    return true;
  }

  getLayerGroups(): MCPLayerGroup[] {
    return this.state.layerGroups;
  }

  // ==========================================================================
  // Timeline Config Operations
  // ==========================================================================

  setFrameRate(fps: number): void {
    this.state.timelineConfig.frameRate = Math.max(1, Math.min(120, fps));
    this.state.frameRate = this.state.timelineConfig.frameRate;
    this.state.isDirty = true;
  }

  setTimelineDuration(frames: number): void {
    this.state.timelineConfig.durationFrames = Math.max(1, frames);
    this.state.isDirty = true;
  }
  
  // ==========================================================================
  // Selection Operations
  // ==========================================================================
  
  setSelection(selection: Selection | null): void {
    this.state.selection = selection;
  }
  
  getSelection(): Selection | null {
    return this.state.selection;
  }
  
  setToolState(updates: Partial<ToolState>): void {
    this.state.toolState = { ...this.state.toolState, ...updates };
  }

  clearSelection(): void {
    this.state.selection = null;
  }
  
  // ==========================================================================
  // History Operations
  // ==========================================================================
  
  private pushHistory(entry: HistoryEntry): void {
    if (this.state.historyIndex < this.state.historyStack.length - 1) {
      this.state.historyStack = this.state.historyStack.slice(0, this.state.historyIndex + 1);
    }
    this.state.historyStack.push(entry);
    this.state.historyIndex = this.state.historyStack.length - 1;
    if (this.state.historyStack.length > this.state.maxHistorySize) {
      this.state.historyStack.shift();
      this.state.historyIndex--;
    }
  }
  
  undo(): boolean {
    if (this.state.historyIndex < 0) return false;
    const entry = this.state.historyStack[this.state.historyIndex];
    entry.undo();
    this.state.historyIndex--;
    this.state.isDirty = true;
    return true;
  }
  
  redo(): boolean {
    if (this.state.historyIndex >= this.state.historyStack.length - 1) return false;
    this.state.historyIndex++;
    const entry = this.state.historyStack[this.state.historyIndex];
    entry.redo();
    this.state.isDirty = true;
    return true;
  }
  
  canUndo(): boolean { return this.state.historyIndex >= 0; }
  canRedo(): boolean { return this.state.historyIndex < this.state.historyStack.length - 1; }
  
  getHistoryInfo(): { canUndo: boolean; canRedo: boolean; undoDescription: string | null; redoDescription: string | null } {
    return {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoDescription: this.canUndo() ? this.state.historyStack[this.state.historyIndex].description : null,
      redoDescription: this.canRedo() ? this.state.historyStack[this.state.historyIndex + 1].description : null,
    };
  }
  
  // ==========================================================================
  // Project Operations
  // ==========================================================================
  
  newProject(options?: { width?: number; height?: number; name?: string }): void {
    this.state = createDefaultState();
    if (options?.width) this.state.width = Math.max(4, Math.min(200, options.width));
    if (options?.height) this.state.height = Math.max(4, Math.min(100, options.height));
    if (options?.name) this.state.name = options.name;
    this.state.isDirty = false;
  }
  
  loadFromSessionData(data: SessionData, filePath?: string): void {
    const validated = SessionDataSchema.parse(data);
    this.state = createDefaultState();
    this.state.name = validated.name ?? 'Untitled Project';
    this.state.description = validated.description ?? '';
    this.state.filePath = filePath ?? null;
    this.state.width = validated.canvas.width;
    this.state.height = validated.canvas.height;
    this.state.backgroundColor = validated.canvas.canvasBackgroundColor;
    this.state.showGrid = validated.canvas.showGrid ?? true;
    this.state.frames = validated.animation.frames.map((f, i) => ({
      id: (f.id ?? generateFrameId()) as string,
      name: f.name ?? `Frame ${i + 1}`,
      duration: f.duration ?? DEFAULT_FRAME_DURATION,
      data: f.data ?? {},
    }));
    if (this.state.frames.length === 0) this.state.frames = [createDefaultFrame()];
    this.state.currentFrameIndex = Math.min(validated.animation.currentFrameIndex, this.state.frames.length - 1);
    this.state.frameRate = validated.animation.frameRate ?? 12;
    this.state.looping = validated.animation.looping ?? true;
    if (validated.tools) this.state.toolState = { ...this.state.toolState, ...validated.tools };
    if (validated.typography) this.state.typography = { ...this.state.typography, ...validated.typography };
    this.state.historyStack = [];
    this.state.historyIndex = -1;
    this.state.isDirty = false;
  }

  loadFromSessionDataV2(data: SessionDataV2, filePath?: string): void {
    const validated = SessionDataV2Schema.parse(data);
    this.state = createDefaultState();
    this.state.name = validated.name ?? 'Untitled Project';
    this.state.description = validated.description ?? '';
    this.state.filePath = filePath ?? null;
    this.state.width = validated.canvas.width;
    this.state.height = validated.canvas.height;
    this.state.backgroundColor = validated.canvas.canvasBackgroundColor;
    this.state.showGrid = validated.canvas.showGrid ?? true;
    this.state.timelineConfig = {
      frameRate: validated.timeline.frameRate ?? 12,
      durationFrames: validated.timeline.durationFrames ?? 12,
    };
    this.state.frameRate = this.state.timelineConfig.frameRate;
    this.state.looping = validated.timeline.looping ?? true;
    this.state.layers = validated.layers.map(l => ({
      id: l.id,
      name: l.name,
      visible: l.visible ?? true,
      solo: l.solo ?? false,
      locked: l.locked ?? false,
      opacity: l.opacity ?? 100,
      parentGroupId: l.parentGroupId,
      syncKeyframesToFrames: l.syncKeyframesToFrames,
      contentFrames: l.contentFrames.map(cf => ({
        id: cf.id,
        name: cf.name,
        startFrame: cf.startFrame,
        durationFrames: cf.durationFrames,
        data: cf.data ?? {},
        hidden: cf.hidden,
      })),
      propertyTracks: l.propertyTracks.map(pt => ({
        id: pt.id,
        propertyPath: pt.propertyPath as PropertyPath,
        loopKeyframes: pt.loopKeyframes ?? false,
        keyframes: pt.keyframes.map(kf => ({
          id: kf.id,
          frame: kf.frame,
          value: kf.value,
          easing: kf.easing,
        })),
      })),
      staticProperties: l.staticProperties,
    }));
    this.state.layerGroups = (validated.layerGroups ?? []).map(g => ({
      id: g.id,
      name: g.name,
      childLayerIds: g.childLayerIds,
      visible: g.visible ?? true,
      solo: g.solo ?? false,
      locked: g.locked ?? false,
      collapsed: g.collapsed ?? false,
      propertyTracks: g.propertyTracks?.map(pt => ({
        id: pt.id,
        propertyPath: pt.propertyPath as PropertyPath,
        loopKeyframes: pt.loopKeyframes ?? false,
        keyframes: pt.keyframes.map(kf => ({ id: kf.id, frame: kf.frame, value: kf.value, easing: kf.easing })),
      })) ?? undefined,
      staticProperties: g.staticProperties,
    }));
    this.state.activeLayerId = this.state.layers[0]?.id ?? null;
    this.state.currentFrameIndex = 0;
    if (validated.tools) this.state.toolState = { ...this.state.toolState, ...validated.tools };
    if (validated.typography) this.state.typography = { ...this.state.typography, ...validated.typography };
    this.state.historyStack = [];
    this.state.historyIndex = -1;
    this.state.isDirty = false;
  }

  loadSessionAuto(data: unknown, filePath?: string): void {
    const version = detectSessionVersion(data);
    if (version === '2.0.0') {
      this.loadFromSessionDataV2(data as SessionDataV2, filePath);
    } else {
      this.loadFromSessionData(data as SessionData, filePath);
    }
  }
  
  toSessionData(): SessionData {
    return {
      version: '1.0.0',
      name: this.state.name,
      description: this.state.description || undefined,
      canvas: {
        width: this.state.width, height: this.state.height,
        canvasBackgroundColor: this.state.backgroundColor, showGrid: this.state.showGrid,
      },
      animation: {
        frames: this.state.frames.map(f => ({ id: f.id, name: f.name, duration: f.duration, data: f.data })),
        currentFrameIndex: this.state.currentFrameIndex,
        frameRate: this.state.frameRate, looping: this.state.looping,
      },
      tools: this.state.toolState,
      typography: this.state.typography,
    };
  }

  toSessionDataV2(): SessionDataV2 {
    return {
      version: '2.0.0',
      name: this.state.name,
      description: this.state.description || undefined,
      canvas: {
        width: this.state.width, height: this.state.height,
        canvasBackgroundColor: this.state.backgroundColor, showGrid: this.state.showGrid,
      },
      timeline: {
        frameRate: this.state.timelineConfig.frameRate,
        durationFrames: this.state.timelineConfig.durationFrames,
        looping: this.state.looping,
      },
      layers: this.state.layers.map(l => ({
        id: l.id, name: l.name, visible: l.visible, solo: l.solo, locked: l.locked, opacity: l.opacity,
        parentGroupId: l.parentGroupId, syncKeyframesToFrames: l.syncKeyframesToFrames,
        contentFrames: l.contentFrames.map(cf => ({
          id: cf.id, name: cf.name, startFrame: cf.startFrame, durationFrames: cf.durationFrames,
          data: cf.data, hidden: cf.hidden,
        })),
        propertyTracks: l.propertyTracks.map(pt => ({
          id: pt.id, propertyPath: pt.propertyPath, loopKeyframes: pt.loopKeyframes,
          keyframes: pt.keyframes.map(kf => ({ id: kf.id, frame: kf.frame, value: kf.value, easing: kf.easing })),
        })),
        staticProperties: l.staticProperties,
      })),
      layerGroups: this.state.layerGroups.map(g => ({
        id: g.id, name: g.name, childLayerIds: g.childLayerIds,
        visible: g.visible, solo: g.solo, locked: g.locked, collapsed: g.collapsed,
        propertyTracks: g.propertyTracks, staticProperties: g.staticProperties,
      })),
      tools: this.state.toolState,
      typography: this.state.typography,
    };
  }
  
  // ==========================================================================
  // Browser State Sync
  // ==========================================================================
  
  loadFromBrowserSnapshot(snapshot: unknown): void {
    const data = snapshot as {
      canvas?: { width: number; height: number; backgroundColor?: string };
      animation?: {
        frames: Array<{
          id: string; name: string; duration: number;
          data: Record<string, { char: string; color: string; bgColor: string }>;
        }>;
        currentFrameIndex: number;
      };
      project?: { name: string };
      layers?: MCPLayer[];
      layerGroups?: MCPLayerGroup[];
      timeline?: { frameRate: number; durationFrames: number; looping?: boolean };
      activeLayerId?: string;
    };
    if (!data) return;
    console.error('[state] Loading state from browser snapshot');
    if (data.canvas) {
      this.state.width = data.canvas.width ?? this.state.width;
      this.state.height = data.canvas.height ?? this.state.height;
      this.state.backgroundColor = data.canvas.backgroundColor ?? this.state.backgroundColor;
    }
    if (data.project?.name) this.state.name = data.project.name;
    if (data.layers && data.layers.length > 0) {
      this.state.layers = data.layers;
      this.state.layerGroups = data.layerGroups ?? [];
      this.state.activeLayerId = data.activeLayerId ?? data.layers[0]?.id ?? null;
      if (data.timeline) {
        this.state.timelineConfig = {
          frameRate: data.timeline.frameRate ?? 12,
          durationFrames: data.timeline.durationFrames ?? 12,
        };
        this.state.frameRate = this.state.timelineConfig.frameRate;
        this.state.looping = data.timeline.looping ?? true;
      }
      console.error(`[state] Loaded ${this.state.layers.length} layers from browser`);
      return;
    }
    if (data.animation?.frames && data.animation.frames.length > 0) {
      this.state.frames = data.animation.frames.map((frame, index) => ({
        id: frame.id || generateFrameId(),
        name: frame.name || `Frame ${index + 1}`,
        duration: frame.duration || 100,
        data: frame.data || {},
      }));
      this.state.currentFrameIndex = Math.min(data.animation.currentFrameIndex ?? 0, this.state.frames.length - 1);
      console.error(`[state] Loaded ${this.state.frames.length} frames from browser`);
    }
  }

  setFilePath(path: string): void { this.state.filePath = path; }
  markClean(): void { this.state.isDirty = false; }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let projectManager: ProjectStateManager | null = null;

export function getProjectManager(): ProjectStateManager {
  if (!projectManager) projectManager = new ProjectStateManager();
  return projectManager;
}

export function resetProjectManager(): void {
  projectManager = new ProjectStateManager();
}

// ============================================================================
// WebSocket Broadcaster
// ============================================================================

type BroadcasterFn = (type: string, data: unknown) => void;
let wsBroadcaster: BroadcasterFn | null = null;

export function setWebSocketBroadcaster(broadcaster: BroadcasterFn): void {
  wsBroadcaster = broadcaster;
}

export function broadcastStateChange(type: string, data: unknown): void {
  if (wsBroadcaster) wsBroadcaster(type, data);
}
