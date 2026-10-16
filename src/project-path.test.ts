import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectPath } from './project-path.js';

describe('project path containment', () => {
  let directory: string;
  let original: string | undefined;
  beforeEach(async () => {
    original = process.env.ASCII_MOTION_PROJECT_DIR;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ascii-motion-path-'));
    await fs.mkdir(path.join(directory, 'project'));
    await fs.mkdir(path.join(directory, 'project-sibling'));
    process.env.ASCII_MOTION_PROJECT_DIR = path.join(directory, 'project');
  });
  afterEach(async () => {
    if (original === undefined) delete process.env.ASCII_MOTION_PROJECT_DIR;
    else process.env.ASCII_MOTION_PROJECT_DIR = original;
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('accepts contained files and not-yet-created output directories', async () => {
    expect(await resolveProjectPath('nested/art.txt')).toBe(path.join(directory, 'project/nested/art.txt'));
  });
  it('rejects prefix siblings and parent traversal', async () => {
    await expect(resolveProjectPath('../project-sibling/art.txt')).rejects.toThrow('within');
    await expect(resolveProjectPath(path.join(directory, 'project-sibling/art.txt'))).rejects.toThrow('within');
  });
  it('rejects symlink escapes including non-existent descendants', async () => {
    await fs.symlink(path.join(directory, 'project-sibling'), path.join(directory, 'project/link'));
    await expect(resolveProjectPath('link/art.txt')).rejects.toThrow('outside');
    await expect(resolveProjectPath('link/new/subdir/art.txt')).rejects.toThrow('outside');
  });
  it('normalizes a relative project directory before boundary checks', async () => {
    process.env.ASCII_MOTION_PROJECT_DIR = path.relative(process.cwd(), path.join(directory, 'project'));
    expect(await resolveProjectPath('art.txt')).toBe(path.join(directory, 'project/art.txt'));
  });
});
