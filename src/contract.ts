import { createHash } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';
import bundled from './contract/bridge-contract.json' with { type: 'json' };

const Schema = z.record(z.string(), z.unknown());
const ContractSchema = z.object({
  protocol: z.literal('ascii-motion-bridge'),
  protocolVersion: z.literal(3),
  contractVersion: z.string(),
  contractHash: z.string(),
  errorCodes: z.array(z.string()),
  $defs: z.record(z.string(), Schema),
  messages: z.record(z.string(), Schema),
  operations: z.array(z.object({
    name: z.string(),
    domain: z.string(),
    kind: z.enum(['read', 'mutation', 'view', 'io']),
    destructive: z.boolean(),
    idempotent: z.boolean(),
    requires: z.array(z.string()),
    description: z.string(),
    input: Schema,
    result: Schema,
  })),
}).passthrough();

export const bridgeContract = ContractSchema.parse(bundled);
export type BridgeOperation = typeof bridgeContract.operations[number];
const { contractHash, ...payload } = bundled;
if (createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== contractHash) {
  throw new Error('Bundled bridge contract hash mismatch');
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = new Map<string, { input: ValidateFunction; result: ValidateFunction }>();
const messageValidators = new Map(Object.entries(bridgeContract.messages).map(([name, schema]) => [
  name, ajv.compile({ $defs: bridgeContract.$defs, ...schema }),
]));
for (const op of bridgeContract.operations) {
  if (validators.has(op.name)) throw new Error(`Duplicate bridge operation: ${op.name}`);
  validators.set(op.name, {
    input: ajv.compile({ $defs: bridgeContract.$defs, ...op.input }),
    result: ajv.compile({ $defs: bridgeContract.$defs, ...op.result }),
  });
}

export function operationNamed(name: string): BridgeOperation | undefined {
  return bridgeContract.operations.find(operation => operation.name === name);
}

export function validateOperation(name: string, direction: 'input' | 'result', value: unknown): void {
  const validate = validators.get(name)?.[direction];
  if (!validate) throw new Error(`Unknown bridge operation: ${name}`);
  if (!validate(value)) {
    throw new Error(`Invalid ${name} ${direction}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }

}

export function validateBridgeMessage(type: string, value: unknown): void {
  const validate = messageValidators.get(type);
  if (validate && !validate(value)) {
    throw new Error(`Invalid bridge ${type}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }
}

export function withDefinitions(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')) {
          const name = child.slice('#/$defs/'.length);
          if (name in definitions) continue;
          const definition = bridgeContract.$defs[name];
          if (!definition) throw new Error(`Unknown contract definition: ${name}`);
          definitions[name] = definition;
          visit(definition);
        } else visit(child);
      }
    }
  };
  visit(schema);
  return Object.keys(definitions).length ? { $defs: definitions, ...schema } : schema;
}
