import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../config.js', () => ({
    loadLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
    detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/fs.js', () => ({
    pathExists: vi.fn(),
    readFileSafe: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../agent-version.js', () => ({
    getAgentVersion: vi.fn(),
}));

// Mock the tgit provider to avoid side effects
vi.mock('../providers/tgit/index.js', () => ({
    isGfInstalled: vi.fn().mockResolvedValue(true),
    gfIsAuthenticated: vi.fn().mockResolvedValue(true),
}));

// ── Imports (after mocks) ────────────────────────────────

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { pathExists, readFileSafe } from '../utils/fs.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from '../hooks.js';
import { getAgentVersion } from '../agent-version.js';
import { doctor } from '../doctor.js';

const mockedLoadLocalConfig = loadLocalConfig as Mock;
const mockedLoadTeamConfig = loadTeamConfig as Mock;
const mockedPathExists = pathExists as Mock;
const mockedReadFileSafe = readFileSafe as Mock;
const mockedGetAgentVersion = getAgentVersion as Mock;

const mockLocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
};

const mockTeamConfig = {
    team: 'test-team',
    repo: 'team/repo',
    provider: 'tgit' as const,
    toolPaths: {
        claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
    },
};

// Build a settings content that contains all subcommands
function buildFullHooksContent(): string {
    const lines = TEAMAI_HOOK_SUBCOMMANDS.map(
        (sub) => `"command": "bash -lc \\"teamai ${sub}\\""`,
    );
    return `{ "hooks": { ${lines.join(', ')} } }`;
}

// Build a settings content that is missing some subcommands
function buildPartialHooksContent(exclude: string[]): string {
    const subs = TEAMAI_HOOK_SUBCOMMANDS.filter((s) => !exclude.includes(s));
    const lines = subs.map(
        (sub) => `"command": "bash -lc \\"teamai ${sub}\\""`,
    );
    return `{ "hooks": { ${lines.join(', ')} } }`;
}

// ── Setup ────────────────────────────────────────────────

// Suppress console.log output in tests
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadLocalConfig.mockResolvedValue(mockLocalConfig);
    mockedLoadTeamConfig.mockResolvedValue(mockTeamConfig);
    mockedPathExists.mockResolvedValue(true);
    mockedReadFileSafe.mockResolvedValue(buildFullHooksContent());
    mockedGetAgentVersion.mockResolvedValue('');
});

// ── Tests ────────────────────────────────────────────────

describe('doctor — hook checks', () => {
    it('should pass when all subcommands are present in settings', async () => {
        await doctor({});

        // Should show the hooks check passing (✔)
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✔'),
        );
    });

    it('should fail when a subcommand is missing from settings', async () => {
        // Missing 'hook-dispatch' subcommand (the only required one now)
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) {
                // Return settings without hook-dispatch
                return '{ "hooks": { "command": "bash -lc \\"teamai pull\\"" } }';
            }
            if (filePath.includes('.zshrc') || filePath.includes('.bashrc')) {
                return '# [teamai:env:start]';
            }
            return null;
        });

        await doctor({});

        // Should show the hooks check failing (✖) with fix suggestion
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✖'),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('teamai hooks inject'),
        );
    });

    it('should fail when settings file does not exist', async () => {
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return false;
            return true;
        });

        await doctor({});

        // Should show at least one failing check
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✖'),
        );
    });

    it('should check all TEAMAI_HOOK_SUBCOMMANDS', () => {
        // With the merged dispatch format, only hook-dispatch is needed
        expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('hook-dispatch');
        expect(TEAMAI_HOOK_SUBCOMMANDS).toHaveLength(1);
    });

    it('should pass env check when env/env.yaml does not exist in team repo', async () => {
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.includes('env/env.yaml')) return false;
            return true;
        });
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return buildFullHooksContent();
            return null;
        });

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        const envLine = allCalls.find((msg: string) => msg.includes('Env variables injected'));
        expect(envLine).toContain('✔');
    });

    it('should pass env check when injectShellProfile is false', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
        });
        mockedPathExists.mockImplementation(async (filePath: string) => {
            if (filePath.includes('env.sh')) return false;
            return true;
        });
        mockedReadFileSafe.mockImplementation(async (filePath: string) => {
            if (filePath.includes('settings.json')) return buildFullHooksContent();
            return null;
        });

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        const envLine = allCalls.find((msg: string) => msg.includes('Env variables are not injected'));
        expect(envLine).toContain('✔');
    });

    it('should skip tools whose parent directory does not exist', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            toolPaths: {
                claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
                'codex-internal': { settings: '.codex-internal/hooks.json', skills: '.codex-internal/skills' },
            },
        });

        mockedPathExists.mockImplementation(async (filePath: string) => {
            // .codex-internal directory does not exist
            if (filePath.includes('.codex-internal')) return false;
            return true;
        });

        await doctor({});

        // Should NOT show codex-internal check at all (skipped)
        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        expect(allCalls.some((msg: string) => msg.includes('codex-internal'))).toBe(false);
        // Should still show claude check
        expect(allCalls.some((msg: string) => msg.includes('claude'))).toBe(true);
    });
});

describe('doctor — explicit host checks', () => {
    it('reports the validated WorkBuddy version for an explicitly selected host', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'user',
            enabledAgents: ['workbuddy'],
            hostRoots: { workbuddy: '/tmp/workbuddy' },
        });
        mockedGetAgentVersion.mockResolvedValue('5.3.13');

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        expect(allCalls.some((msg: string) => msg.includes('WorkBuddy: selected'))).toBe(true);
        expect(allCalls.some((msg: string) => msg.includes('✔ WorkBuddy version matches 5.3.13'))).toBe(true);
        expect(allCalls.some((msg: string) => msg.includes('runtime loading is a separate host smoke check'))).toBe(true);
    });

    it('fails DSH diagnostics when the installed version differs from the exact gate', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'user',
            enabledAgents: ['dsh'],
            hostRoots: { dsh: '/tmp/dsh' },
        });
        mockedGetAgentVersion.mockResolvedValue('0.1.2');

        await doctor({});

        const allCalls = consoleSpy.mock.calls.map((c) => c[0]);
        expect(allCalls.some((msg: string) => msg.includes('✖ DSH version matches 0.1.1-rc.1'))).toBe(true);
        expect(allCalls.some((msg: string) => msg.includes('Install DSH 0.1.1-rc.1'))).toBe(true);
    });

    it('does not infer duplicate DSH runtime loading from identical instruction files', async () => {
        mockedLoadLocalConfig.mockResolvedValue({
            ...mockLocalConfig,
            scope: 'user',
            enabledAgents: ['dsh'],
            hostRoots: { dsh: '/tmp/dsh' },
        });
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { instructions: { source: 'AGENTS.md' } },
        });
        mockedGetAgentVersion.mockResolvedValue('0.1.1-rc.1');
        mockedReadFileSafe.mockImplementation(async (filePath: string) => (
            filePath.includes('settings.json') ? buildFullHooksContent() : 'same instructions'
        ));

        const report = await doctor({ json: true });

        expect(report.notices).toContain(
            'Identical user-level and project-level AGENTS.md files exist in this workspace; TeamAI does not infer duplicate DSH runtime loading from file presence alone',
        );
        expect(report.notices.some((notice) => notice.includes('DSH is loading identical'))).toBe(false);
    });
});

describe('doctor — JSON report', () => {
    it('emits one machine-readable report without human output', async () => {
        mockedLoadTeamConfig.mockResolvedValue({
            ...mockTeamConfig,
            sharing: { env: { injectShellProfile: false } },
        });

        const report = await doctor({ json: true });

        expect(report).toMatchObject({
            schemaVersion: 1,
            ok: true,
            scope: 'user',
            provider: 'tgit',
            hosts: {
                workbuddy: { selected: false, runtimeSmoke: 'manual' },
                dsh: { selected: false, runtimeSmoke: 'opt-in-read-only' },
            },
        });
        const checkIds = report.checks.map((check) => check.id);
        expect(checkIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(checkIds).size).toBe(checkIds.length);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual(report);
    });

    it('returns ok=false and structured failed checks for an invalid team config', async () => {
        mockedLoadTeamConfig.mockResolvedValue(null);

        const report = await doctor({ json: true });

        expect(report.ok).toBe(false);
        expect(report.checks).toContainEqual(expect.objectContaining({
            id: 'config.team',
            name: 'Team config (teamai.yaml) is valid',
            ok: false,
        }));
    });
});
