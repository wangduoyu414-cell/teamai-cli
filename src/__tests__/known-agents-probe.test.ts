import { describe, expect, it } from 'vitest';
import { KNOWN_AGENTS, getEffectiveAgents } from '../known-agents.js';

describe('host probe paths', () => {
  it('keeps Codex installation probe independent from central skills path', () => {
    const codex = KNOWN_AGENTS.find((agent) => agent.id === 'codex');
    expect(codex?.skillsPath).toBe('.agents/skills');
    expect(codex?.probePath).toBe('.codex');
  });

  it('allows team config to override both skills and probe paths', () => {
    const [codex] = getEffectiveAgents({ toolPaths: { codex: { skills: '.agents/skills', probe: '.codex' } } } as any);
    expect(codex).toBeDefined();
    const resolved = getEffectiveAgents({ toolPaths: { codex: { skills: '.central/skills', probe: '.codex' } } } as any).find((agent) => agent.id === 'codex');
    expect(resolved?.skillsPath).toBe('.central/skills');
    expect(resolved?.probePath).toBe('.codex');
  });
});
