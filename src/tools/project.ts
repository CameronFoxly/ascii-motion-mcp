/**
 * Project Tools
 * 
 * Tools for managing projects (new, save, load).
 */

import { z } from 'zod';
import { McpServer } from '../mcp.js';
import { getProjectManager, broadcastStateChange, ProjectStateManager } from '../state.js';
import { requestBrowserCommand, requireFreshBrowserState } from '../live-sync.js';
import type { BrowserCommandResult } from '../transport/websocket.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectDirectory, validateProjectPath } from '../project-path.js';

export const PROJECT_TEMPLATES = {
  'terminal-80x24': { width: 80, height: 24 },
  'wide-120x30': { width: 120, height: 30 },
  'square-40x40': { width: 40, height: 40 },
  'small-32x16': { width: 32, height: 16 },
  'large-160x50': { width: 160, height: 50 },
};

// Get the project directory from environment or use current working directory
function getProjectDir(): string {
  return getProjectDirectory();
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
      
      const dimensions = template ? PROJECT_TEMPLATES[template] : { width, height };
      
      pm.newProject({ ...dimensions, name });
      
      const state = pm.getState();
      
      // Broadcast state change to connected browsers
      broadcastStateChange('new_project', { 
        width: state.width, 
        height: state.height, 
        name: state.name,
        backgroundColor: state.backgroundColor 
      });
      
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
      
      const validation = await validateProjectPath(filePath);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: validation.error }) }],
          isError: true,
        };
      }
      
      try {
        const browserRefreshed = await requireFreshBrowserState();
        if (browserRefreshed && !pm.hasCompleteBrowserDocument()) {
          throw new Error('The connected app cannot supply a complete native document. Update ASCII Motion before saving.');
        }
        // Ensure directory exists
        const dir = path.dirname(validation.resolved);
        await fs.mkdir(dir, { recursive: true });
        
        const sessionData = pm.toNativeSessionData();
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
      let browserApplied = false;
      const validation = await validateProjectPath(filePath);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: validation.error }) }],
          isError: true,
        };
      }
      
      try {
        const content = await fs.readFile(validation.resolved, 'utf-8');
        const data = JSON.parse(content);

        // Validate without changing the active project before browser acknowledgement.
        const candidate = new ProjectStateManager();
        candidate.loadFromUnknownSessionData(data, validation.resolved);

        const pm = getProjectManager();
        const reconcileLoadedProject = async (
          result: BrowserCommandResult,
        ): Promise<void> => {
          browserApplied = true;
          pm.loadFromUnknownSessionData(data, validation.resolved);
          if (result.applied?.currentFrameIndex !== undefined) {
            pm.goToFrame(result.applied.currentFrameIndex);
          }
          await requireFreshBrowserState();
          pm.setFilePath(validation.resolved);
        };
        const commandResult = await requestBrowserCommand(
          {
            type: 'load_project',
            sessionData: data,
          },
          undefined,
          reconcileLoadedProject,
        );

        if (!commandResult) {
          pm.loadFromUnknownSessionData(data, validation.resolved);
        }
        
        const state = pm.getState();
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              success: true,
              browserSynced: commandResult !== null,
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
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              browserApplied,
              stateReconciled: false,
              error: `Failed to load: ${error instanceof Error ? error.message : 'Unknown error'}`,
            }),
          }],
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
      pm.setProjectMetadata({ name });
      
      broadcastStateChange('set_project_name', { name });
      
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
