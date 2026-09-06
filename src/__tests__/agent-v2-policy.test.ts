import { describe, expect, it } from 'vitest';
import { parseAgentYaml, renderForTool, agentFilename } from '../resources/agent-format.js';
import { resolveModelRef } from '../model-policy.js';
import { parse as parseToml } from 'smol-toml';

describe('Agent Schema v2 host-first policy', () => {
  const yaml = `schema_version: 2
logical_id: bounded_implementer
hosts:
  codex:
    filename: implementer.toml
    name: bounded-implementer
    description: Implement safely
    model_ref: host_mappings.codex.bounded_implementer
    effort: xhigh
    sandbox_mode: workspace-write
    instructions: |
      Implement the requested change.
  qwen:
    filename: implementer.md
    name: bounded-implementer
    description: Implement safely
    model_ref: host_mappings.qwen.agent_variants.bounded_implementer
    approval_mode: auto-edit
    tools_style: list
    instructions: |
      Implement the requested change.
`;

  it('parses host-first v2 and scopes deployment to declared hosts', () => {
    const result = parseAgentYaml(yaml, 'bounded_implementer.yaml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.schema_version).toBe(2);
    expect(Object.keys(result.spec.hosts ?? {})).toEqual(['codex', 'qwen']);
    expect(agentFilename(result.spec, 'codex')).toBe('implementer.toml');
    expect(agentFilename(result.spec, 'qwen')).toBe('implementer.md');
  });

  it('renders host-native permission keys and does not leak model_ref', () => {
    const result = parseAgentYaml(yaml, 'bounded_implementer.yaml');
    if (!result.ok) throw new Error(result.reason);
    const codex = renderForTool(result.spec, 'codex').content;
    const qwen = renderForTool(result.spec, 'qwen').content;
    expect(codex).toContain('sandbox_mode = "workspace-write"');
    expect(codex).toContain('model_reasoning_effort = "xhigh"');
    expect(codex).not.toContain('model_ref');
    expect(qwen).toContain('approvalMode: auto-edit');
    expect(qwen).not.toContain('model_ref');
  });

  it('resolves direct and nested model policy references strictly', () => {
    const policy = {
      schema_version: 1,
      policy: {},
      roles: {},
      host_mappings: {
        codex: { bounded_implementer: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' } },
        qwen: { agent_variants: { bounded_implementer: { model: 'qwen-max', reasoning_effort: 'high' } } },
      },
    } as any;
    expect(resolveModelRef(policy, 'codex', 'host_mappings.codex.bounded_implementer')).toEqual({ model: 'gpt-5.6-terra', effort: 'xhigh' });
    expect(resolveModelRef(policy, 'qwen', 'host_mappings.qwen.agent_variants.bounded_implementer')).toEqual({ model: 'qwen-max', effort: 'high' });
    expect(() => resolveModelRef(policy, 'codex', 'host_mappings.codex.missing')).toThrow();
  });

  it('keeps instructions at the root when a Codex role disables delegation', () => {
    const result = parseAgentYaml(yaml.replace('    sandbox_mode: workspace-write',
      '    sandbox_mode: workspace-write\n    tool_extras:\n      agents:\n        enabled: false'), 'bounded_implementer.yaml');
    if (!result.ok) throw new Error(result.reason);
    const parsed = parseToml(renderForTool(result.spec, 'codex').content);
    expect(parsed.developer_instructions).toBe('Implement the requested change.');
    expect(parsed.agents).toEqual({ enabled: false });
    expect(parsed.sandbox_mode).toBe('workspace-write');
    expect(parsed.model_reasoning_effort).toBe('xhigh');
  });
});
