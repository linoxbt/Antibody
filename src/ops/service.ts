/**
 * `antibody service install|uninstall|status`: start Antibody at login and
 * restart it if it crashes, using the OS's own service manager (no extra
 * software): a systemd user unit on Linux, a launchd agent on macOS, a Task
 * Scheduler task on Windows. Each runs `antibody up --foreground`, the
 * supervisor that keeps the four daemons alive.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

export const SERVICE_LABEL = 'xyz.antibody.daemon';
export const TASK_NAME = 'Antibody';

export interface ServicePlan {
  manager: 'systemd' | 'launchd' | 'schtasks';
  /** The unit, plist or launcher script written. */
  file: { path: string; content: string } | null;
  install: string[][];
  uninstall: string[][];
  status: string[];
  notes: string[];
}

export interface ServiceInputs {
  platform: NodeJS.Platform;
  node: string;
  entry: string;
  home: string;
  user?: string;
  uid?: number;
  homeDir?: string;
  localAppData?: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd: quote each argument so paths with spaces survive. */
const sq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function servicePlan(i: ServiceInputs): ServicePlan {
  const hd = i.homeDir ?? homedir();
  // Paths in the target platform's own syntax, whatever machine builds the plan.
  const join = i.platform === 'win32' ? win32.join : posix.join;
  if (i.platform === 'linux') {
    const path = join(hd, '.config', 'systemd', 'user', 'antibody.service');
    const content = `[Unit]
Description=Antibody: provenance and quarantine for agent memory
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${sq(i.node)} ${sq(i.entry)} up --foreground
Environment=ANTIBODY_HOME=${sq(i.home)}
Restart=on-failure
RestartSec=5
# The supervisor stops its daemons on SIGTERM.
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
    return {
      manager: 'systemd',
      file: { path, content },
      install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'antibody.service']],
      uninstall: [['systemctl', '--user', 'disable', '--now', 'antibody.service']],
      status: ['systemctl', '--user', 'status', 'antibody.service', '--no-pager'],
      notes: [`To keep it running while you are logged out: sudo loginctl enable-linger ${i.user ?? userInfo().username}`, 'Logs: journalctl --user -u antibody -f'],
    };
  }
  if (i.platform === 'darwin') {
    const path = join(hd, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const log = join(i.home, 'logs', 'service.out');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(i.node)}</string>
    <string>${xml(i.entry)}</string>
    <string>up</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>ANTIBODY_HOME</key><string>${xml(i.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    const domain = `gui/${i.uid ?? userInfo().uid}`;
    return {
      manager: 'launchd',
      file: { path, content },
      install: [['launchctl', 'bootstrap', domain, path]],
      uninstall: [['launchctl', 'bootout', `${domain}/${SERVICE_LABEL}`]],
      status: ['launchctl', 'print', `${domain}/${SERVICE_LABEL}`],
      notes: [`Logs: ${log}`],
    };
  }
  if (i.platform === 'win32') {
    // A tiny VBScript launcher runs node with no window; schtasks /TR is limited to 261 characters, so paths live in the file.
    const path = join(i.localAppData ?? join(hd, 'AppData', 'Local'), 'Antibody', 'antibody-service.vbs');
    const vb = (s: string) => s.replace(/"/g, '""');
    const content = `' Antibody: started at sign-in by the "${TASK_NAME}" scheduled task (antibody service install)
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("ANTIBODY_HOME") = "${vb(i.home)}"
sh.Run """${vb(i.node)}"" ""${vb(i.entry)}"" up --foreground", 0, False
`;
    return {
      manager: 'schtasks',
      file: { path, content },
      install: [['schtasks', '/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `wscript.exe "${path}"`], ['schtasks', '/Run', '/TN', TASK_NAME]],
      uninstall: [['schtasks', '/End', '/TN', TASK_NAME], ['schtasks', '/Delete', '/F', '/TN', TASK_NAME]],
      status: ['schtasks', '/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'],
      notes: ['Starts when you sign in to Windows. Logs: ' + join(i.home, 'logs')],
    };
  }
  throw new Error(`no service manager support for ${i.platform}: run antibody up from your own startup script`);
}

const run = (argv: string[], allowFail = false) => {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
  } catch (e) {
    if (allowFail) return '';
    const err = e as { stderr?: Buffer; message: string };
    throw new Error(`${argv.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
};

export function installService(p: ServicePlan): void {
  if (p.file) {
    mkdirSync(dirname(p.file.path), { recursive: true });
    if (p.manager === 'launchd' && existsSync(p.file.path)) run(p.uninstall[0]!, true); // reinstall cleanly
    writeFileSync(p.file.path, p.file.content, { mode: 0o644 });
  }
  for (const c of p.install) run(c);
}

export function uninstallService(p: ServicePlan): void {
  for (const c of p.uninstall) run(c, true);
  if (p.file) rmSync(p.file.path, { force: true });
  if (p.manager === 'systemd') run(['systemctl', '--user', 'daemon-reload'], true);
}

export function serviceStatus(p: ServicePlan): string {
  return run(p.status, true).trim() || 'not installed';
}
