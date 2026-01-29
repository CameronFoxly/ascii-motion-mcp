/**
 * Project State Manager
 * 
 * Manages the in-memory state for an Ascii-Motion project.
 * This is the central data store that all tools operate on.
 */

import {
  type Cell,
  type Frame,
  type CanvasData,
  type SessionData,
  type Selection,
  type ToolState,
  type TypographySettings,
  EMPTY_CELL,
  createCellKey,
  parseCellKey,
  isInBounds,
  generateFrameId,
  
  recordToMap,
  SessionDataSchema,
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
  
  // Animation
  frames: Frame[];
  currentFrameIndex: number;
  frameRate: number;
  looping: boolean;
  
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
  
  getCurrentFrame(): Frame {
    return this.state.frames[this.state.currentFrameIndex];
  }
  
  getCurrentFrameData(): Map<string, Cell> {
    return recordToMap(this.getCurrentFrame().data);
  }
  
  // ==========================================================================
  // Canvas Operations
  // ==========================================================================
  
  getCell(x: number, y: number): Cell {
    if (!isInBounds(x, y, this.state.width, this.state.height)) {
      return EMPTY_CELL;
    }
    const key = createCellKey(x, y);
    const frame = this.getCurrentFrame();
    return frame.data[key] ?? EMPTY_CELL;
  }
  
  setCell(x: number, y: number, cell: Cell, recordHistory = true): boolean {
    if (!isInBounds(x, y, this.state.width, this.state.height)) {
      return false;
    }
    
    const key = createCellKey(x, y);
    const frame = this.getCurrentFrame();
    const previousCell = frame.data[key];
    
    if (recordHistory) {
      this.pushHistory({
        type: 'set_cell',
        description: `Set cell at (${x}, ${y})`,
        timestamp: Date.now(),
        undo: () => {
          if (previousCell) {
            frame.data[key] = previousCell;
          } else {
            delete frame.data[key];
          }
        },
        redo: () => {
          if (cell.char === ' ' && cell.color === '#FFFFFF' && cell.bgColor === 'transparent') {
            delete frame.data[key];
          } else {
            frame.data[key] = { ...cell };
          }
        },
      });
    }
    
    // Set the cell (or remove if empty)
    if (cell.char === ' ' && cell.color === '#FFFFFF' && cell.bgColor === 'transparent') {
      delete frame.data[key];
    } else {
      frame.data[key] = { ...cell };
    }
    
    this.state.isDirty = true;
    return true;
  }
  
  setCells(cells: Array<{ x: number; y: number; cell: Cell }>, recordHistory = true): number {
    const frame = this.getCurrentFrame();
    const previousData = { ...frame.data };
    let count = 0;
    
    for (const { x, y, cell } of cells) {
      if (!isInBounds(x, y, this.state.width, this.state.height)) {
        continue;
      }
      
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
        undo: () => {
          frame.data = previousData;
        },
        redo: () => {
          frame.data = newData;
        },
      });
    }
    
    if (count > 0) {
      this.state.isDirty = true;
    }
    
    return count;
  }
  
  clearCell(x: number, y: number, recordHistory = true): boolean {
    return this.setCell(x, y, EMPTY_CELL, recordHistory);
  }
  
  clearCanvas(recordHistory = true): void {
    const frame = this.getCurrentFrame();
    const previousData = { ...frame.data };
    
    if (recordHistory) {
      this.pushHistory({
        type: 'clear_canvas',
        description: 'Clear canvas',
        timestamp: Date.now(),
        undo: () => {
          frame.data = previousData;
        },
        redo: () => {
          frame.data = {};
        },
      });
    }
    
    frame.data = {};
    this.state.isDirty = true;
  }
  
  resizeCanvas(width: number, height: number, recordHistory = true): void {
    const previousWidth = this.state.width;
    const previousHeight = this.state.height;
    
    // Clamp values
    width = Math.max(4, Math.min(200, width));
    height = Math.max(4, Math.min(100, height));
    
    // Store previous frame data for all frames
    const previousFrameData = this.state.frames.map(f => ({ ...f.data }));
    
    if (recordHistory) {
      this.pushHistory({
        type: 'resize_canvas',
        description: `Resize canvas to ${width}x${height}`,
        timestamp: Date.now(),
        undo: () => {
          this.state.width = previousWidth;
          this.state.height = previousHeight;
          this.state.frames.forEach((frame, i) => {
            frame.data = previousFrameData[i];
          });
        },
        redo: () => {
          this.state.width = width;
          this.state.height = height;
          // Clip cells outside new bounds
          this.state.frames.forEach(frame => {
            const newData: CanvasData = {};
            Object.entries(frame.data).forEach(([key, cell]) => {
              const { x, y } = parseCellKey(key);
              if (x < width && y < height) {
                newData[key] = cell;
              }
            });
            frame.data = newData;
          });
        },
      });
    }
    
    this.state.width = width;
    this.state.height = height;
    
    // Clip cells outside new bounds
    this.state.frames.forEach(frame => {
      const newData: CanvasData = {};
      Object.entries(frame.data).forEach(([key, cell]) => {
        const { x, y } = parseCellKey(key);
        if (x < width && y < height) {
          newData[key] = cell;
        }
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
    
    const frame = this.getCurrentFrame();
    const previousData = { ...frame.data };
    const targetCell = this.getCell(startX, startY);
    
    const matches = (cell: Cell): boolean => {
      if (matchChar && cell.char !== targetCell.char) return false;
      if (matchColor && cell.color !== targetCell.color) return false;
      if (matchBgColor && cell.bgColor !== targetCell.bgColor) return false;
      return true;
    };
    
    const cellsToFill: Set<string> = new Set();
    
    if (contiguous) {
      // Flood fill
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
        
        // Add neighbors
        queue.push({ x: x - 1, y });
        queue.push({ x: x + 1, y });
        queue.push({ x, y: y - 1 });
        queue.push({ x, y: y + 1 });
      }
    } else {
      // Fill all matching cells
      for (let y = 0; y < this.state.height; y++) {
        for (let x = 0; x < this.state.width; x++) {
          const currentCell = this.getCell(x, y);
          if (matches(currentCell)) {
            cellsToFill.add(createCellKey(x, y));
          }
        }
      }
    }
    
    // Apply fill
    for (const key of cellsToFill) {
      if (fillCell.char === ' ' && fillCell.color === '#FFFFFF' && fillCell.bgColor === 'transparent') {
        delete frame.data[key];
      } else {
        frame.data[key] = { ...fillCell };
      }
    }
    
    if (recordHistory && cellsToFill.size > 0) {
      const newData = { ...frame.data };
      this.pushHistory({
        type: 'fill_region',
        description: `Fill ${cellsToFill.size} cells`,
        timestamp: Date.now(),
        undo: () => {
          frame.data = previousData;
        },
        redo: () => {
          frame.data = newData;
        },
      });
    }
    
    if (cellsToFill.size > 0) {
      this.state.isDirty = true;
    }
    
    return cellsToFill.size;
  }
  
  // ==========================================================================
  // Frame Operations
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
          if (this.state.currentFrameIndex >= this.state.frames.length) {
            this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
          }
        },
        redo: () => {
          this.state.frames.splice(insertIndex, 0, newFrame);
        },
      });
    }
    
    this.state.frames.splice(insertIndex, 0, newFrame);
    this.state.isDirty = true;
    
    return newFrame;
  }
  
  deleteFrame(index: number, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) {
      return false;
    }
    
    // Don't allow deleting the last frame
    if (this.state.frames.length === 1) {
      return false;
    }
    
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
          if (this.state.currentFrameIndex >= this.state.frames.length) {
            this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
          }
        },
      });
    }
    
    this.state.frames.splice(index, 1);
    
    if (this.state.currentFrameIndex >= this.state.frames.length) {
      this.state.currentFrameIndex = Math.max(0, this.state.frames.length - 1);
    }
    
    this.state.isDirty = true;
    return true;
  }
  
  duplicateFrame(index: number, recordHistory = true): Frame | null {
    if (index < 0 || index >= this.state.frames.length) {
      return null;
    }
    
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
        undo: () => {
          this.state.frames.splice(insertIndex, 1);
        },
        redo: () => {
          this.state.frames.splice(insertIndex, 0, newFrame);
        },
      });
    }
    
    this.state.frames.splice(insertIndex, 0, newFrame);
    this.state.isDirty = true;
    
    return newFrame;
  }
  
  goToFrame(index: number): boolean {
    if (index < 0 || index >= this.state.frames.length) {
      return false;
    }
    
    this.state.currentFrameIndex = index;
    return true;
  }
  
  setFrameDuration(index: number, duration: number, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) {
      return false;
    }
    
    duration = Math.max(10, Math.min(60000, duration));
    
    const frame = this.state.frames[index];
    const previousDuration = frame.duration;
    
    if (recordHistory) {
      this.pushHistory({
        type: 'set_frame_duration',
        description: `Set frame ${index} duration to ${duration}ms`,
        timestamp: Date.now(),
        undo: () => {
          frame.duration = previousDuration;
        },
        redo: () => {
          frame.duration = duration;
        },
      });
    }
    
    frame.duration = duration;
    this.state.isDirty = true;
    return true;
  }
  
  setFrameName(index: number, name: string, recordHistory = true): boolean {
    if (index < 0 || index >= this.state.frames.length) {
      return false;
    }
    
    const frame = this.state.frames[index];
    const previousName = frame.name;
    
    if (recordHistory) {
      this.pushHistory({
        type: 'set_frame_name',
        description: `Rename frame ${index} to "${name}"`,
        timestamp: Date.now(),
        undo: () => {
          frame.name = previousName;
        },
        redo: () => {
          frame.name = name;
        },
      });
    }
    
    frame.name = name;
    this.state.isDirty = true;
    return true;
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
    // Remove any redo history beyond current index
    if (this.state.historyIndex < this.state.historyStack.length - 1) {
      this.state.historyStack = this.state.historyStack.slice(0, this.state.historyIndex + 1);
    }
    
    // Add new entry
    this.state.historyStack.push(entry);
    this.state.historyIndex = this.state.historyStack.length - 1;
    
    // Trim if over max size
    if (this.state.historyStack.length > this.state.maxHistorySize) {
      this.state.historyStack.shift();
      this.state.historyIndex--;
    }
  }
  
  undo(): boolean {
    if (this.state.historyIndex < 0) {
      return false;
    }
    
    const entry = this.state.historyStack[this.state.historyIndex];
    entry.undo();
    this.state.historyIndex--;
    this.state.isDirty = true;
    
    return true;
  }
  
  redo(): boolean {
    if (this.state.historyIndex >= this.state.historyStack.length - 1) {
      return false;
    }
    
    this.state.historyIndex++;
    const entry = this.state.historyStack[this.state.historyIndex];
    entry.redo();
    this.state.isDirty = true;
    
    return true;
  }
  
  canUndo(): boolean {
    return this.state.historyIndex >= 0;
  }
  
  canRedo(): boolean {
    return this.state.historyIndex < this.state.historyStack.length - 1;
  }
  
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
    
    if (options?.width) {
      this.state.width = Math.max(4, Math.min(200, options.width));
    }
    if (options?.height) {
      this.state.height = Math.max(4, Math.min(100, options.height));
    }
    if (options?.name) {
      this.state.name = options.name;
    }
    
    this.state.isDirty = false;
  }
  
  loadFromSessionData(data: SessionData, filePath?: string): void {
    // Validate
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
    
    if (this.state.frames.length === 0) {
      this.state.frames = [createDefaultFrame()];
    }
    
    this.state.currentFrameIndex = Math.min(
      validated.animation.currentFrameIndex,
      this.state.frames.length - 1
    );
    this.state.frameRate = validated.animation.frameRate ?? 12;
    this.state.looping = validated.animation.looping ?? true;
    
    if (validated.tools) {
      this.state.toolState = { ...this.state.toolState, ...validated.tools };
    }
    
    if (validated.typography) {
      this.state.typography = { ...this.state.typography, ...validated.typography };
    }
    
    this.state.historyStack = [];
    this.state.historyIndex = -1;
    this.state.isDirty = false;
  }
  
  toSessionData(): SessionData {
    return {
      version: '1.0.0',
      name: this.state.name,
      description: this.state.description || undefined,
      
      canvas: {
        width: this.state.width,
        height: this.state.height,
        canvasBackgroundColor: this.state.backgroundColor,
        showGrid: this.state.showGrid,
      },
      
      animation: {
        frames: this.state.frames.map(f => ({
          id: f.id,
          name: f.name,
          duration: f.duration,
          data: f.data,
        })),
        currentFrameIndex: this.state.currentFrameIndex,
        frameRate: this.state.frameRate,
        looping: this.state.looping,
      },
      
      tools: this.state.toolState,
      typography: this.state.typography,
    };
  }
  
  setFilePath(path: string): void {
    this.state.filePath = path;
  }
  
  markClean(): void {
    this.state.isDirty = false;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let projectManager: ProjectStateManager | null = null;

export function getProjectManager(): ProjectStateManager {
  if (!projectManager) {
    projectManager = new ProjectStateManager();
  }
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
  if (wsBroadcaster) {
    wsBroadcaster(type, data);
  }
}
