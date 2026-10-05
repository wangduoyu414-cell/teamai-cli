import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import matter from 'gray-matter';
import { stringify as stringifyToml, parse as parseToml } from 'smol-toml';
import { getDispatchCommand } from '../builtin-hooks.js';

// ─── Tool name type ──────────────────────────────────────────────────────────

export type ToolName = 'claude' | 'claude-internal' | 'tclaude' | 'codebuddy' | 'codex' | 'codex-internal' | 'tcodex' | 'cursor' | 'copilot' | 'joycode' | 'qoder' | 'qoder-cn' | 'kiro' | 'zcode' | 'omp' | 'opencode' | 'workbuddy' | 'qwen';

export const ALL_SUPPORTED_TOOLS: ToolName[] = [
  'claude',
  'claude-internal',
  'tclaude',
  'codebuddy',
  'codex',
  'codex-internal',
  'tcodex',
  'cursor',
  'copilot',
  'joycode',
  'qoder',
  'qoder-cn',
  'kiro',
  'zcode',
  'omp',
  'opencode',
  'workbuddy',
  'qwen',
];

export type AgentFileExtension = '.agent.md' | '.md' | '.toml' | '.json';

/**
 * Every extension an agent render may carry on disk.
 *
 * Writers use `agentFileExtensionForTool`. Scanners and deleters use this list,
 * so a removal clears a name on every tool whatever format that tool renders.
 */
export const AGENT_FILE_EXTENSIONS = ['.agent.md', '.md', '.toml', '.json'] as const satisfies readonly AgentFileExtension[];

/**
 * Extract an agent name stem from a filename.
 * Accepts every native agent extension; returns null for other files.
 */
export function agentStemFromFilename(filename: string): string | null {
  for (const ext of AGENT_FILE_EXTENSIONS) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return null;
}

export function agentFileExtensionForTool(tool: ToolName): AgentFileExtension {
  switch (tool) {
    case 'copilot':
      return '.agent.md';
    case 'codex':
    case 'codex-internal':
    case 'tcodex':
      return '.toml';
    case 'kiro':
      return '.json';
    default:
      return '.md';
  }
}

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
    copilot?: Record<string, unknown>;
    joycode?: Record<string, unknown>;
    qoder?: Record<string, unknown>;
    'qoder-cn'?: Record<string, unknown>;
    kiro?: Record<string, unknown>;
    zcode?: Record<string, unknown>;
    omp?: Record<string, unknown>;
    opencode?: Record<string, unknown>;
    workbuddy?: Record<string, unknown>;
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

  if (obj['schema_version'] !== undefined && obj['schema_version'] !== 1 && obj['schema_version'] !== 2) return { ok: false, reason: `${filename}: unsupported schema_version` };
  if (obj['targets'] !== undefined && (!Array.isArray(obj['targets']) || !(obj['targets'] as unknown[]).every((tool) => typeof tool === 'string' && ALL_SUPPORTED_TOOLS.includes(tool as ToolName)))) return { ok: false, reason: `${filename}: invalid targets` };
  if (obj['hosts'] !== undefined) {
    const raw = obj['hosts'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) return { ok: false, reason: `${filename}: hosts must be a nonempty object` };
    for (const [tool, host] of Object.entries(raw)) {
      if (!ALL_SUPPORTED_TOOLS.includes(tool as ToolName) || !host || typeof host !== 'object' || Array.isArray(host)) return { ok: false, reason: `${filename}: invalid host ${tool}` };
      for (const key of ['name', 'description', 'instructions', 'filename', 'model', 'model_ref', 'effort']) {
        if (key in host && (typeof host[key] !== 'string' || !host[key].trim())) return { ok: false, reason: `${filename}: invalid ${tool}.${key}` };
      }
    }
  }
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
      ...(obj['schema_version'] === 2 ? { schema_version: 2 as const } : {}),
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
  ext: AgentFileExtension;
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
 * Render an AgentSpec for JoyCode.
 * JoyCode agents use Markdown with YAML frontmatter, matching the common
 * name/description/instructions representation.
 */
export function renderForJoycode(spec: AgentSpec): RenderResult {
  return {
    ext: agentFileExtensionForTool('joycode'),
    content: renderMarkdownAgent(spec, spec.tool_extras?.['joycode']),
  };
}

/**
 * Render an AgentSpec for WorkBuddy.
 * Same format as Claude, but merges tool_extras.workbuddy into frontmatter.
 */
export function renderForWorkbuddy(spec: AgentSpec): RenderResult {
  return {
    ext: agentFileExtensionForTool('workbuddy'),
    content: renderMarkdownAgent(spec, spec.tool_extras?.['workbuddy']),
  };
}

/** TeamAI-managed Kiro CLI session-start hook embedded in each agent config. */
export const KIRO_SESSION_START_COMMAND = getDispatchCommand('session-start', 'kiro');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedKiroSessionHook(value: unknown): boolean {
  return isRecord(value)
    && typeof value['command'] === 'string'
    && value['command'].includes('teamai hook-dispatch session-start --tool kiro');
}

/**
 * Render a Kiro custom agent as JSON. JSON is supported by both the 2.x and 3.x
 * agent harnesses, while 2.x requires this format for embedded `agentSpawn`
 * hooks. TeamAI owns only its session-start entry and preserves all other
 * Kiro-private fields and hook entries from `tool_extras.kiro`.
 */
export function renderForKiro(spec: AgentSpec): RenderResult {
  const extras = { ...spec.tool_extras?.['kiro'] };
  const existingHooks = isRecord(extras['hooks']) ? { ...extras['hooks'] } : {};
  const existingAgentSpawn = Array.isArray(existingHooks['agentSpawn'])
    ? existingHooks['agentSpawn'].filter((entry) => !isManagedKiroSessionHook(entry))
    : [];
  existingHooks['agentSpawn'] = [
    ...existingAgentSpawn,
    { command: KIRO_SESSION_START_COMMAND },
  ];
  extras['hooks'] = existingHooks;

  const json: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    prompt: spec.instructions,
  };
  if (spec.model !== undefined) json['model'] = spec.model;
  if (spec.tools !== undefined && spec.tools.length > 0) json['tools'] = spec.tools;
  Object.assign(json, extras);

  return {
    ext: agentFileExtensionForTool('kiro'),
    content: `${JSON.stringify(json, null, 2)}\n`,
  };
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
  if (spec.model !== undefined) {
    frontmatterData['model'] = spec.model;
  }
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
  return { ext: agentFileExtensionForTool('cursor'), content };
}

const COPILOT_TOOL_ALIASES = new Map<string, string>([
  ['execute', 'execute'],
  ['shell', 'execute'],
  ['bash', 'execute'],
  ['powershell', 'execute'],
  ['read', 'read'],
  ['notebookread', 'read'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['write', 'edit'],
  ['notebookedit', 'edit'],
  ['search', 'search'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['agent', 'agent'],
  ['custom-agent', 'agent'],
  ['task', 'agent'],
  ['web', 'web'],
  ['websearch', 'web'],
  ['webfetch', 'web'],
  ['todo', 'todo'],
  ['todowrite', 'todo'],
]);

/** Collapse compatible tool names onto Copilot's primary aliases. */
function normalizeCopilotTools(tools: string[] | string): string[] {
  const values = Array.isArray(tools)
    ? tools
    : tools.split(',').map((tool) => tool.trim()).filter(Boolean);
  return [...new Set(values.map((tool) => COPILOT_TOOL_ALIASES.get(tool.toLowerCase()) ?? tool))];
}

/** Render GitHub Copilot CLI's official `<name>.agent.md` profile. */
export function renderForCopilot(spec: AgentSpec): RenderResult {
  const frontmatterData: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
  };
  if (spec.model !== undefined) frontmatterData['model'] = spec.model;
  if (spec.tools !== undefined) frontmatterData['tools'] = normalizeCopilotTools(spec.tools);
  Object.assign(frontmatterData, spec.tool_extras?.copilot ?? {});
  return {
    ext: agentFileExtensionForTool('copilot'),
    content: matter.stringify(spec.instructions, frontmatterData),
  };
}

/**
 * Render an AgentSpec for OpenCode.
 * Output: YAML frontmatter (.md). OpenCode derives the agent name from the
 * filename, so `name` is intentionally omitted from frontmatter. `mode` defaults
 * to `subagent` (teamai only syncs subagents). OpenCode's `tools` field is
 * deprecated in favor of `permission`, so the common `tools` list is not emitted;
 * a team that needs per-tool permissions carries them in tool_extras.opencode
 * (e.g. `permission: { edit: deny }`), which is flattened into the frontmatter.
 */
export function renderForOpencode(spec: AgentSpec): RenderResult {
  const frontmatterData: Record<string, unknown> = {
    description: spec.description,
    mode: 'subagent',
  };
  if (spec.model !== undefined) {
    frontmatterData['model'] = spec.model;
  }
  // Flatten tool_extras.opencode into frontmatter (mode/permission/temperature/…).
  const extras = spec.tool_extras?.['opencode'];
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      frontmatterData[key] = value;
    }
  }
  const content = matter.stringify(spec.instructions, frontmatterData);
  return { ext: agentFileExtensionForTool('opencode'), content };
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
  const nativePermissions: Record<string, unknown> = { ...spec.permissions, ...host.permissions };
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
    ...(host.tools_style !== undefined ? { tool_extras: { ...spec.tool_extras, [tool]: { ...spec.tool_extras?.[tool], tools_style: host.tools_style } } } : {}),
    ...(host.tool_extras !== undefined ? { tool_extras: { ...spec.tool_extras, [tool]: host.tool_extras } } : {}),
  };
}

// ─── Internal render helpers ─────────────────────────────────────────────────

/**
 * Build a gray-matter .md file: YAML frontmatter (name/description/model?/tools?/extras) + body.
 */
function renderV2MarkdownAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
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

function renderMarkdownAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
  if (spec.schema_version === 2) return renderV2MarkdownAgent(spec, extras);
  const frontmatterData: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
  };
  if (spec.model !== undefined) {
    frontmatterData['model'] = spec.model;
  }
  if (spec.tools !== undefined && spec.tools.length > 0) {
    frontmatterData['tools'] = spec.tools;
  }
  // Flatten tool-private extras into frontmatter
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      frontmatterData[key] = value;
    }
  }
  return matter.stringify(spec.instructions, frontmatterData);
}

/**
 * smol-toml's `stringify` always emits basic strings, so every newline in a
 * prompt becomes a literal `\n` escape and a 16-line prompt collapses into one
 * ~700-character line — unreadable in an editor and unreviewable in `git diff`.
 *
 * A multi-line literal string (`'''`) keeps real newlines and does no escape
 * processing, so the content round-trips byte-for-byte and this needs no
 * escaping logic. It is only usable when the value cannot terminate it early:
 * a body containing `'''`, a body ending in `'` (which would close the
 * delimiter), or control characters such as `\r` that a literal cannot carry.
 * Those fall back to the basic form, which escapes correctly.
 */
function canUseTomlLiteral(value: string): boolean {
  if (!value.includes('\n')) return false;
  if (value.includes("'''")) return false;
  if (value.endsWith("'")) return false;
  // Control characters a literal string cannot carry (`\r`, NUL, DEL, ...):
  // TOML 1.0 bans C0 other than tab and newline, plus DEL, and smol-toml
  // rejects the whole document on them. C1 (U+0080-U+009F) is allowed.
  if (/(?![\t\n\u0080-\u009f])\p{Cc}/u.test(value)) return false;
  return true;
}

/**
 * Render one string value as a TOML multi-line literal.
 *
 * The newline right after the opening delimiter is trimmed by the TOML spec,
 * so it is the delimiter's own and must not be doubled: `'''\nvalue'''`
 * round-trips exactly, while `'''\nvalue\n'''` appends a newline the value
 * never had (verified against smol-toml for values with and without a
 * trailing newline).
 */
function tomlStringLiteral(value: string): string {
  return `'''\n${value}'''`;
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
  if (spec.schema_version === 2) {
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
  tomlData['developer_instructions'] = spec.instructions;
  // Render first, then substitute: a literal string is emitted verbatim, so the
  // multi-line values have to bypass `stringify` rather than be post-processed.
  const rendered = stringifyToml(tomlData);
  return Object.entries(tomlData)
    .reduce((text, [key, value]) => {
      if (typeof value !== 'string' || !canUseTomlLiteral(value)) return text;
      const escaped = `${key} = ${JSON.stringify(value)}\n`;
      if (!text.includes(escaped)) return text;
      // A function replacement, not a string: the value is agent-authored
      // content, and a string replacement would let the $-sequences
      // ($&, $$, $', $`) expand inside it, silently eating dollars out of
      // shell instructions. The callback return value is used verbatim.
      return text.replace(escaped, () => `${key} = ${tomlStringLiteral(value)}\n`);
    }, rendered);
}

// ─── Reverse: tool-native format → AgentSpec ────────────────────────────────

/** Result of reversing a tool-native agent file. */
export type ReverseResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; reason: string };

/** Common fields that belong in the AgentSpec root (not tool_extras). */
const COMMON_CLAUDE_FIELDS = new Set(['name', 'description', 'model', 'tools', 'model_ref', 'effort', 'permissions']);
const COMMON_CURSOR_FIELDS = new Set(['agent_id', 'description', 'model', 'tools', 'model_ref', 'effort', 'permissions']);
const COMMON_COPILOT_FIELDS = new Set(['name', 'description', 'model', 'tools']);
const COMMON_CODEX_FIELDS = new Set(['name', 'description', 'developer_instructions', 'model', 'model_ref', 'effort', 'permissions']);
const COMMON_KIRO_FIELDS = new Set(['name', 'description', 'prompt', 'model', 'tools']);
// `mode` is not carried to the AgentSpec root — it is an OpenCode-only concept
// (teamai always renders `subagent`), so it round-trips through tool_extras.opencode.
const COMMON_OPENCODE_FIELDS = new Set(['description', 'model']);

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

/** Reverse a Copilot `.agent.md` profile into TeamAI's canonical agent spec. */
export function reverseFromCopilot(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();
  const stem = agentStemFromFilename(path.basename(filePath));
  const name = (fm['name'] as string | undefined) ?? stem;
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_COPILOT_FIELDS.has(key)) extras[key] = value;
  }
  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (fm['tools'] !== undefined) spec.tools = fm['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { copilot: extras };
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
 * Reverse a JoyCode-format .md file into an AgentSpec.
 * Its common Markdown format matches Claude; private fields are namespaced to
 * tool_extras.joycode so a pull/push round trip keeps tool-specific metadata.
 */
export function reverseFromJoycode(filePath: string, content: string): ReverseResult {
  const result = reverseFromClaude(filePath, content);
  if (!result.ok) return result;

  const spec = result.spec;
  if (spec.tool_extras?.['claude']) {
    spec.tool_extras = { joycode: spec.tool_extras['claude'] };
  }
  return { ok: true, spec };
}

/**
 * Reverse a WorkBuddy-format .md file into an AgentSpec.
 * Format is identical to Claude, but tool_extras key is 'workbuddy'.
 */
export function reverseFromWorkbuddy(filePath: string, content: string): ReverseResult {
  const result = reverseFromClaude(filePath, content);
  if (!result.ok) return result;

  const spec = result.spec;
  // Move extras from 'claude' to 'workbuddy'
  if (spec.tool_extras?.['claude']) {
    spec.tool_extras = { workbuddy: spec.tool_extras['claude'] };
  }
  return { ok: true, spec };
}

/**
 * Reverse a Kiro JSON agent config. The TeamAI-managed `agentSpawn` entry is a
 * local delivery detail, so it is removed before remaining private fields are
 * returned under `tool_extras.kiro`.
 */
export function reverseFromKiro(filePath: string, content: string): ReverseResult {
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(content) as unknown;
    if (!isRecord(raw)) return { ok: false, reason: 'agent config must be a JSON object' };
    parsed = raw;
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const name = (parsed['name'] as string | undefined) ?? path.basename(filePath, '.json');
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!parsed['description']) return { ok: false, reason: 'missing field description' };
  if (!parsed['prompt']) return { ok: false, reason: 'missing field prompt' };

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!COMMON_KIRO_FIELDS.has(key)) extras[key] = value;
  }

  if (isRecord(extras['hooks'])) {
    const hooks = { ...extras['hooks'] };
    if (Array.isArray(hooks['agentSpawn'])) {
      const remaining = hooks['agentSpawn'].filter((entry) => !isManagedKiroSessionHook(entry));
      if (remaining.length > 0) hooks['agentSpawn'] = remaining;
      else delete hooks['agentSpawn'];
    }
    if (Object.keys(hooks).length > 0) extras['hooks'] = hooks;
    else delete extras['hooks'];
  }

  const spec: AgentSpec = {
    name,
    description: parsed['description'] as string,
    instructions: parsed['prompt'] as string,
  };
  if (parsed['model'] !== undefined) spec.model = parsed['model'] as string;
  if (parsed['tools'] !== undefined) spec.tools = parsed['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { kiro: extras };
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

/**
 * Reverse an OpenCode-format .md file into an AgentSpec.
 * The agent name is derived from the filename (OpenCode has no `name` in
 * frontmatter). Non-common frontmatter fields (mode, permission, temperature, …)
 * are collected into tool_extras.opencode.
 */
export function reverseFromOpencode(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = path.basename(filePath, '.md');
  if (!name) return { ok: false, reason: 'missing agent name (empty filename)' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  // Collect non-common frontmatter fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_OPENCODE_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (Object.keys(extras).length > 0) spec.tool_extras = { opencode: extras };

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
  spec = materializeAgent(spec, tool);
  switch (tool) {
    case 'claude': return renderForClaude(spec);
    case 'claude-internal': return renderForClaudeInternal(spec);
    case 'tclaude': return renderForClaude(spec);
    case 'codebuddy': return renderForCodebuddy(spec);
    case 'codex': return renderForCodex(spec);
    case 'codex-internal': return renderForCodexInternal(spec);
    case 'tcodex': return renderForCodex(spec);
    case 'cursor': return renderForCursor(spec);
    case 'copilot': return renderForCopilot(spec);
    case 'joycode': return renderForJoycode(spec);
    case 'qoder': return renderForClaude(spec);
    case 'qoder-cn': return renderForClaude(spec);
    case 'kiro': return renderForKiro(spec);
    case 'zcode': return renderForClaude(spec);
    case 'omp': return renderForClaude(spec);
    case 'opencode': return renderForOpencode(spec);
    case 'workbuddy': return renderForWorkbuddy(spec);
    case 'qwen': return renderForQwen(spec);
  }
}
