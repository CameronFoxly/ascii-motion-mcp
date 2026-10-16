import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function getProjectDirectory(): string {
  return path.resolve(process.env.ASCII_MOTION_PROJECT_DIR || process.cwd());
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveProjectPath(filePath: string): Promise<string> {
  const root = getProjectDirectory();
  const target = path.resolve(root, filePath);
  if (!within(root, target)) throw new Error('Path must be within the project directory');
  const realRoot = await fs.realpath(root);
  let ancestor = target;
  for (;;) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (!within(realRoot, realAncestor)) throw new Error('Path resolves outside the project directory');
      return target;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function validateProjectPath(filePath: string): Promise<
  { valid: true; resolved: string } | { valid: false; error: string }
> {
  try {
    return { valid: true, resolved: await resolveProjectPath(filePath) };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
