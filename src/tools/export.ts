/**
 * Export Tools
 * 
 * Tools for exporting ASCII art to various formats:
 * - Text (.txt)
 * - JSON (structured data)
 * - Session (.asciimtn project file)
 * - HTML (self-contained animation)
 * - React/Ink/Bubbletea (component code)
 * 
 * Image and video exports require canvas rendering which is deferred to Phase 3
 * when WebSocket browser sync is available.
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { parseCellKey } from '../types.js';

export function registerExportTools(server: McpServer): void {
  // ==========================================================================
  // export_text - Export as plain text
  // ==========================================================================
  server.tool(
    'export_text',
    'Export the current frame or all frames as plain text (.txt). Returns ASCII art as text.',
    {
      filePath: z.string().optional().describe('File path to save to (relative to project dir). If omitted, returns content only.'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current). Use "all" param for all frames.'),
      allFrames: z.boolean().default(false).describe('Export all frames with separators'),
      trimEmpty: z.boolean().default(true).describe('Remove leading/trailing empty rows and columns'),
      includeMetadata: z.boolean().default(false).describe('Include frame names and timing as comments'),
    },
    async ({ filePath, frameIndex, allFrames, trimEmpty, includeMetadata }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const framesToExport = allFrames 
        ? state.frames 
        : [state.frames[frameIndex ?? state.currentFrameIndex]];
      
      if (!framesToExport[0]) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }
      
      const textParts: string[] = [];
      
      for (let i = 0; i < framesToExport.length; i++) {
        const frame = framesToExport[i];
        
        if (includeMetadata && allFrames) {
          textParts.push(`# Frame ${i + 1}: ${frame.name} (${frame.duration}ms)`);
        }
        
        // Build text grid
        const lines = frameToTextLines(frame.data, state.width, state.height, trimEmpty);
        textParts.push(lines.join('\n'));
        
        if (allFrames && i < framesToExport.length - 1) {
          textParts.push('\n---\n');
        }
      }
      
      const content = textParts.join('\n');
      
      // Save to file if path provided
      if (filePath) {
        const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
        const fullPath = path.resolve(projectDir, filePath);
        
        // Security: ensure path is within project dir
        if (!fullPath.startsWith(projectDir)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
            isError: true,
          };
        }
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              filePath: fullPath,
              frameCount: framesToExport.length,
              bytes: Buffer.byteLength(content, 'utf-8'),
            }) 
          }],
        };
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            frameCount: framesToExport.length,
            content,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // export_json - Export as structured JSON
  // ==========================================================================
  server.tool(
    'export_json',
    'Export the project as structured JSON data. Good for programmatic processing.',
    {
      filePath: z.string().optional().describe('File path to save to (relative to project dir). If omitted, returns content only.'),
      includeMetadata: z.boolean().default(true).describe('Include project metadata'),
      humanReadable: z.boolean().default(true).describe('Pretty-print JSON'),
      includeEmptyCells: z.boolean().default(false).describe('Include cells with default values'),
    },
    async ({ filePath, includeMetadata, humanReadable, includeEmptyCells }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const exportData: Record<string, unknown> = {
        canvas: {
          width: state.width,
          height: state.height,
          backgroundColor: state.backgroundColor,
        },
        animation: {
          frameRate: state.frameRate,
          looping: state.looping,
          currentFrame: state.currentFrameIndex,
        },
        frames: state.frames.map((frame, index) => {
          const frameData: Record<string, unknown> = {
            index,
            name: frame.name,
            duration: frame.duration,
          };
          
          // Convert cell data to array format
          const cells: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
          
          for (const [key, cell] of Object.entries(frame.data)) {
            const { x, y } = parseCellKey(key);
            if (includeEmptyCells || cell.char !== ' ' || cell.bgColor !== 'transparent') {
              cells.push({ x, y, ...cell });
            }
          }
          
          // Sort for consistent output
          cells.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
          frameData.cells = cells;
          frameData.cellCount = cells.length;
          
          return frameData;
        }),
      };
      
      if (includeMetadata) {
        exportData.metadata = {
          exportedAt: new Date().toISOString(),
          projectName: state.name,
          version: '1.0.0',
          generator: 'ascii-motion-mcp',
        };
      }
      
      const content = humanReadable 
        ? JSON.stringify(exportData, null, 2)
        : JSON.stringify(exportData);
      
      // Save to file if path provided
      if (filePath) {
        const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
        const fullPath = path.resolve(projectDir, filePath);
        
        if (!fullPath.startsWith(projectDir)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
            isError: true,
          };
        }
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              filePath: fullPath,
              bytes: Buffer.byteLength(content, 'utf-8'),
            }) 
          }],
        };
      }
      
      // Return inline (may be large)
      return {
        content: [{ type: 'text', text: content }],
      };
    }
  );

  // ==========================================================================
  // export_session - Export as .asciimtn project file
  // ==========================================================================
  server.tool(
    'export_session',
    'Export the project as an .asciimtn session file (can be loaded by Ascii-Motion app).',
    {
      filePath: z.string().describe('File path for the .asciimtn file (relative to project dir)'),
    },
    async ({ filePath }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      // Build SessionData format matching the app's expected structure
      const sessionData = {
        version: '1.0.0',
        name: state.name,
        canvas: {
          width: state.width,
          height: state.height,
          canvasBackgroundColor: state.backgroundColor,
          showGrid: true,
        },
        animation: {
          frames: state.frames.map(frame => ({
            id: frame.id,
            name: frame.name,
            duration: frame.duration,
            // Convert to the app's expected format: Map serialized as object
            data: frame.data,
          })),
          currentFrameIndex: state.currentFrameIndex,
          frameRate: state.frameRate,
          looping: state.looping,
        },
        tools: {
          selectedColor: '#FFFFFF',
          selectedBgColor: 'transparent',
          selectedCharacter: '@',
        },
      };
      
      const content = JSON.stringify(sessionData, null, 2);
      
      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      let fullPath = path.resolve(projectDir, filePath);
      
      // Ensure .asciimtn extension
      if (!fullPath.endsWith('.asciimtn')) {
        fullPath += '.asciimtn';
      }
      
      if (!fullPath.startsWith(projectDir)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
          isError: true,
        };
      }
      
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            filePath: fullPath,
            frameCount: state.frames.length,
            bytes: Buffer.byteLength(content, 'utf-8'),
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // export_html - Export as self-contained HTML animation
  // ==========================================================================
  server.tool(
    'export_html',
    'Export the animation as a self-contained HTML file with embedded animation player.',
    {
      filePath: z.string().optional().describe('File path to save to. If omitted, returns HTML content.'),
      backgroundColor: z.string().default('#000000').describe('Background color'),
      fontFamily: z.enum(['monospace', 'courier', 'consolas']).default('monospace').describe('Font family'),
      fontSize: z.number().int().min(8).max(24).default(14).describe('Font size in pixels'),
      animationSpeed: z.number().min(0.1).max(5).default(1).describe('Animation speed multiplier'),
      loops: z.union([z.literal('infinite'), z.number().int().min(1)]).default('infinite').describe('Number of loops'),
      includeControls: z.boolean().default(true).describe('Include play/pause controls'),
    },
    async ({ filePath, backgroundColor, fontFamily, fontSize, animationSpeed, loops, includeControls }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      // Generate frame data as JavaScript array
      const framesJs = state.frames.map((frame, index) => {
        const lines = frameToHtmlLines(frame.data, state.width, state.height);
        return {
          index,
          name: frame.name,
          duration: Math.round(frame.duration / animationSpeed),
          html: lines,
        };
      });
      
      const html = generateHtmlAnimation({
        frames: framesJs,
        width: state.width,
        height: state.height,
        backgroundColor,
        fontFamily,
        fontSize,
        loops,
        includeControls,
        projectName: state.name,
      });
      
      if (filePath) {
        const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
        let fullPath = path.resolve(projectDir, filePath);
        
        if (!fullPath.endsWith('.html')) {
          fullPath += '.html';
        }
        
        if (!fullPath.startsWith(projectDir)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
            isError: true,
          };
        }
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, html, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              filePath: fullPath,
              frameCount: state.frames.length,
              bytes: Buffer.byteLength(html, 'utf-8'),
            }) 
          }],
        };
      }
      
      return {
        content: [{ type: 'text', text: html }],
      };
    }
  );

  // ==========================================================================
  // export_react - Export as React/TSX component
  // ==========================================================================
  server.tool(
    'export_react',
    'Export the animation as a React component (JSX or TSX).',
    {
      filePath: z.string().optional().describe('File path to save to'),
      typescript: z.boolean().default(true).describe('Use TypeScript (TSX)'),
      includeControls: z.boolean().default(true).describe('Include play/pause controls'),
      componentName: z.string().default('AsciiAnimation').describe('React component name'),
    },
    async ({ filePath, typescript, includeControls, componentName }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const code = generateReactComponent({
        frames: state.frames,
        width: state.width,
        height: state.height,
        typescript,
        includeControls,
        componentName,
        frameRate: state.frameRate,
        looping: state.looping,
      });
      
      if (filePath) {
        const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
        let fullPath = path.resolve(projectDir, filePath);
        
        const ext = typescript ? '.tsx' : '.jsx';
        if (!fullPath.endsWith(ext) && !fullPath.endsWith('.tsx') && !fullPath.endsWith('.jsx')) {
          fullPath += ext;
        }
        
        if (!fullPath.startsWith(projectDir)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
            isError: true,
          };
        }
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, code, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              filePath: fullPath,
              bytes: Buffer.byteLength(code, 'utf-8'),
            }) 
          }],
        };
      }
      
      return {
        content: [{ type: 'text', text: code }],
      };
    }
  );

  // ==========================================================================
  // export_ansi - Export with ANSI escape codes for terminal
  // ==========================================================================
  server.tool(
    'export_ansi',
    'Export the current frame with ANSI escape codes for terminal display.',
    {
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current)'),
      colorMode: z.enum(['16', '256', 'truecolor']).default('truecolor').describe('ANSI color mode'),
    },
    async ({ frameIndex, colorMode }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frame = state.frames[frameIndex ?? state.currentFrameIndex];
      if (!frame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }
      
      const ansi = frameToAnsi(frame.data, state.width, state.height, colorMode);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            ansi,
            colorMode,
            hint: 'Copy the ansi string and print it in a terminal that supports ANSI escape codes.',
          }) 
        }],
      };
    }
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

function frameToTextLines(
  data: Record<string, { char: string; color: string; bgColor: string }>,
  width: number,
  height: number,
  trimEmpty: boolean
): string[] {
  const lines: string[] = [];
  
  // Find bounding box if trimming
  let minX = width, maxX = 0, minY = height, maxY = 0;
  
  if (trimEmpty) {
    for (const key of Object.keys(data)) {
      const { x, y } = parseCellKey(key);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    
    // Handle empty canvas
    if (minX > maxX) {
      return [''];
    }
  } else {
    minX = 0;
    maxX = width - 1;
    minY = 0;
    maxY = height - 1;
  }
  
  for (let y = minY; y <= maxY; y++) {
    let line = '';
    for (let x = minX; x <= maxX; x++) {
      const cell = data[`${x},${y}`];
      line += cell?.char ?? ' ';
    }
    
    // Trim trailing spaces if requested
    if (trimEmpty) {
      line = line.trimEnd();
    }
    
    lines.push(line);
  }
  
  return lines;
}

function frameToHtmlLines(
  data: Record<string, { char: string; color: string; bgColor: string }>,
  width: number,
  height: number
): string[] {
  const lines: string[] = [];
  
  for (let y = 0; y < height; y++) {
    let line = '';
    let currentColor = '';
    let currentBg = '';
    let spanOpen = false;
    
    for (let x = 0; x < width; x++) {
      const cell = data[`${x},${y}`];
      const char = cell?.char ?? ' ';
      const color = cell?.color ?? '#FFFFFF';
      const bgColor = cell?.bgColor ?? 'transparent';
      
      // Check if we need a new span
      if (color !== currentColor || bgColor !== currentBg) {
        if (spanOpen) {
          line += '</span>';
        }
        
        const styles: string[] = [];
        if (color !== '#FFFFFF') {
          styles.push(`color:${color}`);
        }
        if (bgColor !== 'transparent') {
          styles.push(`background:${bgColor}`);
        }
        
        if (styles.length > 0) {
          line += `<span style="${styles.join(';')}">`;
          spanOpen = true;
        } else {
          spanOpen = false;
        }
        
        currentColor = color;
        currentBg = bgColor;
      }
      
      // Escape HTML entities
      const escaped = char
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/ /g, '&nbsp;');
      
      line += escaped;
    }
    
    if (spanOpen) {
      line += '</span>';
    }
    
    lines.push(line);
  }
  
  return lines;
}

function generateHtmlAnimation(options: {
  frames: Array<{ index: number; name: string; duration: number; html: string[] }>;
  width: number;
  height: number;
  backgroundColor: string;
  fontFamily: string;
  fontSize: number;
  loops: 'infinite' | number;
  includeControls: boolean;
  projectName: string;
}): string {
  const { frames, backgroundColor, fontFamily, fontSize, loops, includeControls, projectName } = options;
  
  const framesJson = JSON.stringify(frames.map(f => ({
    duration: f.duration,
    lines: f.html,
  })));
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName || 'ASCII Animation')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: ${backgroundColor};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: ${fontFamily}, monospace;
    }
    #canvas {
      font-family: ${fontFamily}, monospace;
      font-size: ${fontSize}px;
      line-height: 1.2;
      white-space: pre;
      color: #FFFFFF;
    }
    ${includeControls ? `
    #controls {
      margin-top: 20px;
    }
    button {
      padding: 8px 16px;
      margin: 0 4px;
      font-size: 14px;
      cursor: pointer;
    }
    ` : ''}
  </style>
</head>
<body>
  <div id="canvas"></div>
  ${includeControls ? '<div id="controls"><button id="playPause">Pause</button><button id="restart">Restart</button></div>' : ''}
  <script>
    const frames = ${framesJson};
    const canvas = document.getElementById('canvas');
    let currentFrame = 0;
    let playing = true;
    let loopsRemaining = ${loops === 'infinite' ? 'Infinity' : loops};
    let timeout;
    
    function render() {
      const frame = frames[currentFrame];
      canvas.innerHTML = frame.lines.join('<br>');
    }
    
    function next() {
      if (!playing) return;
      render();
      currentFrame++;
      if (currentFrame >= frames.length) {
        currentFrame = 0;
        if (loopsRemaining !== Infinity) {
          loopsRemaining--;
          if (loopsRemaining <= 0) {
            playing = false;
            return;
          }
        }
      }
      timeout = setTimeout(next, frames[currentFrame - 1]?.duration || 100);
    }
    
    ${includeControls ? `
    document.getElementById('playPause').onclick = () => {
      playing = !playing;
      document.getElementById('playPause').textContent = playing ? 'Pause' : 'Play';
      if (playing) next();
    };
    document.getElementById('restart').onclick = () => {
      currentFrame = 0;
      loopsRemaining = ${loops === 'infinite' ? 'Infinity' : loops};
      playing = true;
      document.getElementById('playPause').textContent = 'Pause';
      clearTimeout(timeout);
      next();
    };
    ` : ''}
    
    next();
  </script>
</body>
</html>`;
}

function generateReactComponent(options: {
  frames: Array<{ id: string; name: string; duration: number; data: Record<string, { char: string; color: string; bgColor: string }> }>;
  width: number;
  height: number;
  typescript: boolean;
  includeControls: boolean;
  componentName: string;
  frameRate: number;
  looping: boolean;
}): string {
  const { frames, width, height, typescript, includeControls, componentName, looping } = options;
  
  // Pre-render frames to simple text for embedding
  const frameData = frames.map(frame => ({
    duration: frame.duration,
    lines: frameToTextLines(frame.data, width, height, false),
  }));
  
  const ts = typescript;
  
  return `${ts ? `import React, { useState, useEffect, useCallback } from 'react';

interface ${componentName}Props {
  autoPlay?: boolean;
  loop?: boolean;
  className?: string;
}

` : `import React, { useState, useEffect, useCallback } from 'react';

`}const frames = ${JSON.stringify(frameData, null, 2)};

${ts ? `export const ${componentName}: React.FC<${componentName}Props> = ({` : `export const ${componentName} = ({`}
  autoPlay = true,
  loop = ${looping},
  className = '',
}) => {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);

  useEffect(() => {
    if (!isPlaying) return;
    
    const frame = frames[currentFrame];
    const timer = setTimeout(() => {
      setCurrentFrame(prev => {
        const next = prev + 1;
        if (next >= frames.length) {
          if (loop) return 0;
          setIsPlaying(false);
          return prev;
        }
        return next;
      });
    }, frame.duration);
    
    return () => clearTimeout(timer);
  }, [currentFrame, isPlaying, loop]);

  const handlePlayPause = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const handleRestart = useCallback(() => {
    setCurrentFrame(0);
    setIsPlaying(true);
  }, []);

  const frame = frames[currentFrame];

  return (
    <div className={className}>
      <pre style={{ fontFamily: 'monospace', lineHeight: 1.2 }}>
        {frame.lines.join('\\n')}
      </pre>
      ${includeControls ? `<div>
        <button onClick={handlePlayPause}>{isPlaying ? 'Pause' : 'Play'}</button>
        <button onClick={handleRestart}>Restart</button>
      </div>` : ''}
    </div>
  );
};

export default ${componentName};
`;
}

function frameToAnsi(
  data: Record<string, { char: string; color: string; bgColor: string }>,
  width: number,
  height: number,
  colorMode: '16' | '256' | 'truecolor'
): string {
  const lines: string[] = [];
  const RESET = '\x1b[0m';
  
  for (let y = 0; y < height; y++) {
    let line = '';
    
    for (let x = 0; x < width; x++) {
      const cell = data[`${x},${y}`];
      const char = cell?.char ?? ' ';
      const color = cell?.color ?? '#FFFFFF';
      const bgColor = cell?.bgColor ?? 'transparent';
      
      let colorCode = '';
      
      if (colorMode === 'truecolor') {
        // 24-bit true color
        const fg = hexToRgb(color);
        colorCode += `\x1b[38;2;${fg.r};${fg.g};${fg.b}m`;
        
        if (bgColor !== 'transparent') {
          const bg = hexToRgb(bgColor);
          colorCode += `\x1b[48;2;${bg.r};${bg.g};${bg.b}m`;
        }
      } else if (colorMode === '256') {
        // 256-color mode (approximate)
        colorCode += `\x1b[38;5;${hexTo256(color)}m`;
        if (bgColor !== 'transparent') {
          colorCode += `\x1b[48;5;${hexTo256(bgColor)}m`;
        }
      } else {
        // 16-color ANSI
        colorCode += `\x1b[${hexTo16Fg(color)}m`;
        if (bgColor !== 'transparent') {
          colorCode += `\x1b[${hexTo16Bg(bgColor)}m`;
        }
      }
      
      line += colorCode + char + RESET;
    }
    
    lines.push(line);
  }
  
  return lines.join('\n');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 255, g: 255, b: 255 };
}

function hexTo256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  // Approximate to 256-color palette (16-231 are 6x6x6 color cube)
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

function hexTo16Fg(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const brightness = (r + g + b) / 3;
  const isBright = brightness > 127;
  
  // Simple mapping to 16 ANSI colors
  if (r > 200 && g < 100 && b < 100) return isBright ? 91 : 31; // Red
  if (r < 100 && g > 200 && b < 100) return isBright ? 92 : 32; // Green
  if (r > 200 && g > 200 && b < 100) return isBright ? 93 : 33; // Yellow
  if (r < 100 && g < 100 && b > 200) return isBright ? 94 : 34; // Blue
  if (r > 200 && g < 100 && b > 200) return isBright ? 95 : 35; // Magenta
  if (r < 100 && g > 200 && b > 200) return isBright ? 96 : 36; // Cyan
  if (brightness > 200) return 97; // White
  if (brightness < 50) return 30; // Black
  return isBright ? 37 : 90; // Gray
}

function hexTo16Bg(hex: string): number {
  // Background colors are foreground + 10
  return hexTo16Fg(hex) + 10;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
