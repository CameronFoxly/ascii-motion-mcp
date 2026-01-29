/**
 * History Tools
 * 
 * Undo/redo functionality.
 */

// z is used implicitly via McpServer
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';

export function registerHistoryTools(server: McpServer): void {
  // ==========================================================================
  // undo - Undo the last action
  // ==========================================================================
  server.tool(
    'undo',
    'Undo the last action',
    {},
    async () => {
      const pm = getProjectManager();
      const info = pm.getHistoryInfo();
      
      if (!info.canUndo) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Nothing to undo' }) }],
        };
      }
      
      const description = info.undoDescription;
      const success = pm.undo();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            undone: description,
            canUndoMore: pm.getHistoryInfo().canUndo,
            canRedo: pm.getHistoryInfo().canRedo,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // redo - Redo the last undone action
  // ==========================================================================
  server.tool(
    'redo',
    'Redo the last undone action',
    {},
    async () => {
      const pm = getProjectManager();
      const info = pm.getHistoryInfo();
      
      if (!info.canRedo) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Nothing to redo' }) }],
        };
      }
      
      const description = info.redoDescription;
      const success = pm.redo();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            redone: description,
            canUndo: pm.getHistoryInfo().canUndo,
            canRedoMore: pm.getHistoryInfo().canRedo,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_history_status - Check undo/redo availability
  // ==========================================================================
  server.tool(
    'get_history_status',
    'Check if undo/redo is available and what actions can be undone/redone',
    {},
    async () => {
      const pm = getProjectManager();
      const info = pm.getHistoryInfo();
      
      return {
        content: [{ type: 'text', text: JSON.stringify(info) }],
      };
    }
  );
}
