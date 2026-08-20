import path from 'node:path';
import { readFileSafe } from './utils/fs.js';

export interface ModelPolicy {
  schema_version: number;
  policy: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  host_mappings: Record<string, Record<string, Record<string, unknown>>>;
}

export interface ResolvedModelPolicy {
  model: string;
  effort?: string;
  role?: string;
}

/** Load and strictly validate the generic model policy configured by a team. */
export async function loadModelPolicy(repoPath: string, config?: { path: string; strict?: boolean }): Promise<ModelPolicy | null> {
  if (!config) return null;
  const file = path.isAbsolute(config.path) ? config.path : path.join(repoPath, config.path);
  const raw = await readFileSafe(file);
  if (!raw) {
    if (config.strict !== false) throw new Error(`Model policy not found: ${config.path}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid model policy JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !isRecord(parsed.policy)
    || !isRecord(parsed.roles) || !isRecord(parsed.host_mappings)) {
    throw new Error('Invalid model policy: expected schema_version=1, policy, roles and host_mappings');
  }
  return parsed as ModelPolicy;
}

/** Resolve a host-local model_ref without silently falling back. */
export function resolveModelRef(policy: ModelPolicy, host: string, ref: string): ResolvedModelPolicy {
  const pathParts = ref.split('.');
  const root: unknown = pathParts[0] === 'host_mappings' ? policy : policy.host_mappings;
  const lookup = pathParts[0] === 'host_mappings' ? pathParts : [host, ...pathParts];
  const hostEntry = lookupPath(root, lookup);
  if (hostEntry && typeof hostEntry.model === 'string') {
    return {
      model: hostEntry.model,
      ...(typeof hostEntry.reasoning_effort === 'string' ? { effort: hostEntry.reasoning_effort } : {}),
      ...(typeof hostEntry.logical_role === 'string' ? { role: hostEntry.logical_role } : {}),
    };
  }
  const role = policy.roles[ref];
  if (role) {
    const model = role.preferred_model ?? role.preferred_external_model ?? role.required_model_slug;
    if (typeof model === 'string') {
      const effort = role.preferred_effort;
      return { model, ...(typeof effort === 'string' ? { effort } : {}), role: ref };
    }
  }
  throw new Error(`Unresolved model_ref "${ref}" for host "${host}"`);
}

function lookupPath(root: unknown, parts: string[]): Record<string, unknown> | null {
  let value: unknown = root;
  for (const part of parts) {
    if (!isRecord(value) || !(part in value)) return null;
    value = value[part];
  }
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
