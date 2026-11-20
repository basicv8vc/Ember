import { PYTHON_AGENT_LIMITS, isSafeArtifactFilename } from '@ember/contracts';
import { DomainError } from '@ember/domain';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const MAX_PROCESSED_CSV_ROWS = 10_000;
const OUTPUT_DIRECTIVE_PATTERN = /^#\s*output:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/m;

export interface V2SandboxInputFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface V2SandboxOutputFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface V2FakePythonSandboxResult {
  readonly stdout: string;
  readonly summaryText: string;
  readonly detailText: string;
  readonly outputFiles: readonly V2SandboxOutputFile[];
}

interface NumericColumnStats {
  readonly name: string;
  count: number;
  sum: number;
  min: number;
  max: number;
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

function summarizeCsv(filename: string, text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      rowCount: 0,
      numericStats: [] as NumericColumnStats[],
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
    numericStats,
    csvReport: `${reportLines.join('\n')}\n`,
  };
}

function detectOutputMediaType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

/**
 * Deterministic, zero-network, Cloudflare-Workers-safe fake Python sandbox processor
 * for local/isolated V2 `python.agent` tasks. Mirrors `FakePythonAgentSandbox` semantics
 * without Node-only dependencies or subprocess execution.
 */
export function runV2FakePythonSandbox(input: {
  readonly prompt: string;
  readonly instructions?: string;
  readonly inputFiles: readonly V2SandboxInputFile[];
}): V2FakePythonSandboxResult {
  for (const file of input.inputFiles) {
    if (!isSafeArtifactFilename(file.filename)) {
      throw new DomainError('INVALID_ARGUMENT', 'unsafe input filename');
    }
    if (file.bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
      throw new DomainError('POLICY_DENIED', 'input file exceeds maxFileBytes');
    }
  }

  const directiveSource = `${input.prompt}\n${input.instructions ?? ''}`;
  const directiveMatch = OUTPUT_DIRECTIVE_PATTERN.exec(directiveSource);
  const requestedFilename =
    directiveMatch?.[1] !== undefined && isSafeArtifactFilename(directiveMatch[1])
      ? directiveMatch[1]
      : null;

  const sortedInputs = [...input.inputFiles].sort((a, b) => a.filename.localeCompare(b.filename));
  const csvInput = sortedInputs.find((file) => file.filename.toLowerCase().endsWith('.csv'));

  if (csvInput !== undefined) {
    const summary = summarizeCsv(csvInput.filename, TEXT_DECODER.decode(csvInput.bytes));
    const outputName = requestedFilename ?? 'analysis-summary.csv';
    const reportBytes = TEXT_ENCODER.encode(summary.csvReport);
    const metricsSummary = summary.numericStats
      .map(
        (stat) =>
          `${stat.name}: count=${stat.count} sum=${formatNumber(stat.sum)} mean=${formatNumber(stat.sum / stat.count)}`,
      )
      .join('; ');
    const stdout = `Processed ${csvInput.filename} (${summary.rowCount} rows). ${metricsSummary || 'No numeric columns.'} Wrote outputs/${outputName}.`;
    return {
      stdout,
      summaryText: `Processed ${csvInput.filename} (${summary.rowCount} rows) and generated ${outputName}.`,
      detailText: `${stdout}\n\nDownload \`${outputName}\` from the task artifacts section.`,
      outputFiles: [
        {
          filename: outputName,
          mediaType: detectOutputMediaType(outputName),
          bytes: reportBytes,
        },
      ],
    };
  }

  const fileSummaries = sortedInputs.map((file) => {
    const text = TEXT_DECODER.decode(file.bytes);
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    let jsonKind: string | null = null;
    let jsonItemCount: number | null = null;
    if (file.filename.toLowerCase().endsWith('.json')) {
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
      filename: file.filename,
      bytes: file.bytes.byteLength,
      lines,
      words,
      ...(jsonKind === null ? {} : { json_kind: jsonKind, json_items: jsonItemCount }),
    };
  });

  const outputName = requestedFilename ?? 'analysis-summary.json';
  const payload = JSON.stringify(
    {
      simulated: true,
      prompt: input.prompt,
      processed_files: fileSummaries.length,
      files: fileSummaries,
    },
    null,
    2,
  );
  const reportBytes = TEXT_ENCODER.encode(`${payload}\n`);
  const stdout = `Processed ${fileSummaries.length} input file(s). Wrote outputs/${outputName}.`;

  return {
    stdout,
    summaryText: `Completed bounded data analysis (${fileSummaries.length} input file(s)) and generated ${outputName}.`,
    detailText: `${stdout}\n\nDownload \`${outputName}\` from the task artifacts section.`,
    outputFiles: [
      {
        filename: outputName,
        mediaType: detectOutputMediaType(outputName),
        bytes: reportBytes,
      },
    ],
  };
}
