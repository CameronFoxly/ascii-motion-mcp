/**
 * Additional Export Tools - Ink, Bubbletea, OpenTUI, Image, Video
 * These get merged into export.ts
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { Frame } from '../types.js';

export function registerAdditionalExportTools(server: McpServer): void {
  // ==========================================================================
  // export_ink - Export as Ink (React-like CLI) component
  // ==========================================================================
  server.tool(
    'export_ink',
    'Export the current frame as an Ink (React CLI) component for Node.js terminal apps.',
    {
      filePath: z.string().optional().describe('File path to save (.tsx file). If omitted, returns content only.'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current)'),
      componentName: z.string().default('AsciiArt').describe('Name for the component'),
      includeAnimation: z.boolean().default(false).describe('Export all frames with animation support'),
    },
    async ({ filePath, frameIndex, componentName, includeAnimation }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frames = includeAnimation 
        ? state.frames 
        : [state.frames[frameIndex ?? state.currentFrameIndex]];
      
      if (!frames[0]) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }

      const code = generateInkComponent(componentName, frames, state.width, state.height, includeAnimation);
      
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
        await fs.writeFile(fullPath, code, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ success: true, filePath: fullPath, bytes: Buffer.byteLength(code) }) 
          }],
        };
      }
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ code, componentName }) }],
      };
    }
  );

  // ==========================================================================
  // export_bubbletea - Export as Bubbletea (Go) component
  // ==========================================================================
  server.tool(
    'export_bubbletea',
    'Export the current frame as a Bubbletea (Go TUI) component.',
    {
      filePath: z.string().optional().describe('File path to save (.go file). If omitted, returns content only.'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current)'),
      packageName: z.string().default('ascii').describe('Go package name'),
      modelName: z.string().default('AsciiModel').describe('Name for the Bubbletea model'),
      includeAnimation: z.boolean().default(false).describe('Export all frames with animation support'),
    },
    async ({ filePath, frameIndex, packageName, modelName, includeAnimation }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frames = includeAnimation 
        ? state.frames 
        : [state.frames[frameIndex ?? state.currentFrameIndex]];
      
      if (!frames[0]) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }

      const code = generateBubbleteaComponent(packageName, modelName, frames, state.width, state.height, includeAnimation);
      
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
        await fs.writeFile(fullPath, code, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ success: true, filePath: fullPath, bytes: Buffer.byteLength(code) }) 
          }],
        };
      }
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ code, packageName, modelName }) }],
      };
    }
  );

  // ==========================================================================
  // export_opentui - Export as OpenTUI (Python) component
  // ==========================================================================
  server.tool(
    'export_opentui',
    'Export the current frame as an OpenTUI (Python TUI) component.',
    {
      filePath: z.string().optional().describe('File path to save (.py file). If omitted, returns content only.'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current)'),
      className: z.string().default('AsciiDisplay').describe('Name for the Python class'),
      includeAnimation: z.boolean().default(false).describe('Export all frames with animation support'),
    },
    async ({ filePath, frameIndex, className, includeAnimation }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frames = includeAnimation 
        ? state.frames 
        : [state.frames[frameIndex ?? state.currentFrameIndex]];
      
      if (!frames[0]) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }

      const code = generateOpenTuiComponent(className, frames, state.width, state.height, includeAnimation);
      
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
        await fs.writeFile(fullPath, code, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ success: true, filePath: fullPath, bytes: Buffer.byteLength(code) }) 
          }],
        };
      }
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ code, className }) }],
      };
    }
  );

  // ==========================================================================
  // export_image - Export as PNG/JPG/SVG image
  // ==========================================================================
  server.tool(
    'export_image',
    'Export the current frame as a PNG, JPG, or SVG image. Note: PNG/JPG require the canvas library; SVG works without dependencies.',
    {
      filePath: z.string().describe('File path to save (extension determines format: .png, .jpg, .svg)'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current)'),
      scale: z.number().default(1).describe('Scale factor (1 = 10px per cell)'),
      fontFamily: z.string().default('monospace').describe('Font family for rendering'),
      fontSize: z.number().default(12).describe('Font size in pixels'),
      cellWidth: z.number().default(10).describe('Width of each cell in pixels'),
      cellHeight: z.number().default(16).describe('Height of each cell in pixels'),
    },
    async ({ filePath, frameIndex, scale, fontFamily, fontSize, cellWidth, cellHeight }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frame = state.frames[frameIndex ?? state.currentFrameIndex];
      if (!frame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }

      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      const fullPath = path.resolve(projectDir, filePath);
      
      if (!fullPath.startsWith(projectDir)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
          isError: true,
        };
      }

      const ext = path.extname(filePath).toLowerCase();
      
      if (ext === '.svg') {
        // SVG export - works without dependencies
        const svg = generateSvgImage(
          frame.data, 
          state.width, 
          state.height, 
          state.backgroundColor,
          scale,
          fontFamily,
          fontSize,
          cellWidth,
          cellHeight
        );
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, svg, 'utf-8');
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              filePath: fullPath, 
              format: 'svg',
              width: state.width * cellWidth * scale,
              height: state.height * cellHeight * scale,
            }) 
          }],
        };
      } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        // PNG/JPG requires canvas library
        try {
          // Dynamic import to avoid hard dependency
          // @ts-ignore - optional dependency
          const { createCanvas } = await import('canvas');
          
          const width = state.width * cellWidth * scale;
          const height = state.height * cellHeight * scale;
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext('2d');
          
          // Fill background
          ctx.fillStyle = state.backgroundColor || '#1a1a2e';
          ctx.fillRect(0, 0, width, height);
          
          // Set font
          ctx.font = `${fontSize * scale}px ${fontFamily}`;
          ctx.textBaseline = 'top';
          
          // Render each cell
          for (let y = 0; y < state.height; y++) {
            for (let x = 0; x < state.width; x++) {
              const cell = frame.data[`${x},${y}`];
              if (cell) {
                const px = x * cellWidth * scale;
                const py = y * cellHeight * scale;
                
                // Draw background
                if (cell.bgColor && cell.bgColor !== 'transparent') {
                  ctx.fillStyle = cell.bgColor;
                  ctx.fillRect(px, py, cellWidth * scale, cellHeight * scale);
                }
                
                // Draw character
                ctx.fillStyle = cell.color;
                ctx.fillText(cell.char, px + 1, py + 2);
              }
            }
          }
          
          // Export as buffer
          const buffer = ext === '.png' 
            ? canvas.toBuffer('image/png')
            : canvas.toBuffer('image/jpeg', { quality: 0.9 });
          
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, buffer);
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                success: true, 
                filePath: fullPath, 
                format: ext.slice(1),
                width,
                height,
              }) 
            }],
          };
        } catch (_e) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                error: 'PNG/JPG export requires the "canvas" npm package. Install with: npm install canvas',
                suggestion: 'Use .svg export which works without dependencies.',
              }) 
            }],
            isError: true,
          };
        }
      } else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unsupported format: ${ext}. Use .png, .jpg, or .svg` }) }],
          isError: true,
        };
      }
    }
  );

  // ==========================================================================
  // export_video - Export animation as video (MP4/WebM/GIF)
  // ==========================================================================
  server.tool(
    'export_video',
    'Export the animation as an MP4, WebM, or GIF video. Requires ffmpeg for MP4/WebM, gif-encoder for GIF.',
    {
      filePath: z.string().describe('File path to save (extension determines format: .mp4, .webm, .gif)'),
      scale: z.number().default(1).describe('Scale factor (1 = 10px per cell)'),
      fontFamily: z.string().default('monospace').describe('Font family for rendering'),
      fontSize: z.number().default(12).describe('Font size in pixels'),
      cellWidth: z.number().default(10).describe('Width of each cell in pixels'),
      cellHeight: z.number().default(16).describe('Height of each cell in pixels'),
      loop: z.boolean().default(true).describe('Whether animation should loop (for GIF)'),
    },
    async ({ filePath, scale, fontFamily, fontSize, cellWidth, cellHeight, loop }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (state.frames.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No frames to export' }) }],
          isError: true,
        };
      }

      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      const fullPath = path.resolve(projectDir, filePath);
      
      if (!fullPath.startsWith(projectDir)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
          isError: true,
        };
      }

      const ext = path.extname(filePath).toLowerCase();
      const width = state.width * cellWidth * scale;
      const height = state.height * cellHeight * scale;
      
      if (ext === '.gif') {
        // GIF export using gif-encoder-2 (if available)
        try {
          // @ts-ignore - optional dependency
          const { createCanvas } = await import('canvas');
          // @ts-ignore - optional dependency
          const GIFEncoder = (await import('gif-encoder-2')).default;
          
          const encoder = new GIFEncoder(width, height);
          encoder.setDelay(state.frames[0].duration);
          encoder.setRepeat(loop ? 0 : -1);
          encoder.start();
          
          for (const frame of state.frames) {
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d');
            
            // Fill background
            ctx.fillStyle = state.backgroundColor || '#1a1a2e';
            ctx.fillRect(0, 0, width, height);
            
            // Set font
            ctx.font = `${fontSize * scale}px ${fontFamily}`;
            ctx.textBaseline = 'top';
            
            // Render each cell
            for (let y = 0; y < state.height; y++) {
              for (let x = 0; x < state.width; x++) {
                const cell = frame.data[`${x},${y}`];
                if (cell) {
                  const px = x * cellWidth * scale;
                  const py = y * cellHeight * scale;
                  
                  if (cell.bgColor && cell.bgColor !== 'transparent') {
                    ctx.fillStyle = cell.bgColor;
                    ctx.fillRect(px, py, cellWidth * scale, cellHeight * scale);
                  }
                  
                  ctx.fillStyle = cell.color;
                  ctx.fillText(cell.char, px + 1, py + 2);
                }
              }
            }
            
            encoder.setDelay(frame.duration);
            encoder.addFrame(ctx);
          }
          
          encoder.finish();
          const buffer = encoder.out.getData();
          
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, buffer);
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                success: true, 
                filePath: fullPath, 
                format: 'gif',
                width,
                height,
                frameCount: state.frames.length,
                totalDuration: state.frames.reduce((sum, f) => sum + f.duration, 0),
              }) 
            }],
          };
        } catch (_e) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                error: 'GIF export requires "canvas" and "gif-encoder-2" packages. Install with: npm install canvas gif-encoder-2',
              }) 
            }],
            isError: true,
          };
        }
      } else if (ext === '.mp4' || ext === '.webm') {
        // MP4/WebM requires ffmpeg - generate frame images and use ffmpeg
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              error: 'MP4/WebM export requires ffmpeg which is not yet integrated.',
              suggestion: 'Use .gif export, or export as SVG frames and use ffmpeg manually.',
              ffmpegHint: 'ffmpeg -framerate 10 -i frame%03d.png -c:v libx264 -pix_fmt yuv420p output.mp4',
            }) 
          }],
          isError: true,
        };
      } else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unsupported format: ${ext}. Use .mp4, .webm, or .gif` }) }],
          isError: true,
        };
      }
    }
  );
}

// =============================================================================
// Helper Functions for Additional Exports
// =============================================================================

function generateInkComponent(
  componentName: string, 
  frames: Frame[], 
  width: number, 
  height: number, 
  includeAnimation: boolean
): string {
  const lines: string[] = [];
  
  lines.push(`import React${includeAnimation ? ', { useState, useEffect }' : ''} from 'react';`);
  lines.push(`import { Box, Text } from 'ink';`);
  lines.push('');
  
  // Generate frame data
  if (includeAnimation) {
    lines.push(`const frames = ${JSON.stringify(frames.map(f => ({
      data: f.data,
      duration: f.duration,
    })), null, 2)};`);
    lines.push('');
  } else {
    lines.push(`const frameData = ${JSON.stringify(frames[0].data, null, 2)};`);
    lines.push('');
  }
  
  lines.push(`export const ${componentName}: React.FC = () => {`);
  
  if (includeAnimation) {
    lines.push('  const [frameIndex, setFrameIndex] = useState(0);');
    lines.push('');
    lines.push('  useEffect(() => {');
    lines.push('    const timer = setTimeout(() => {');
    lines.push('      setFrameIndex((prev) => (prev + 1) % frames.length);');
    lines.push('    }, frames[frameIndex].duration);');
    lines.push('    return () => clearTimeout(timer);');
    lines.push('  }, [frameIndex]);');
    lines.push('');
    lines.push('  const currentFrame = frames[frameIndex].data;');
  } else {
    lines.push('  const currentFrame = frameData;');
  }
  
  lines.push('');
  lines.push('  const rows = [];');
  lines.push(`  for (let y = 0; y < ${height}; y++) {`);
  lines.push('    const cells = [];');
  lines.push(`    for (let x = 0; x < ${width}; x++) {`);
  lines.push('      const cell = currentFrame[`${x},${y}`];');
  lines.push('      if (cell) {');
  lines.push('        cells.push(');
  lines.push('          <Text key={x} color={cell.color} backgroundColor={cell.bgColor}>');
  lines.push('            {cell.char}');
  lines.push('          </Text>');
  lines.push('        );');
  lines.push('      } else {');
  lines.push('        cells.push(<Text key={x}> </Text>);');
  lines.push('      }');
  lines.push('    }');
  lines.push('    rows.push(<Box key={y}>{cells}</Box>);');
  lines.push('  }');
  lines.push('');
  lines.push('  return <Box flexDirection="column">{rows}</Box>;');
  lines.push('};');
  lines.push('');
  lines.push(`export default ${componentName};`);
  
  return lines.join('\n');
}

function generateBubbleteaComponent(
  packageName: string,
  modelName: string,
  frames: Frame[],
  width: number,
  height: number,
  includeAnimation: boolean
): string {
  const lines: string[] = [];
  
  lines.push(`package ${packageName}`);
  lines.push('');
  lines.push('import (');
  if (includeAnimation) {
    lines.push('\t"time"');
  }
  lines.push('\t"strings"');
  lines.push('');
  lines.push('\ttea "github.com/charmbracelet/bubbletea"');
  lines.push('\t"github.com/charmbracelet/lipgloss"');
  lines.push(')');
  lines.push('');
  
  // Generate cell and frame types
  lines.push('type Cell struct {');
  lines.push('\tChar    string');
  lines.push('\tColor   string');
  lines.push('\tBgColor string');
  lines.push('}');
  lines.push('');
  
  if (includeAnimation) {
    lines.push('type Frame struct {');
    lines.push('\tData     map[string]Cell');
    lines.push('\tDuration time.Duration');
    lines.push('}');
    lines.push('');
    
    lines.push('type tickMsg time.Time');
    lines.push('');
  }
  
  // Generate model
  lines.push(`type ${modelName} struct {`);
  lines.push(`\tWidth  int`);
  lines.push(`\tHeight int`);
  if (includeAnimation) {
    lines.push('\tFrames     []Frame');
    lines.push('\tFrameIndex int');
  } else {
    lines.push('\tData map[string]Cell');
  }
  lines.push('}');
  lines.push('');
  
  // Generate constructor
  lines.push(`func New${modelName}() ${modelName} {`);
  lines.push(`\treturn ${modelName}{`);
  lines.push(`\t\tWidth:  ${width},`);
  lines.push(`\t\tHeight: ${height},`);
  
  if (includeAnimation) {
    lines.push('\t\tFrames: []Frame{');
    for (const frame of frames) {
      lines.push('\t\t\t{');
      lines.push('\t\t\t\tData: map[string]Cell{');
      for (const [key, cell] of Object.entries(frame.data)) {
        lines.push(`\t\t\t\t\t"${key}": {Char: "${escapeGoString(cell.char)}", Color: "${cell.color}", BgColor: "${cell.bgColor}"},`);
      }
      lines.push('\t\t\t\t},');
      lines.push(`\t\t\t\tDuration: ${frame.duration} * time.Millisecond,`);
      lines.push('\t\t\t},');
    }
    lines.push('\t\t},');
    lines.push('\t\tFrameIndex: 0,');
  } else {
    lines.push('\t\tData: map[string]Cell{');
    for (const [key, cell] of Object.entries(frames[0].data)) {
      lines.push(`\t\t\t"${key}": {Char: "${escapeGoString(cell.char)}", Color: "${cell.color}", BgColor: "${cell.bgColor}"},`);
    }
    lines.push('\t\t},');
  }
  
  lines.push('\t}');
  lines.push('}');
  lines.push('');
  
  // Init function
  lines.push(`func (m ${modelName}) Init() tea.Cmd {`);
  if (includeAnimation) {
    lines.push('\treturn m.tick()');
  } else {
    lines.push('\treturn nil');
  }
  lines.push('}');
  lines.push('');
  
  if (includeAnimation) {
    lines.push(`func (m ${modelName}) tick() tea.Cmd {`);
    lines.push('\treturn tea.Tick(m.Frames[m.FrameIndex].Duration, func(t time.Time) tea.Msg {');
    lines.push('\t\treturn tickMsg(t)');
    lines.push('\t})');
    lines.push('}');
    lines.push('');
  }
  
  // Update function
  lines.push(`func (m ${modelName}) Update(msg tea.Msg) (tea.Model, tea.Cmd) {`);
  lines.push('\tswitch msg := msg.(type) {');
  lines.push('\tcase tea.KeyMsg:');
  lines.push('\t\tif msg.String() == "q" || msg.String() == "ctrl+c" {');
  lines.push('\t\t\treturn m, tea.Quit');
  lines.push('\t\t}');
  if (includeAnimation) {
    lines.push('\tcase tickMsg:');
    lines.push('\t\tm.FrameIndex = (m.FrameIndex + 1) % len(m.Frames)');
    lines.push('\t\treturn m, m.tick()');
  }
  lines.push('\t}');
  lines.push('\treturn m, nil');
  lines.push('}');
  lines.push('');
  
  // View function
  lines.push(`func (m ${modelName}) View() string {`);
  lines.push('\tvar sb strings.Builder');
  if (includeAnimation) {
    lines.push('\tdata := m.Frames[m.FrameIndex].Data');
  } else {
    lines.push('\tdata := m.Data');
  }
  lines.push('');
  lines.push('\tfor y := 0; y < m.Height; y++ {');
  lines.push('\t\tfor x := 0; x < m.Width; x++ {');
  lines.push('\t\t\tkey := fmt.Sprintf("%d,%d", x, y)');
  lines.push('\t\t\tif cell, ok := data[key]; ok {');
  lines.push('\t\t\t\tstyle := lipgloss.NewStyle().Foreground(lipgloss.Color(cell.Color))');
  lines.push('\t\t\t\tif cell.BgColor != "" && cell.BgColor != "transparent" {');
  lines.push('\t\t\t\t\tstyle = style.Background(lipgloss.Color(cell.BgColor))');
  lines.push('\t\t\t\t}');
  lines.push('\t\t\t\tsb.WriteString(style.Render(cell.Char))');
  lines.push('\t\t\t} else {');
  lines.push('\t\t\t\tsb.WriteString(" ")');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('\t\tsb.WriteString("\\n")');
  lines.push('\t}');
  lines.push('');
  lines.push('\treturn sb.String()');
  lines.push('}');
  
  return lines.join('\n');
}

function generateOpenTuiComponent(
  className: string,
  frames: Frame[],
  width: number,
  height: number,
  includeAnimation: boolean
): string {
  const lines: string[] = [];
  
  lines.push('"""');
  lines.push(`ASCII Art Display Component - ${className}`);
  lines.push('Generated by ASCII Motion MCP Server');
  lines.push('"""');
  lines.push('');
  lines.push('import asyncio');
  lines.push('from typing import Dict, Optional');
  lines.push('from dataclasses import dataclass');
  lines.push('');
  lines.push('');
  lines.push('@dataclass');
  lines.push('class Cell:');
  lines.push('    char: str');
  lines.push('    color: str');
  lines.push('    bg_color: str');
  lines.push('');
  lines.push('');
  lines.push('@dataclass');
  lines.push('class Frame:');
  lines.push('    data: Dict[str, Cell]');
  lines.push('    duration: int  # milliseconds');
  lines.push('');
  lines.push('');
  lines.push(`class ${className}:`);
  lines.push(`    """ASCII art display with ${includeAnimation ? 'animation support' : 'static display'}."""`);
  lines.push('');
  lines.push('    def __init__(self):');
  lines.push(`        self.width = ${width}`);
  lines.push(`        self.height = ${height}`);
  
  if (includeAnimation) {
    lines.push('        self.frames = [');
    for (const frame of frames) {
      lines.push('            Frame(');
      lines.push('                data={');
      for (const [key, cell] of Object.entries(frame.data)) {
        lines.push(`                    "${key}": Cell(char="${escapePythonString(cell.char)}", color="${cell.color}", bg_color="${cell.bgColor}"),`);
      }
      lines.push('                },');
      lines.push(`                duration=${frame.duration},`);
      lines.push('            ),');
    }
    lines.push('        ]');
    lines.push('        self.frame_index = 0');
  } else {
    lines.push('        self.data = {');
    for (const [key, cell] of Object.entries(frames[0].data)) {
      lines.push(`            "${key}": Cell(char="${escapePythonString(cell.char)}", color="${cell.color}", bg_color="${cell.bgColor}"),`);
    }
    lines.push('        }');
  }
  lines.push('');
  
  lines.push('    def get_cell(self, x: int, y: int) -> Optional[Cell]:');
  lines.push('        """Get cell at coordinates."""');
  if (includeAnimation) {
    lines.push('        return self.frames[self.frame_index].data.get(f"{x},{y}")');
  } else {
    lines.push('        return self.data.get(f"{x},{y}")');
  }
  lines.push('');
  
  if (includeAnimation) {
    lines.push('    def next_frame(self) -> None:');
    lines.push('        """Advance to next frame."""');
    lines.push('        self.frame_index = (self.frame_index + 1) % len(self.frames)');
    lines.push('');
    lines.push('    def get_current_duration(self) -> int:');
    lines.push('        """Get duration of current frame in milliseconds."""');
    lines.push('        return self.frames[self.frame_index].duration');
    lines.push('');
    lines.push('    async def run_animation(self) -> None:');
    lines.push('        """Run animation loop."""');
    lines.push('        while True:');
    lines.push('            self.render()');
    lines.push('            await asyncio.sleep(self.get_current_duration() / 1000)');
    lines.push('            self.next_frame()');
    lines.push('');
  }
  
  lines.push('    def render(self) -> str:');
  lines.push('        """Render the current frame as a string."""');
  lines.push('        output = []');
  lines.push('        for y in range(self.height):');
  lines.push('            row = []');
  lines.push('            for x in range(self.width):');
  lines.push('                cell = self.get_cell(x, y)');
  lines.push('                if cell:');
  lines.push('                    row.append(cell.char)');
  lines.push('                else:');
  lines.push('                    row.append(" ")');
  lines.push('            output.append("".join(row))');
  lines.push('        return "\\n".join(output)');
  lines.push('');
  lines.push('    def render_with_ansi(self) -> str:');
  lines.push('        """Render with ANSI color codes."""');
  lines.push('        output = []');
  lines.push('        for y in range(self.height):');
  lines.push('            row = []');
  lines.push('            for x in range(self.width):');
  lines.push('                cell = self.get_cell(x, y)');
  lines.push('                if cell:');
  lines.push('                    # Convert hex to ANSI (simplified)');
  lines.push('                    row.append(f"\\033[38;2;{self._hex_to_rgb(cell.color)}m{cell.char}\\033[0m")');
  lines.push('                else:');
  lines.push('                    row.append(" ")');
  lines.push('            output.append("".join(row))');
  lines.push('        return "\\n".join(output)');
  lines.push('');
  lines.push('    @staticmethod');
  lines.push('    def _hex_to_rgb(hex_color: str) -> str:');
  lines.push('        """Convert hex color to RGB string."""');
  lines.push('        hex_color = hex_color.lstrip("#")');
  lines.push('        if len(hex_color) == 6:');
  lines.push('            r = int(hex_color[0:2], 16)');
  lines.push('            g = int(hex_color[2:4], 16)');
  lines.push('            b = int(hex_color[4:6], 16)');
  lines.push('            return f"{r};{g};{b}"');
  lines.push('        return "255;255;255"');
  lines.push('');
  lines.push('');
  lines.push('if __name__ == "__main__":');
  lines.push(`    display = ${className}()`);
  if (includeAnimation) {
    lines.push('    asyncio.run(display.run_animation())');
  } else {
    lines.push('    print(display.render_with_ansi())');
  }
  
  return lines.join('\n');
}

function generateSvgImage(
  data: Record<string, { char: string; color: string; bgColor: string }>,
  width: number,
  height: number,
  backgroundColor: string,
  scale: number,
  fontFamily: string,
  fontSize: number,
  cellWidth: number,
  cellHeight: number
): string {
  const svgWidth = width * cellWidth * scale;
  const svgHeight = height * cellHeight * scale;
  
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`);
  lines.push(`  <rect width="100%" height="100%" fill="${backgroundColor || '#1a1a2e'}"/>`);
  lines.push(`  <style>text { font-family: ${fontFamily}; font-size: ${fontSize * scale}px; dominant-baseline: text-before-edge; }</style>`);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = data[`${x},${y}`];
      if (cell) {
        const px = x * cellWidth * scale;
        const py = y * cellHeight * scale;
        
        // Draw background rect if color is set
        if (cell.bgColor && cell.bgColor !== 'transparent') {
          lines.push(`  <rect x="${px}" y="${py}" width="${cellWidth * scale}" height="${cellHeight * scale}" fill="${cell.bgColor}"/>`);
        }
        
        // Draw character
        const escapedChar = escapeXml(cell.char);
        lines.push(`  <text x="${px + 1}" y="${py + 2}" fill="${cell.color}">${escapedChar}</text>`);
      }
    }
  }
  
  lines.push('</svg>');
  return lines.join('\n');
}

function escapeGoString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function escapePythonString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
