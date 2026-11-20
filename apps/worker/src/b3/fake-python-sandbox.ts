import { randomUUID } from 'node:crypto';
import {
  PYTHON_AGENT_LIMITS,
  isSafeArtifactFilename,
  type SandboxExecResult,
  type SandboxSpec,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type {
  PythonAgentDirectoryEntry,
  PythonAgentSandboxFactory,
  PythonAgentSandboxPort,
} from './python-agent-executor.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const MAX_PROCESSED_CSV_ROWS = 10_000;
const OUTPUT_DIRECTIVE_PATTERN = /^#\s*output:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/m;

export interface FakePythonSandboxExecContext {
  readonly sandboxId: Id;
  readonly code: string;
  readonly inputs: ReadonlyMap<string, Uint8Array>;
  readonly outputs: Map<string, Uint8Array>;
}

export interface FakePythonSandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FakePythonAgentSandboxOptions {
  /** Optional deterministic hook for fault injection or custom scripted execution in tests. */
  readonly onExec?: (
    context: FakePythonSandboxExecContext,
  ) => FakePythonSandboxExecResult | Promise<FakePythonSandboxExecResult>;
}

interface SandboxState {
  readonly id: Id;
  ready: boolean;
  destroyed: boolean;
  readonly files: Map<string, Uint8Array>;
  readonly outputsByRef: Map<string, { readonly stdout: string; readonly stderr: string }>;
}

interface NumericColumnStats {
  readonly name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
}

function normalizeSafeSandboxPath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed.includes('..')
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'unsafe sandbox file path');
  }

  if (trimmed === 'main.py') {
    return trimmed;
  }

  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) {
    throw new DomainError('INVALID_ARGUMENT', 'sandbox file must live under inputs/ or outputs/');
  }

  const dir = trimmed.slice(0, slashIdx);
  const name = trimmed.slice(slashIdx + 1);
  if ((dir !== 'inputs' && dir !== 'outputs') || name.includes('/') || !isSafeArtifactFilename(name)) {
    throw new DomainError('INVALID_ARGUMENT', 'invalid sandbox file path');
  }

  return `${dir}/${name}`;
}

function normalizeSafeDir(relativeDir: string): 'inputs' | 'outputs' {
  const trimmed = relativeDir.trim().replace(/\/+$/, '');
  if (trimmed === 'inputs' || trimmed === 'outputs') {
    return trimmed;
  }
  throw new DomainError('INVALID_ARGUMENT', 'unsupported sandbox directory');
}

function clampUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const encoded = TEXT_ENCODER.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  return TEXT_DECODER.decode(encoded.subarray(0, maxBytes));
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function summarizeCsv(
  filename: string,
  text: string,
): {
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly numericStats: readonly NumericColumnStats[];
  readonly csvReport: string;
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      rowCount: 0,
      columns: [],
      numericStats: [],
      csvReport: 'metric,value\nrows,0\n',
    };
  }

  const headers = lines[0]!.split(',').map((cell) => cell.trim());
  const dataLines = lines.slice(1, 1 + MAX_PROCESSED_CSV_ROWS);
  const statsByIndex = new Map<number, NumericColumnStats>();

  for (const line of dataLines) {
    const cells = line.split(',').map((cell) => cell.trim());
    for (let i = 0; i < headers.length; i += 1) {
      const raw = cells[i];
      if (raw === undefined || raw.length === 0) {
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      const existing = statsByIndex.get(i);
      if (existing === undefined) {
        statsByIndex.set(i, {
          name: headers[i] || `col_${i + 1}`,
          count: 1,
          sum: parsed,
          min: parsed,
          max: parsed,
        });
      } else {
        existing.count += 1;
        existing.sum += parsed;
        if (parsed < existing.min) existing.min = parsed;
        if (parsed > existing.max) existing.max = parsed;
      }
    }
  }

  const numericStats = [...statsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, stat]) => stat);

  const reportLines = [
    'source_file,column,count,sum,min,max,mean',
    ...numericStats.map((stat) =>
      [
        csvEscape(filename),
        csvEscape(stat.name),
        String(stat.count),
        formatNumber(stat.sum),
        formatNumber(stat.min),
        formatNumber(stat.max),
        formatNumber(stat.sum / stat.count),
      ].join(','),
    ),
  ];

  if (numericStats.length === 0) {
    reportLines.push(`${csvEscape(filename)},rows,${dataLines.length},0,0,0,0`);
  }

  return {
    rowCount: dataLines.length,
    columns: headers,
    numericStats,
    csvReport: `${reportLines.join('\n')}\n`,
  };
}

function runBoundedDataProcessor(
  context: FakePythonSandboxExecContext,
): FakePythonSandboxExecResult {
  const directiveMatch = OUTPUT_DIRECTIVE_PATTERN.exec(context.code);
  const requestedFilename =
    directiveMatch?.[1] !== undefined && isSafeArtifactFilename(directiveMatch[1])
      ? directiveMatch[1]
      : null;

  const sortedInputs = [...context.inputs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const csvInput = sortedInputs.find(([name]) => name.toLowerCase().endsWith('.csv'));

  if (csvInput !== undefined) {
    const [filename, bytes] = csvInput;
    const summary = summarizeCsv(filename, TEXT_DECODER.decode(bytes));
    const outputName = requestedFilename ?? 'analysis-summary.csv';
    context.outputs.set(outputName, TEXT_ENCODER.encode(summary.csvReport));
    const metricsSummary = summary.numericStats
      .map(
        (stat) =>
          `${stat.name}: count=${stat.count} sum=${formatNumber(stat.sum)} mean=${formatNumber(stat.sum / stat.count)}`,
      )
      .join('; ');
    return {
      exitCode: 0,
      stdout: `Processed ${filename} (${summary.rowCount} rows). ${metricsSummary || 'No numeric columns.'} Wrote outputs/${outputName}.`,
      stderr: '',
    };
  }

  const fileSummaries = sortedInputs.map(([filename, bytes]) => {
    const text = TEXT_DECODER.decode(bytes);
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    let jsonKind: string | null = null;
    let jsonItemCount: number | null = null;
    if (filename.toLowerCase().endsWith('.json')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          jsonKind = 'array';
          jsonItemCount = parsed.length;
        } else if (parsed !== null && typeof parsed === 'object') {
          jsonKind = 'object';
          jsonItemCount = Object.keys(parsed).length;
        }
      } catch {
        jsonKind = 'invalid_json';
      }
    }
    return {
      filename,
      bytes: bytes.byteLength,
      lines,
      words,
      ...(jsonKind === null ? {} : { json_kind: jsonKind, json_items: jsonItemCount }),
    };
  });

  const outputName = requestedFilename ?? 'analysis-summary.json';
  const payload = JSON.stringify(
    {
      simulated: true,
      processed_files: fileSummaries.length,
      files: fileSummaries,
    },
    null,
    2,
  );
  context.outputs.set(outputName, TEXT_ENCODER.encode(`${payload}\n`));

  return {
    exitCode: 0,
    stdout: `Processed ${fileSummaries.length} input file(s). Wrote outputs/${outputName}.`,
    stderr: '',
  };
}

/**
 * In-memory local/fake implementation of `PythonAgentSandboxPort`.
 *
 * Performs deterministic, bounded data processing without spawning child processes,
 * touching the host filesystem, or making network calls. Intended strictly for local,
 * test, and CI environments (`mode: 'fake'`).
 */
export class FakePythonAgentSandbox implements PythonAgentSandboxPort {
  readonly #sandboxes = new Map<Id, SandboxState>();
  readonly #onExec: FakePythonAgentSandboxOptions['onExec'];

  constructor(options: FakePythonAgentSandboxOptions = {}) {
    this.#onExec = options.onExec;
  }

  get liveSandboxCount(): number {
    let count = 0;
    for (const state of this.#sandboxes.values()) {
      if (!state.destroyed) {
        count += 1;
      }
    }
    return count;
  }

  create(_spec: SandboxSpec): Promise<{ readonly sandboxId: Id }> {
    return Promise.resolve().then(() => {
      const sandboxId = randomUUID();
      this.#sandboxes.set(sandboxId, {
        id: sandboxId,
        ready: false,
        destroyed: false,
        files: new Map(),
        outputsByRef: new Map(),
      });
      return { sandboxId };
    });
  }

  waitReady(sandboxId: Id, _deadlineMs: number): Promise<void> {
    return Promise.resolve().then(() => {
      const state = this.#requireActive(sandboxId);
      state.ready = true;
    });
  }

  async exec(
    sandboxId: Id,
    _argv: readonly string[],
    _timeoutMs: number,
  ): Promise<SandboxExecResult> {
    const state = this.#requireReady(sandboxId);
    const scriptBytes = state.files.get('main.py') ?? new Uint8Array(0);
    const code = TEXT_DECODER.decode(scriptBytes);

    const inputs = new Map<string, Uint8Array>();
    const outputs = new Map<string, Uint8Array>();
    for (const [path, bytes] of state.files.entries()) {
      if (path.startsWith('inputs/')) {
        inputs.set(path.slice('inputs/'.length), new Uint8Array(bytes));
      } else if (path.startsWith('outputs/')) {
        outputs.set(path.slice('outputs/'.length), new Uint8Array(bytes));
      }
    }

    const result =
      this.#onExec !== undefined
        ? await this.#onExec({ sandboxId, code, inputs, outputs })
        : runBoundedDataProcessor({ sandboxId, code, inputs, outputs });

    for (const [name, bytes] of outputs.entries()) {
      if (!isSafeArtifactFilename(name)) {
        throw new DomainError('INVALID_ARGUMENT', 'sandbox produced unsafe output filename');
      }
      if (bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
        throw new DomainError('POLICY_DENIED', 'sandbox output exceeds maxFileBytes');
      }
      state.files.set(`outputs/${name}`, new Uint8Array(bytes));
    }

    const ref = randomUUID();
    state.outputsByRef.set(ref, { stdout: result.stdout, stderr: result.stderr });
    return {
      exitCode: result.exitCode,
      stdoutRef: ref,
      stderrRef: ref,
    };
  }

  readOutput(
    sandboxId: Id,
    ref: Id,
    stream: 'stdout' | 'stderr',
    maxBytes: number,
  ): Promise<string> {
    return Promise.resolve().then(() => {
      const state = this.#requireReady(sandboxId);
      const recorded = state.outputsByRef.get(ref);
      if (recorded === undefined) {
        return '';
      }
      const text = stream === 'stdout' ? recorded.stdout : recorded.stderr;
      return clampUtf8(text, maxBytes);
    });
  }

  putBytesFile(sandboxId: Id, relativePath: string, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => {
      const state = this.#requireReady(sandboxId);
      const safePath = normalizeSafeSandboxPath(relativePath);
      if (bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
        throw new DomainError('POLICY_DENIED', 'file exceeds maxFileBytes');
      }
      state.files.set(safePath, new Uint8Array(bytes));
    });
  }

  getBytesFile(sandboxId: Id, relativePath: string): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      const state = this.#requireReady(sandboxId);
      const safePath = normalizeSafeSandboxPath(relativePath);
      const bytes = state.files.get(safePath);
      if (bytes === undefined) {
        throw new DomainError('NOT_FOUND', `sandbox file not found: ${safePath}`);
      }
      return new Uint8Array(bytes);
    });
  }

  putTextFile(sandboxId: Id, relativePath: string, text: string): Promise<void> {
    return this.putBytesFile(sandboxId, relativePath, TEXT_ENCODER.encode(text));
  }

  listDirectory(sandboxId: Id, relativeDir: string): Promise<readonly PythonAgentDirectoryEntry[]> {
    return Promise.resolve().then(() => {
      const state = this.#requireReady(sandboxId);
      const dir = normalizeSafeDir(relativeDir);
      const prefix = `${dir}/`;
      const entries: PythonAgentDirectoryEntry[] = [];
      for (const [path, bytes] of state.files.entries()) {
        if (path.startsWith(prefix)) {
          entries.push({
            name: path.slice(prefix.length),
            isDir: false,
            isSymlink: false,
            sizeBytes: bytes.byteLength,
          });
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return entries;
    });
  }

  destroy(sandboxId: Id): Promise<void> {
    return Promise.resolve().then(() => {
      const state = this.#sandboxes.get(sandboxId);
      if (state !== undefined) {
        state.destroyed = true;
        state.ready = false;
        state.files.clear();
        state.outputsByRef.clear();
      }
    });
  }

  #requireActive(sandboxId: Id): SandboxState {
    const state = this.#sandboxes.get(sandboxId);
    if (state === undefined || state.destroyed) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not active');
    }
    return state;
  }

  #requireReady(sandboxId: Id): SandboxState {
    const state = this.#requireActive(sandboxId);
    if (!state.ready) {
      throw new DomainError('SANDBOX_NOT_READY', 'sandbox is not ready');
    }
    return state;
  }
}

export function createFakePythonAgentSandboxFactory(
  options: FakePythonAgentSandboxOptions = {},
): PythonAgentSandboxFactory {
  return () => ({
    provider: new FakePythonAgentSandbox(options),
  });
}
