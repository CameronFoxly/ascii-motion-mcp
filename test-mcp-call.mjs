#!/usr/bin/env node
/**
 * Quick test script to call MCP tools via stdio
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

const serverProcess = spawn('node', ['dist/index.js'], {
  cwd: '/Users/cameronfoxly/GitHubRepos/ascii-motion-mcp',
  stdio: ['pipe', 'pipe', 'inherit']
});

let messageId = 1;

function sendMessage(message) {
  const json = JSON.stringify(message);
  serverProcess.stdin.write(json + '\n');
}

const rl = readline.createInterface({
  input: serverProcess.stdout,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  try {
    const response = JSON.parse(line);
    console.log('Response:', JSON.stringify(response, null, 2));
    
    // After initialize response, send the tool call
    if (response.id === 1 && response.result) {
      // Send initialized notification
      sendMessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });
      
      // Call the new_project tool
      sendMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'new_project',
          arguments: {
            width: 24,
            height: 24,
            name: 'Test MCP Project'
          }
        }
      });
    }
    
    // After tool call response, get project info and exit
    if (response.id === 2) {
      console.log('\n✅ Project created!');
      
      // Get project info
      sendMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_project_info',
          arguments: {}
        }
      });
    }
    
    if (response.id === 3) {
      console.log('\n📋 Project info retrieved!');
      setTimeout(() => {
        serverProcess.kill();
        process.exit(0);
      }, 100);
    }
  } catch (e) {
    // Not JSON, ignore
  }
});

// Send initialize request
sendMessage({
  jsonrpc: '2.0',
  id: messageId++,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('Timeout - exiting');
  serverProcess.kill();
  process.exit(1);
}, 10000);
