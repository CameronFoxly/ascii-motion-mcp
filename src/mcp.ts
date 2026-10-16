/**
 * Typed v1 registration surface backed by the stable v2 server.
 *
 * Existing Zod 3 schemas remain authoritative for validation and defaults.
 * The Standard Schema adapter supplies their JSON Schema without passing
 * unsupported Zod 3 objects to the SDK's Zod 4 registration overloads.
 */
import {
  McpServer as SdkMcpServer,
  fromJsonSchema,
  type CallToolResult,
  type GetPromptResult,
  type ReadResourceCallback,
  type ResourceMetadata,
  type RegisteredTool,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { storeArtifact } from './artifacts.js';

function boundedValidation<Input, Output>(
  schema: StandardSchemaWithJSON<Input, Output>,
): StandardSchemaWithJSON<Input, Output> {
  return {
    ...schema,
    '~standard': {
      ...schema['~standard'],
      async validate(value) {
        const result = await schema['~standard'].validate(value);
        if (!result.issues) return result;
        const json = JSON.stringify(result.issues);
        if (Buffer.byteLength(json) <= 4096) return result;
        const artifact = await storeArtifact(json, 'validation-errors.json', 'application/json');
        return { issues: [{
          message: `Validation failed; full details exceed the inline budget. Read ${artifact.uri} with read_artifact {"artifactId":"${artifact.id}"}.`,
        }] };
      },
    },
  };
}

export function standardSchema<Schema extends z.ZodTypeAny>(
  schema: Schema,
): StandardSchemaWithJSON<z.input<Schema>, z.output<Schema>> {
  const jsonSchema = () => zodToJsonSchema(schema, { target: 'jsonSchema7' });
  return boundedValidation({
    '~standard': {
      version: 1,
      vendor: 'ascii-motion-zod3',
      async validate(value) {
        const parsed = await schema.safeParseAsync(value);
        return parsed.success
          ? { value: parsed.data }
          : { issues: parsed.error.issues.map(({ message, path }) => ({ message, path })) };
      },
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  });
}

function registrationSchema<Shape extends z.ZodRawShape>(shape: Shape) {
  const schema = standardSchema(z.object(shape));
  if (Object.keys(shape).length === 0) {
    // v1 advertised an unconstrained object for zero-argument registrations.
    const convert = schema['~standard'].jsonSchema.input;
    return {
      '~standard': {
        ...schema['~standard'],
        jsonSchema: {
          ...schema['~standard'].jsonSchema,
          input(options: Parameters<typeof convert>[0]) {
            const json = { ...convert(options) };
            delete json.additionalProperties;
            return json;
          },
        },
      },
    };
  }
  return schema;
}

export type ToolExecutionMiddleware = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  next: () => Promise<CallToolResult>,
  context: ServerContext,
) => CallToolResult | Promise<CallToolResult>;

export type ToolResult = CallToolResult;
export type { ToolAnnotations, ServerContext };

export interface ToolRegistrationMetadata {
  annotations?: ToolAnnotations;
  outputSchema?: StandardSchemaWithJSON;
  _meta?: Record<string, unknown>;
}

let toolExecutionMiddleware: ToolExecutionMiddleware | undefined;
let toolMetadataProvider: ((name: string) => ToolRegistrationMetadata | undefined) | undefined;

/** Applies to already-registered handlers too; unset restores direct execution. */
export function setToolExecutionMiddleware(middleware: ToolExecutionMiddleware | undefined): void {
  toolExecutionMiddleware = middleware;
}

/** Read at registration time, allowing discovery metadata without handler rewrites. */
export function setToolMetadataProvider(
  provider: ((name: string) => ToolRegistrationMetadata | undefined) | undefined,
): void {
  toolMetadataProvider = provider;
}

export class McpServer extends SdkMcpServer {
  private readonly facadeTools = new Map<string, RegisteredTool>();

  /** Snapshot of names registered through tool/jsonTool, for generated-name deduplication. */
  get registeredToolNames(): ReadonlySet<string> {
    return new Set(this.facadeTools.keys());
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ServerContext,
    handler: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const next = async () => handler();
    return toolExecutionMiddleware
      ? toolExecutionMiddleware(name, args, next, context)
      : next();
  }

  tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (
      args: z.output<z.ZodObject<Shape>>,
      context: ServerContext,
    ) => CallToolResult | Promise<CallToolResult>,
    metadata?: ToolRegistrationMetadata,
  ) {
    const registered = this.registerTool(
      name,
      {
        description,
        inputSchema: registrationSchema(shape),
        ...toolMetadataProvider?.(name),
        ...metadata,
      },
      (args, context) => this.executeTool(name, args, context, () => handler(args, context)),
    );
    this.facadeTools.set(name, registered);
    return registered;
  }

  jsonTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    outputSchema: Record<string, unknown>,
    handler: (
      args: Record<string, unknown>,
      context: ServerContext,
    ) => Promise<ToolResult>,
    annotations?: ToolAnnotations,
  ): RegisteredTool {
    const registered = this.registerTool(
      name,
      {
        description,
        inputSchema: boundedValidation(fromJsonSchema<Record<string, unknown>>(inputSchema)),
        outputSchema: boundedValidation(fromJsonSchema<Record<string, unknown>>(outputSchema)),
        ...toolMetadataProvider?.(name),
        ...(annotations ? { annotations } : {}),
      },
      (args, context) => this.executeTool(name, args, context, () => handler(args, context)),
    );
    this.facadeTools.set(name, registered);
    return registered;
  }

  resource(name: string, uri: string, metadata: ResourceMetadata, handler: ReadResourceCallback) {
    return this.registerResource(name, uri, metadata, handler);
  }

  prompt<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (
      args: z.output<z.ZodObject<Shape>>,
      context: ServerContext,
    ) => GetPromptResult | Promise<GetPromptResult>,
  ) {
    return this.registerPrompt(
      name,
      { description, argsSchema: registrationSchema(shape) },
      handler,
    );
  }
}
