/**
 * Build the JSON schema of a tool's `parameters` from a flat param map.
 * Shared by dynamic tools (`DynamicToolMeta.parameters`) and declarative
 * HTTP API endpoints (`integrations.httpApis[].endpoints[].params`).
 */
export interface ParameterSpec {
  type: string;
  description?: string;
  default?: unknown;
  required?: boolean;
}

export interface ParametersSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export function buildParametersSchema(
  params: Record<string, ParameterSpec> = {}
): ParametersSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: param.type, description: param.description };
    if (param.default !== undefined) prop.default = param.default;
    properties[name] = prop;
    if (param.required) required.push(name);
  }

  return { type: 'object', properties, required: required.length > 0 ? required : undefined };
}
