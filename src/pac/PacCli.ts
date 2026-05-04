import * as vscode from 'vscode';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { getTrustedConfigValue } from '../config';

/** Hard cap on captured stdout/stderr per invocation (defense against runaway output). */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface PacResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface PacRunOptions extends SpawnOptionsWithoutStdio {
    /** When true, do not echo stdout/stderr to the OutputChannel (for sensitive payloads). */
    quiet?: boolean;
}

/**
 * Thin wrapper around the Microsoft Power Platform CLI (`pac`).
 * Streams output to a shared OutputChannel and optionally parses --json results.
 */
export class PacCli {
    constructor(private readonly output: vscode.OutputChannel) {}

    /** Append an informational line to the shared output channel. */
    logInfo(message: string): void {
        this.output.appendLine(`  ${message}`);
    }

    /**
     * Resolve the configured `pac` executable path.
     * SECURITY: workspace-scoped overrides are ignored unless the workspace is
     * trusted, so opening an untrusted repo with a poisoned .vscode/settings.json
     * cannot redirect us to an arbitrary binary.
     */
    private get pacPath(): string {
        return getTrustedConfigValue<string>('pacPath', 'pac') || 'pac';
    }

    /** Run a pac command, streaming output. Resolves on exit (any code). */
    run(args: string[], opts: PacRunOptions = {}): Promise<PacResult> {
        const cmd = this.pacPath;
        const { quiet, ...spawnOpts } = opts;
        // Log the command line only — never echo a redacted-arg version that
        // might mask user-visible info; redaction lives on the output stream.
        this.output.appendLine(`> ${cmd} ${args.join(' ')}`);
        return new Promise((resolve, reject) => {
            let proc;
            try {
                // SECURITY: never spawn through a shell. cmd.exe / sh would
                // re-interpret metacharacters in user-controlled args (solution
                // names, folder paths) and enable command injection.
                proc = spawn(cmd, args, { ...spawnOpts, shell: false });
            } catch (e: any) {
                reject(e);
                return;
            }
            let stdout = '';
            let stderr = '';
            let truncated = false;
            const append = (s: string, target: 'out' | 'err') => {
                const current = target === 'out' ? stdout.length : stderr.length;
                const remaining = MAX_BUFFER_BYTES - current;
                if (remaining <= 0) {
                    if (!truncated) {
                        truncated = true;
                        this.output.appendLine(`  (output truncated at ${MAX_BUFFER_BYTES} bytes)`);
                    }
                    return;
                }
                const slice = s.length > remaining ? s.slice(0, remaining) : s;
                if (target === 'out') { stdout += slice; } else { stderr += slice; }
                if (!quiet) {
                    this.output.append(slice);
                }
            };
            proc.stdout.on('data', (d: Buffer) => append(d.toString(), 'out'));
            proc.stderr.on('data', (d: Buffer) => append(d.toString(), 'err'));
            proc.on('error', reject);
            proc.on('close', (code: number | null) => {
                if (quiet) {
                    this.output.appendLine(`  (exit ${code ?? -1}, output suppressed)`);
                }
                resolve({ stdout, stderr, exitCode: code ?? -1 });
            });
        });
    }

    /** Run pac and throw on non-zero exit. */
    async runOrThrow(args: string[], opts: PacRunOptions = {}): Promise<PacResult> {
        const r = await this.run(args, opts);
        if (r.exitCode !== 0) {
            throw new Error(`pac ${args[0] ?? ''} failed (exit ${r.exitCode}). See output for details.`);
        }
        return r;
    }

    /**
     * Run pac with `--json` and try to parse the JSON object/array out of stdout.
     * pac sometimes emits banner lines before the JSON payload, so we slice from
     * the first '{' or '['. Output is suppressed from the channel because JSON
     * payloads frequently contain PII (UPNs, env URLs, org IDs).
     */
    async runJson<T = unknown>(args: string[]): Promise<T> {
        const r = await this.run([...args, '--json'], { quiet: true });
        if (r.exitCode !== 0) {
            // Surface a snippet of the suppressed output so the user can see why.
            const snippet = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 5).join(' | ');
            this.output.appendLine(`  pac ${args.join(' ')} --json failed (exit ${r.exitCode}): ${snippet}`);
            throw new Error(
                `pac ${args.join(' ')} --json failed (exit ${r.exitCode}). ${snippet || 'See "Power Automate" output for details.'}`
            );
        }
        const text = r.stdout;
        const candidates = ['{', '['].map(c => text.indexOf(c)).filter(i => i >= 0);
        if (candidates.length === 0) {
            const snippet = text.trim().split(/\r?\n/).slice(0, 5).join(' | ');
            this.output.appendLine(`  pac ${args.join(' ')} --json returned no JSON. stdout: ${snippet}`);
            throw new Error(
                `pac ${args.join(' ')} --json returned no JSON payload. ${snippet || 'Empty output.'}`
            );
        }
        const slice = text.slice(Math.min(...candidates)).trim();
        try {
            return JSON.parse(slice) as T;
        } catch (e: any) {
            this.output.appendLine(`  pac ${args.join(' ')} --json: failed to parse output: ${e.message}`);
            this.output.appendLine(`  raw: ${slice.slice(0, 500)}`);
            throw new Error(`Failed to parse pac JSON output: ${e.message}`);
        }
    }

    /** Returns true if `pac` is on PATH and runnable. */
    async checkInstalled(): Promise<boolean> {
        try {
            // Some pac builds (MSI) treat `--version` as an unknown command and
            // exit non-zero, but still print the version banner first. Accept
            // either a clean exit or banner text in stdout/stderr as success.
            const r = await this.run(['--version'], { quiet: true });
            if (r.exitCode === 0) {
                return true;
            }
            return /Microsoft PowerPlatform CLI|Version:\s*\d/i.test(r.stdout + r.stderr);
        } catch {
            return false;
        }
    }
}
