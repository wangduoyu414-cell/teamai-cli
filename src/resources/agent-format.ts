import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import matter from 'gray-matter';
import { stringify as stringifyToml, parse as parseToml } from 'smol-toml';

// ─── Tool name type ──────────────────────────────────────────────────────────

export type ToolName = 'claude' | 'claude-internal' | 'tclaude' | 'codebuddy' | 'codex' | 'codex-internal' | 'tcodex' | 'cursor' | 'qwen';

export const ALL_SUPPORTED_TOOLS: ToolName[] = [
  'claude',
  'claude-internal',
  'tclaude',
  'codebuddy',
  'codex',
  'codex-internal',
  'tcodex',
  'cursor',
  'qwen',
];

// ─── Intermediate format ─────────────────────────────────────────────────────

/**
 * Intermediate YAML representation of a subagent definition.
 * This is the canonical format stored in the team repo (agents/<name>.yaml).
 * Each tool renderer translates this into its native format.
 */
export interface AgentSpec {
  schema_version?: 1 | 2;
  logical_id?: string;
  filename?: string;
  /** Agent name, must match the YAML filename stem. */
  name: string;
  /** Single-line description shown in tool UI. */
  description: string;
  /** Main prompt / instructions body (multi-line). */
  instructions: string;
  /** Optional model override. */
  model?: string;
  /** Canonical model policy reference; resolved by TeamAI's model policy. */
  model_ref?: string;
  effort?: string;
  permissions?: Record<string, unknown>;
  /** Optional tool whitelist (claude / codebuddy / cursor use this). */
  tools?: string[];
  /**
   * Per-tool private fields that are not part of the common schema.
   * Passed through verbatim when rendering for the matching tool,
   * and collected when reversing from a tool's native format.
   */
  tool_extras?: {
    claude?: Record<string, unknown>;
    'claude-internal'?: Record<string, unknown>;
    tclaude?: Record<string, unknown>;
    codebuddy?: Record<string, unknown>;
    codex?: Record<string, unknown>;
    'codex-internal'?: Record<string, unknown>;
    tcodex?: Record<string, unknown>;
    cursor?: Record<string, unknown>;
    qwen?: Record<string, unknown>;
  };
  /** Host-specific v2 overrides. Missing fields inherit the canonical values. */
  hosts?: Partial<Record<ToolName, AgentHostSpec>>;
  /**
   * Which tools this agent should be deployed to.
   * When undefined, the agent is deployed to ALL installed supported tools.
   */
  targets?: ToolName[];
}

export interface AgentHostSpec {
  filename?: string;
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  model_ref?: string;
  effort?: string;
  tools?: string[];
  permissions?: Record<string, unknown>;
  tools_style?: 'list' | 'comma_separated';
  sandbox_mode?: string;
  permission_mode?: string;
  approval_mode?: string;
  tool_extras?: Record<string, unknown>;
}

// ─── Parse intermediate YAML ─────────────────────────────────────────────────

/**
 * Result type for parseAgentYaml — avoids throwing on bad input.
 */
export type ParseResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; reason: string };

/**
 * Parse a team-repo YAML file into an AgentSpec.
 *
 * Returns a ParseResult instead of throwing, so a single malformed file
 * does not abort the entire pull operation.
 *
 * @param content  - Raw YAML string content.
 * @param filename - Filename used for error messages.
 * @returns ParseResult — ok=true with spec on success, ok=false with reason on failure.
 */
export function parseAgentYaml(content: string, filename: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    return { ok: false, reason: `${filename} parse error: ${(err as Error).message}` };
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: `${filename} must be a YAML object` };
  }

  const obj = raw as Record<string, unknown>;

  const hosts = obj['hosts'];
  const hostEntries = hosts && typeof hosts === 'object' && !Array.isArray(hosts)
    ? Object.values(hosts as Record<string, unknown>).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
    : [];
  const firstHost = hostEntries[0];
  const name = typeof obj['name'] === 'string' ? obj['name'] : (typeof firstHost?.name === 'string' ? firstHost.name : undefined);
  const description = typeof obj['description'] === 'string' ? obj['description'] : (typeof firstHost?.description === 'string' ? firstHost.description : undefined);
  const instructions = typeof obj['instructions'] === 'string' ? obj['instructions'] : (typeof firstHost?.instructions === 'string' ? firstHost.instructions : undefined);
  for (const [field, value] of [['name', name], ['description', description], ['instructions', instructions]] as const) {
    if (!value || value.trim() === '') return { ok: false, reason: `${filename} missing required field ${field} (root or hosts.<tool>)` };
  }

  return {
    ok: true,
    spec: {
      schema_version: obj['schema_version'] === 2 ? 2 : 1,
      ...(typeof obj['logical_id'] === 'string' ? { logical_id: obj['logical_id'] } : {}),
      ...(typeof obj['filename'] === 'string' ? { filename: obj['filename'] } : {}),
      name: name!,
      description: description!,
      instructions: instructions!,
      ...(obj['model'] !== undefined ? { model: obj['model'] as string } : {}),
      ...(obj['model_ref'] !== undefined ? { model_ref: obj['model_ref'] as string } : {}),
      ...(obj['effort'] !== undefined ? { effort: obj['effort'] as string } : {}),
      ...(obj['permissions'] !== undefined ? { permissions: obj['permissions'] as Record<string, unknown> } : {}),
      ...(obj['tools'] !== undefined ? { tools: obj['tools'] as string[] } : {}),
      ...(obj['tool_extras'] !== undefined ? { tool_extras: obj['tool_extras'] as AgentSpec['tool_extras'] } : {}),
      ...(obj['hosts'] !== undefined ? { hosts: obj['hosts'] as AgentSpec['hosts'] } : {}),
      ...(obj['targets'] !== undefined ? { targets: obj['targets'] as ToolName[] } : {}),
    },
  };
}

// ─── Serialize intermediate YAML ─────────────────────────────────────────────

/**
 * Serialize an AgentSpec back to canonical team-repo YAML format.
 *
 * @param spec - The AgentSpec to serialize.
 * @returns YAML string.
 */
export function serializeAgentYaml(spec: AgentSpec): string {
  return stringifyYaml(spec, { lineWidth: 120 });
}

// ─── Render: AgentSpec → tool-native format ───────────────────────────────────

/** Result of rendering an AgentSpec for a specific tool. */
export interface RenderResult {
  ext: '.md' | '.toml';
  content: string;
}

/**
 * Render an AgentSpec for Claude / Claude Code.
 * Output: YAML frontmatter (.md) with optional model/tools and tool_extras.claude fields.
 */
export function renderForClaude(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'claude');
  return { ext: '.md', content: renderMarkdownAgent(resolved, resolved.tool_extras?.claude) };
}

/**
 * Render an AgentSpec for Claude Internal.
 * Same format as Claude — YAML frontmatter + body.
 */
export function renderForClaudeInternal(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'claude-internal');
  return { ext: '.md', content: renderMarkdownAgent(resolved, resolved.tool_extras?.['claude-internal']) };
}

/**
 * Render an AgentSpec for CodeBuddy.
 * Same format as Claude, but merges tool_extras.codebuddy into frontmatter.
 */
export function renderForCodebuddy(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'codebuddy');
  return { ext: '.md', content: renderMarkdownAgent(resolved, resolved.tool_extras?.codebuddy) };
}

/**
 * Render an AgentSpec for Codex.
 * Output: TOML with developer_instructions and flattened tool_extras.codex fields.
 */
export function renderForCodex(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'codex');
  return { ext: '.toml', content: renderTomlAgent(resolved, resolved.tool_extras?.codex) };
}

/**
 * Render an AgentSpec for Codex Internal.
 * Same format as Codex — TOML with developer_instructions.
 */
export function renderForCodexInternal(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'codex-internal');
  return { ext: '.toml', content: renderTomlAgent(resolved, resolved.tool_extras?.['codex-internal']) };
}

/**
 * Render an AgentSpec for Cursor.
 * Output: YAML frontmatter (.md) using agent_id instead of name.
 */
export function renderForCursor(spec: AgentSpec): RenderResult {
  spec = materializeAgent(spec, 'cursor');
  const frontmatterData: Record<string, unknown> = {
    agent_id: spec.name,
    description: spec.description,
  };
  if (spec.tools !== undefined && spec.tools.length > 0) {
    frontmatterData['tools'] = spec.tools;
  }
  // Flatten tool_extras.cursor into frontmatter
  const extras = spec.tool_extras?.['cursor'];
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (key === 'tools_style') continue;
      frontmatterData[key] = value;
    }
  }
  const content = matter.stringify(spec.instructions, frontmatterData);
  return { ext: '.md', content };
}

/** Qwen uses the markdown frontmatter/body agent contract. */
export function renderForQwen(spec: AgentSpec): RenderResult {
  const resolved = materializeAgent(spec, 'qwen');
  return { ext: '.md', content: renderMarkdownAgent(resolved, resolved.tool_extras?.qwen) };
}

export function agentFilename(spec: AgentSpec, tool: ToolName): string {
  return spec.hosts?.[tool]?.filename ?? spec.filename ?? spec.name;
}

function materializeAgent(spec: AgentSpec, tool: ToolName): AgentSpec {
  const host = spec.hosts?.[tool];
  if (!host) return spec;
  const nativePermissions: Record<string, unknown> = { ...(spec.permissions ?? {}), ...(host.permissions ?? {}) };
  if (tool === 'codex' || tool === 'codex-internal' || tool === 'tcodex') {
    if (host.sandbox_mode !== undefined) nativePermissions.sandbox_mode = host.sandbox_mode;
  }
  if (tool === 'claude' || tool === 'claude-internal' || tool === 'tclaude' || tool === 'codebuddy') {
    if (host.permission_mode !== undefined) nativePermissions.permissionMode = host.permission_mode;
  }
  if (tool === 'qwen' && host.approval_mode !== undefined) nativePermissions.approvalMode = host.approval_mode;
  return {
    ...spec,
    ...(host.name !== undefined ? { name: host.name } : {}),
    ...(host.description !== undefined ? { description: host.description } : {}),
    ...(host.instructions !== undefined ? { instructions: host.instructions } : {}),
    ...(host.model !== undefined ? { model: host.model } : {}),
    ...(host.model_ref !== undefined ? { model_ref: host.model_ref } : {}),
    ...(host.effort !== undefined ? { effort: host.effort } : {}),
    ...(host.tools !== undefined ? { tools: host.tools } : {}),
    ...(Object.keys(nativePermissions).length > 0 ? { permissions: nativePermissions } : {}),
    ...(host.tools_style !== undefined ? { tool_extras: { ...spec.tool_extras, [tool]: { ...(spec.tool_extras?.[tool] ?? {}), tools_style: host.tools_style } } } : {}),
    ...(host.tool_extras !== undefined ? { tool_extras: { ...spec.tool_extras, [tool]: host.tool_extras } } : {}),
  };
}

// ─── Internal render helpers ─────────────────────────────────────────────────

/**
 * Build a gray-matter .md file: YAML frontmatter (name/description/model?/tools?/extras) + body.
 */
function renderMarkdownAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
  const lines = ['---', `name: ${spec.name}`, `description: ${spec.description}`];
  if (spec.model !== undefined) lines.push(`model: ${spec.model}`);
  if (spec.effort !== undefined) lines.push(`effort: ${spec.effort}`);
  if (spec.permissions) {
    for (const [key, value] of Object.entries(spec.permissions)) lines.push(`${key}: ${String(value)}`);
  }
  if (spec.tools !== undefined && spec.tools.length > 0) {
    if (extras?.tools_style === 'comma_separated') {
      lines.push(`tools: ${spec.tools.join(', ')}`);
    } else {
      lines.push('tools:');
      lines.push(...spec.tools.map((tool) => `  - ${tool}`));
    }
  }
  // Flatten tool-private extras into frontmatter
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (key === 'tools_style') continue;
      lines.push(`${key}: ${String(value)}`);
    }
  }
  const body = spec.instructions.replace(/\n*$/, '');
  return `${lines.join('\n')}\n---\n\n${body}\n`;
}

/**
 * Build a smol-toml TOML file: name/description/developer_instructions/model?/extras.
 * Note: `tools` is intentionally omitted from TOML output — Codex uses mcp_servers instead.
 */
function renderTomlAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
  const tomlData: Record<string, unknown> = { name: spec.name, description: spec.description };
  if (spec.model !== undefined) {
    tomlData['model'] = spec.model;
  }
  if (spec.effort !== undefined) tomlData['model_reasoning_effort'] = spec.effort;
  if (spec.permissions) Object.assign(tomlData, spec.permissions);
  // Flatten tool-private extras into top-level TOML fields
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (key === 'tools_style') continue;
      tomlData[key] = value;
    }
  }
  // A table header changes the scope of every later key. Let the serializer
  // place root instructions before tables (agents, mcp_servers, permissions).
  // Preserve the existing byte format for scalar-only configurations.
  if (Object.values(tomlData).some((value) => value !== null && typeof value === 'object')) {
    return stringifyToml({ ...tomlData, developer_instructions: spec.instructions.replace(/\n*$/, '') });
  }
  const prefix = stringifyToml(tomlData).trimEnd();
  const instructions = spec.instructions.replace(/\n*$/, '').replaceAll('"""', '\\"\\"\\"');
  return `${prefix}\ndeveloper_instructions = """\n${instructions}\n"""\n`;
}

// ─── Reverse: tool-native format → AgentSpec ────────────────────────────────

/** Result of reversing a tool-native agent file. */
export type ReverseResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; reason: string };

/** Common fields that belong in the AgentSpec root (not tool_extras). */
const COMMON_CLAUDE_FIELDS = new Set(['name', 'description', 'model', 'model_ref', 'effort', 'permissions', 'tools']);
const COMMON_CURSOR_FIELDS = new Set(['agent_id', 'description', 'model', 'model_ref', 'effort', 'permissions', 'tools']);
const COMMON_CODEX_FIELDS = new Set(['name', 'description', 'developer_instructions', 'model', 'model_ref', 'effort', 'permissions']);

/**
 * Reverse a Claude-format .md file into an AgentSpec.
 * claude-internal reuses this same function.
 *
 * @param filePath - Absolute path, used to derive the agent name.
 * @param content  - File content string.
 */
export function reverseFromClaude(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = (fm['name'] as string | undefined) ?? path.basename(filePath, '.md');
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  // Collect non-common frontmatter fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_CLAUDE_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (fm['model_ref'] !== undefined) spec.model_ref = fm['model_ref'] as string;
  if (fm['effort'] !== undefined) spec.effort = fm['effort'] as string;
  if (fm['permissions'] !== undefined) spec.permissions = fm['permissions'] as Record<string, unknown>;
  if (fm['tools'] !== undefined) spec.tools = fm['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { claude: extras };

  return { ok: true, spec };
}

/**
 * Reverse a CodeBuddy-format .md file into an AgentSpec.
 * Format is identical to Claude, but tool_extras key is 'codebuddy'.
 */
export function reverseFromCodebuddy(filePath: string, content: string): ReverseResult {
  const result = reverseFromClaude(filePath, content);
  if (!result.ok) return result;

  const spec = result.spec;
  // Move extras from 'claude' to 'codebuddy'
  if (spec.tool_extras?.['claude']) {
    spec.tool_extras = { codebuddy: spec.tool_extras['claude'] };
  }
  return { ok: true, spec };
}

/**
 * Reverse a Codex-format .toml file into an AgentSpec.
 * codex-internal reuses this same function.
 *
 * @param filePath - Absolute path, used to derive the agent name.
 * @param content  - File content string.
 */
export function reverseFromCodex(filePath: string, content: string): ReverseResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const name = (parsed['name'] as string | undefined) ?? path.basename(filePath, '.toml');
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!parsed['description']) return { ok: false, reason: 'missing field description' };
  if (!parsed['developer_instructions']) return { ok: false, reason: 'missing field developer_instructions' };

  // Collect non-common fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!COMMON_CODEX_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: parsed['description'] as string,
    instructions: parsed['developer_instructions'] as string,
  };
  if (parsed['model'] !== undefined) spec.model = parsed['model'] as string;
  if (parsed['model_ref'] !== undefined) spec.model_ref = parsed['model_ref'] as string;
  if (parsed['effort'] !== undefined) spec.effort = parsed['effort'] as string;
  if (parsed['permissions'] !== undefined) spec.permissions = parsed['permissions'] as Record<string, unknown>;
  if (Object.keys(extras).length > 0) spec.tool_extras = { codex: extras };

  return { ok: true, spec };
}

/**
 * Reverse a Cursor-format .md file into an AgentSpec.
 * Uses agent_id instead of name in the frontmatter.
 */
export function reverseFromCursor(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = (fm['agent_id'] as string | undefined) ?? path.basename(filePath, '.md');
  if (!name) return { ok: false, reason: 'missing field agent_id' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  // Collect non-common frontmatter fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_CURSOR_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (fm['model_ref'] !== undefined) spec.model_ref = fm['model_ref'] as string;
  if (fm['effort'] !== undefined) spec.effort = fm['effort'] as string;
  if (fm['permissions'] !== undefined) spec.permissions = fm['permissions'] as Record<string, unknown>;
  if (fm['tools'] !== undefined) spec.tools = fm['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { cursor: extras };

  return { ok: true, spec };
}

/** Reverse a Qwen markdown agent using the v2 frontmatter/body contract. */
export function reverseFromQwen(filePath: string, content: string): ReverseResult {
  const result = reverseFromClaude(filePath, content);
  if (!result.ok) return result;
  const spec = result.spec;
  if (spec.tool_extras?.claude) {
    spec.tool_extras = { qwen: spec.tool_extras.claude };
  }
  return { ok: true, spec };
}

// ─── Merge multi-tool reverse results ───────────────────────────────────────

/** Conflict details when merging results from multiple tools. */
export interface MergeConflict {
  field: string;
  values: Record<string, unknown>;
}

/** Result of merging multiple tool AgentSpecs into one canonical AgentSpec. */
export type MergeResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; conflicts: MergeConflict[] };

/** Common fields subject to conflict detection during merge. */
const MERGE_COMMON_FIELDS: Array<keyof AgentSpec> = [
  'name',
  'description',
  'instructions',
  'model',
  'model_ref',
  'effort',
  'permissions',
  'tools',
];

/**
 * Merge AgentSpec results from multiple tools into a single canonical AgentSpec.
 *
 * Common fields (name, description, instructions, model, tools) are compared
 * across tools — any discrepancy is reported as a conflict.
 * Tool-private fields (tool_extras) are merged by union, as they are independent.
 *
 * @param perTool - Map of tool name → AgentSpec (only successful reverses included).
 * @returns Merged spec if all common fields agree, or conflict details otherwise.
 */
export function mergeReverseResults(
  perTool: Partial<Record<ToolName, AgentSpec>>,
): MergeResult {
  const entries = Object.entries(perTool) as Array<[ToolName, AgentSpec]>;
  if (entries.length === 0) {
    return { ok: false, conflicts: [{ field: 'all', values: {} }] };
  }
  if (entries.length === 1) {
    return { ok: true, spec: entries[0][1] };
  }

  const conflicts: MergeConflict[] = [];

  // Check each common field for discrepancies
  for (const field of MERGE_COMMON_FIELDS) {
    const valuesByTool: Record<string, unknown> = {};
    for (const [tool, spec] of entries) {
      const value = spec[field];
      if (value !== undefined) {
        valuesByTool[tool] = value;
      }
    }
    if (Object.keys(valuesByTool).length === 0) continue;

    // Normalize: convert to JSON for deep comparison
    const uniqueValues = new Set(Object.values(valuesByTool).map((v) => JSON.stringify(v)));
    if (uniqueValues.size > 1) {
      conflicts.push({ field, values: valuesByTool });
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }

  // All common fields agree — pick values from first spec, merge tool_extras
  const baseSpec = { ...entries[0][1] };
  const mergedExtras: AgentSpec['tool_extras'] = {};

  for (const [, spec] of entries) {
    if (spec.tool_extras) {
      for (const [toolKey, extras] of Object.entries(spec.tool_extras) as Array<[ToolName, Record<string, unknown>]>) {
        if (!mergedExtras[toolKey]) {
          mergedExtras[toolKey] = {};
        }
        Object.assign(mergedExtras[toolKey]!, extras);
      }
    }
  }

  if (Object.keys(mergedExtras).length > 0) {
    baseSpec.tool_extras = mergedExtras;
  }

  return { ok: true, spec: baseSpec };
}

// ─── Dispatch helpers ─────────────────────────────────────────────────────────

/**
 * Render an AgentSpec for the specified tool.
 *
 * @param spec - The agent specification.
 * @param tool - Target tool name.
 * @returns Rendered file extension and content.
 */
export function renderForTool(spec: AgentSpec, tool: ToolName): RenderResult {
  switch (tool) {
    case 'claude': return renderForClaude(spec);
    case 'claude-internal': return renderForClaudeInternal(spec);
    case 'tclaude': return renderForClaude(spec);
    case 'codebuddy': return renderForCodebuddy(spec);
    case 'codex': return renderForCodex(spec);
    case 'codex-internal': return renderForCodexInternal(spec);
    case 'tcodex': return renderForCodex(spec);
    case 'cursor': return renderForCursor(spec);
    case 'qwen': return renderForQwen(spec);
  }
}
