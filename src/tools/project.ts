/**
 * Project Tools
 * 
 * Tools for managing projects (new, save, load).
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { SessionDataSchema } from '../types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Get the project directory from environment or use current working directory
function getProjectDir(): string {
  return process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
}

// Validate that a path is within the allowed project directory
function validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
  const projectDir = getProjectDir();
  const resolved = path.resolve(projectDir, filePath);
  
  if (!resolved.startsWith(projectDir)) {
    return {
      valid: false,
      resolved,
      error: `Path "${filePath}" is outside the allowed project directory`,
    };
  }
  
  return { valid: true, resolved };
}

export function registerProjectTools(server: McpServer): void {
  // ==========================================================================
  // new_project - Create a new empty project
  // ==========================================================================
  server.tool(
    'new_project',
    'Create a new empty project, discarding any unsaved changes',
    {
      width: z.number().int().min(4).max(200).default(80).describe('Canvas width'),
      height: z.number().int().min(4).max(100).default(24).describe('Canvas height'),
      name: z.string().optional().describe('Project name'),
      template: z.enum(['terminal-80x24', 'wide-120x30', 'square-40x40', 'small-32x16', 'large-160x50']).optional().describe('Use a preset template'),
    },
    async ({ width, height, name, template }) => {
      const pm = getProjectManager();
      
      // Handle templates
      let finalWidth = width;
      let finalHeight = height;
      
      if (template) {
        switch (template) {
          case 'terminal-80x24':
            finalWidth = 80;
            finalHeight = 24;
            break;
          case 'wide-120x30':
            finalWidth = 120;
            finalHeight = 30;
            break;
          case 'square-40x40':
            finalWidth = 40;
            finalHeight = 40;
            break;
          case 'small-32x16':
            finalWidth = 32;
            finalHeight = 16;
            break;
          case 'large-160x50':
            finalWidth = 160;
            finalHeight = 50;
            break;
        }
      }
      
      pm.newProject({ width: finalWidth, height: finalHeight, name });
      
      const state = pm.getState();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            project: {
              name: state.name,
              width: state.width,
              height: state.height,
              frames: state.frames.length,
            },
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // save_project - Save the current project to a file
  // ==========================================================================
  server.tool(
    'save_project',
    'Save the current project to a .asciimtn file',
    {
      filePath: z.string().describe('File path relative to project directory (e.g., "my-art.asciimtn")'),
    },
    async ({ filePath }) => {
      const pm = getProjectManager();
      
      // Ensure .asciimtn extension
      if (!filePath.endsWith('.asciimtn')) {
        filePath = filePath + '.asciimtn';
      }
      
      const validation = validatePath(filePath);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: validation.error }) }],
          isError: true,
        };
      }
      
      try {
        // Ensure directory exists
        const dir = path.dirname(validation.resolved);
        await fs.mkdir(dir, { recursive: true });
        
        const sessionData = pm.toSessionData();
        const json = JSON.stringify(sessionData, null, 2);
        
        await fs.writeFile(validation.resolved, json, 'utf-8');
        
        pm.setFilePath(validation.resolved);
        pm.markClean();
        
        const state = pm.getState();
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              success: true,
              filePath: validation.resolved,
              projectName: state.name,
              frames: state.frames.length,
              fileSize: Buffer.byteLength(json, 'utf-8'),
            }) 
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}` }) }],
          isError: true,
        };
      }
    }
  );

  // ==========================================================================
  // load_project - Load a project from a file
  // ==========================================================================
  server.tool(
    'load_project',
    'Load a project from a .asciimtn file',
    {
      filePath: z.string().describe('File path relative to project directory'),
    },
    async ({ filePath }) => {
      const validation = validatePath(filePath);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: validation.error }) }],
          isError: true,
        };
      }
      
      try {
        const content = await fs.readFile(validation.resolved, 'utf-8');
        const data = JSON.parse(content);
        
        // Validate the data
        const sessionData = SessionDataSchema.parse(data);
        
        const pm = getProjectManager();
        pm.loadFromSessionData(sessionData, validation.resolved);
        
        const state = pm.getState();
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              success: true,
              filePath: validation.resolved,
              project: {
                name: state.name,
                description: state.description,
                width: state.width,
                height: state.height,
                frames: state.frames.length,
                totalDuration: state.frames.reduce((sum, f) => sum + f.duration, 0),
              },
            }) 
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to load: ${error instanceof Error ? error.message : 'Unknown error'}` }) }],
          isError: true,
        };
      }
    }
  );

  // ==========================================================================
  // get_project_info - Get current project metadata
  // ==========================================================================
  server.tool(
    'get_project_info',
    'Get information about the current project',
    {},
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const totalCells = state.frames.reduce((sum, f) => sum + Object.keys(f.data).length, 0);
      const totalDuration = state.frames.reduce((sum, f) => sum + f.duration, 0);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            name: state.name,
            description: state.description,
            filePath: state.filePath,
            isDirty: state.isDirty,
            canvas: {
              width: state.width,
              height: state.height,
              backgroundColor: state.backgroundColor,
              showGrid: state.showGrid,
            },
            animation: {
              frameCount: state.frames.length,
              currentFrameIndex: state.currentFrameIndex,
              frameRate: state.frameRate,
              looping: state.looping,
              totalDuration,
              totalCells,
            },
            history: pm.getHistoryInfo(),
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // set_project_name - Set the project name
  // ==========================================================================
  server.tool(
    'set_project_name',
    'Set the project name',
    {
      name: z.string().min(1).max(200).describe('New project name'),
    },
    async ({ name }) => {
      const pm = getProjectManager();
      // State updated directly
      
      // Direct state modification (would need to add a method to ProjectStateManager)
      (pm as unknown as { state: { name: string; isDirty: boolean } }).state.name = name;
      (pm as unknown as { state: { isDirty: boolean } }).state.isDirty = true;
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, name }) }],
      };
    }
  );

  // ==========================================================================
  // list_project_files - List .asciimtn files in project directory
  // ==========================================================================
  server.tool(
    'list_project_files',
    'List all .asciimtn project files in the project directory',
    {
      recursive: z.boolean().default(false).describe('Search subdirectories'),
    },
    async ({ recursive }) => {
      const projectDir = getProjectDir();
      
      try {
        const files: Array<{ path: string; name: string; size: number; modified: string }> = [];
        
        async function scanDir(dir: string): Promise<void> {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory() && recursive) {
              await scanDir(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.asciimtn')) {
              const stats = await fs.stat(fullPath);
              files.push({
                path: path.relative(projectDir, fullPath),
                name: entry.name,
                size: stats.size,
                modified: stats.mtime.toISOString(),
              });
            }
          }
        }
        
        await scanDir(projectDir);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              projectDir,
              files,
              count: files.length,
            }) 
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to list files: ${error instanceof Error ? error.message : 'Unknown error'}` }) }],
          isError: true,
        };
      }
    }
  );
}
