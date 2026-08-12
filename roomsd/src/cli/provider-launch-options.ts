import type { ProviderAdapter, ProviderDefaults, RoomsProvider } from "./provider-registry.js";

export type ProviderOptionSchema = Readonly<{ type: "string" | "boolean"; enum?: readonly (string | boolean)[]; default?: string | boolean; description: string }>;
export type ProviderLaunchOptionsSchema = Readonly<{ type: "object"; additionalProperties: false; properties: Readonly<Record<string, ProviderOptionSchema>> }>;
export type ProviderLaunchOptions = Readonly<Record<string, unknown>>;

const PERMISSIONS: ProviderOptionSchema = { type: "string", enum: ["headless", "manual"], default: "headless", description: "Whether Rooms configures unattended tool approval or leaves approval prompts for an attached operator." };
const MODEL: ProviderOptionSchema = { type: "string", description: "Provider-native model name." };
const EFFORT: ProviderOptionSchema = { type: "string", enum: ["low", "medium", "high"], description: "Provider-native reasoning effort." };

export function providerLaunchOptionsSchema(provider: RoomsProvider): ProviderLaunchOptionsSchema {
  return { type: "object", additionalProperties: false, properties: {
    permissions: PERMISSIONS,
    model: MODEL,
    ...(["codex", "grok"].includes(provider) ? { reasoningEffort: EFFORT } : {}),
  } };
}

export function providerLaunchArguments(provider: RoomsProvider, adapter: ProviderAdapter, requested: ProviderLaunchOptions, defaults: ProviderDefaults = {}, passthrough: readonly string[] = []): string[] {
  const schema = providerLaunchOptionsSchema(provider);
  const options = { ...defaults, ...requested };
  for (const key of Object.keys(options)) if (!(key in schema.properties)) throw new Error(`unsupported ${provider} launch option: ${key}`);
  for (const [key, value] of Object.entries(options)) validateOption(provider, key, value, schema.properties[key]);
  const args = [...passthrough];
  const permissions = options.permissions ?? schema.properties.permissions.default;
  if (permissions === "headless" && !callerSetPermissions(adapter, args)) args.unshift(...headlessArguments(adapter));
  if (typeof options.model === "string") args.unshift("--model", options.model);
  if (typeof options.reasoningEffort === "string" && !callerSetEffort(adapter, args)) args.unshift(...effortArguments(adapter, options.reasoningEffort));
  return args;
}

function validateOption(provider: RoomsProvider, key: string, value: unknown, schema: ProviderOptionSchema): void {
  if (typeof value !== schema.type || (schema.enum && !schema.enum.includes(value as never))) throw new Error(`invalid ${provider} launch option ${key}; expected ${schema.enum?.join(", ") ?? schema.type}`);
}
function headlessArguments(adapter: ProviderAdapter): string[] { switch (adapter) { case "codex": return ["--yolo"]; case "claude": return ["--dangerously-skip-permissions"]; case "grok": return ["--permission-mode", "bypassPermissions"]; case "agy": return ["--approval-mode", "yolo"]; } }
function effortArguments(adapter: ProviderAdapter, effort: string): string[] { switch (adapter) { case "codex": return ["-c", `model_reasoning_effort=${effort}`]; case "grok": return ["--reasoning-effort", effort]; default: throw new Error(`${adapter} does not accept a reasoning effort option`); } }
function callerSetPermissions(adapter: ProviderAdapter, args: readonly string[]): boolean { const patterns: Record<ProviderAdapter, RegExp[]> = { codex: [/^--yolo$/, /^--full-auto$/, /^--ask-for-approval(=|$)/, /^--sandbox(=|$)/], claude: [/^--permission-mode(=|$)/, /^--dangerously-skip-permissions$/], grok: [/^--permission-mode(=|$)/, /^--always-approve$/], agy: [/^--approval-mode(=|$)/, /^--yolo$/] }; return args.some((arg) => patterns[adapter].some((pattern) => pattern.test(arg))); }
function callerSetEffort(adapter: ProviderAdapter, args: readonly string[]): boolean { if (adapter === "grok") return args.some((arg) => /^--(reasoning-)?effort(=|$)/.test(arg)); if (adapter === "codex") return args.some((arg, index) => /^model_reasoning_effort=/.test(arg) || (["-c", "--config"].includes(arg) && /^model_reasoning_effort=/.test(args[index + 1] ?? ""))); return false; }
