import { describe, expect, it } from 'vitest';
import { McpServer } from './mcp.js';
import { legacyToolMetadata } from './tool-metadata.js';
import * as registrations from './tools/index.js';

describe('compatibility tool safety metadata', () => {
  it('classifies every existing tool explicitly or through its canonical operation', () => {
    const server = new McpServer({ name: 'metadata', version: '1' });
    for (const [name, register] of Object.entries(registrations)) {
      if (name.startsWith('register')) Reflect.apply(register, undefined, [server]);
    }
    expect(server.registeredToolNames.size).toBe(109);
    for (const name of server.registeredToolNames) {
      expect(legacyToolMetadata(name)?.annotations, name).toBeDefined();
    }
    expect(legacyToolMetadata('get_canvas_ascii')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(legacyToolMetadata('export_image')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(legacyToolMetadata('set_cell')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(legacyToolMetadata('add_layer')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(legacyToolMetadata('unknown-custom-tool')).toBeUndefined();
  });
});
