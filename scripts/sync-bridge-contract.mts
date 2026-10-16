import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source');
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
if (sourceIndex >= 0 && (!source || source.startsWith('--'))) throw new Error('--source requires a file');
const destination = new URL('../src/contract/bridge-contract.json', import.meta.url);
const text = await readFile(source ?? destination, 'utf8');
const contract = JSON.parse(text);
const { contractHash, ...payload } = contract;
const actualHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
if (contractHash !== actualHash) throw new Error('Contract hash mismatch');
if (contract.protocol !== 'ascii-motion-bridge' || contract.protocolVersion !== 3) {
  throw new Error('Unsupported bridge contract');
}
const ajv = new Ajv2020({ strict: true });
const names = new Set<string>();
for (const operation of contract.operations) {
  if (names.has(operation.name)) throw new Error(`Duplicate operation: ${operation.name}`);
  names.add(operation.name);
  ajv.compile({ $defs: contract.$defs, ...operation.input });
  ajv.compile({ $defs: contract.$defs, ...operation.result });
}
for (const schema of Object.values(contract.messages)) ajv.compile({ $defs: contract.$defs, ...schema as object });
if (args.includes('--check')) {
  if (source && (await readFile(destination, 'utf8')) !== text) throw new Error('Bundled bridge contract is stale');
} else {
  if (!source) throw new Error('Updating requires --source <app-generated bridge-contract.json>');
  await mkdir(new URL('../src/contract/', import.meta.url), { recursive: true });
  await writeFile(destination, text);
}
console.log(`${names.size} operations validated; ${contractHash}; ${fileURLToPath(destination)}`);
