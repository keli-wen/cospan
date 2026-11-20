import { spawnSync } from 'node:child_process';
import { buildSpawnCommand } from './targets.mjs';

/**
 * Zero-token offline CLI flag contracts verified against `--help` output.
 * Detects upstream CLI breaking flag changes immediately without accounts or API calls.
 */
export const CLI_CONTRACT_SPECS = {
  agy: [
    {
      args: ['--help'],
      requiredFlags: [
        '--print',
        '--model',
        '--output-format',
        '--print-timeout',
        '--add-dir',
        '--conversation',
        '--mode',
        '--dangerously-skip-permissions',
        '--sandbox',
      ],
    },
  ],
  codex: [
    {
      args: ['exec', '--help'],
      requiredFlags: [
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--sandbox',
        '--config',
        '--model',
      ],
    },
    {
      args: ['exec', 'resume', '--help'],
      requiredFlags: [
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--config',
        '--model',
      ],
    },
  ],
  claude: [
    {
      args: ['--help'],
      requiredFlags: [
        '--print',
        '--output-format',
        '--verbose',
        '--add-dir',
        '--resume',
        '--model',
        '--effort',
        '--permission-mode',
        '--permission-prompts',
        '--dangerously-skip-permissions',
        '--restricted',
        '--disallowed-tools',
        '--no-session-persistence',
      ],
    },
  ],
  dsh: [
    {
      args: ['--help'],
      requiredFlags: ['--profile', '--patch'],
    },
    {
      args: ['--profile', 'headless', '--help'],
      requiredFlags: [
        '--json',
        '--session-id',
        '--permission-mode',
        '--approval-policy',
        '--add-dir',
      ],
    },
  ],
};

function runHelpProbe(binary, probeArgs) {
  const spawnCmd = buildSpawnCommand(binary, probeArgs);
  const r = spawnSync(spawnCmd.cmd, spawnCmd.args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
  });
  if (r.error) {
    return { ok: false, output: '', error: r.error.message };
  }
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0 && !output.trim()) {
    return { ok: false, output: '', error: `exit ${r.status}` };
  }
  return { ok: true, output, error: null };
}

export function checkTargetCliContract(targetId, binary) {
  const probes = CLI_CONTRACT_SPECS[targetId];
  if (!probes) {
    return {
      ok: false,
      probes_checked: 0,
      verified_flags: 0,
      missing_flags: [],
      error: `unknown target ${targetId}`,
    };
  }
  if (!binary) {
    return {
      ok: false,
      probes_checked: 0,
      verified_flags: 0,
      missing_flags: [],
      error: 'binary not installed',
    };
  }

  const missingFlags = [];
  let verifiedFlags = 0;

  for (const probe of probes) {
    const res = runHelpProbe(binary, probe.args);
    if (!res.ok) {
      return {
        ok: false,
        probes_checked: probes.length,
        verified_flags: verifiedFlags,
        missing_flags: missingFlags,
        error: `probe \`${targetId} ${probe.args.join(' ')}\` failed: ${res.error}`,
      };
    }
    for (const flag of probe.requiredFlags) {
      if (res.output.includes(flag)) {
        verifiedFlags += 1;
      } else {
        missingFlags.push(`${probe.args.join(' ')}: ${flag}`);
      }
    }
  }

  return {
    ok: missingFlags.length === 0,
    probes_checked: probes.length,
    verified_flags: verifiedFlags,
    missing_flags: missingFlags,
    error: null,
  };
}

export function checkAllInstalledContracts(discovered) {
  const contracts = {};
  let allOk = true;
  for (const [id, info] of Object.entries(discovered)) {
    if (!info?.installed || !info.driverReady) continue;
    const report = checkTargetCliContract(id, info.binary);
    contracts[id] = report;
    if (!report.ok) allOk = false;
  }
  return { allOk, contracts };
}
