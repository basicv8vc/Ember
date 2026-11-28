import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard for test registration (Review Round 1, P1).
 *
 * `tests/integration/http-task-api.test.ts` declared its three `describe` blocks inside the
 * `afterAll` callback. Vitest collects a file before any hook runs, so those suites were never
 * registered: the file reported 4 tests instead of 10, and CI was green because a test that is
 * never collected cannot fail. The layout is fixed, but a check that only inspects that one file
 * would not stop the same mistake from reappearing elsewhere.
 *
 * This guard scans every `*.test.ts` under `tests/` for a `describe`/`it`/`test` call nested
 * inside a `beforeAll`/`afterAll`/`beforeEach`/`afterEach` callback. It parses with TypeScript
 * instead of matching text, so comments, string literals and regular expressions cannot produce
 * false positives, and its detector is exercised against fixtures so it cannot pass vacuously.
 */

const HOOK_NAMES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const REGISTRATION_NAMES = new Set(['describe', 'suite', 'it', 'test']);

interface Violation {
  /** 1-based line of the enclosing hook call. */
  readonly line: number;
  readonly hook: string;
  readonly nested: string;
}

const TESTS_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Root identifier of a callee: `describe`, `describe.each(...)`, `it.skip`, `test.only` all
 * resolve to their first identifier so modifiers cannot hide a registration.
 */
function calleeRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
    return calleeRootName(expression.expression);
  }

  return undefined;
}

function registrationNamesIn(node: ts.Node, found: Set<string>): void {
  ts.forEachChild(node, (child) => {
    if (ts.isCallExpression(child)) {
      const name = calleeRootName(child.expression);

      if (name !== undefined && REGISTRATION_NAMES.has(name)) {
        // A `Set` keeps the report one line per distinct registration: `describe.each([])(…)` is
        // two call expressions (`describe.each` and the outer call) but one registration.
        found.add(name);
      }
    }

    registrationNamesIn(child, found);
  });
}

/** Every suite/test registered inside a lifecycle hook callback. */
function findNestedRegistrations(source: string): Violation[] {
  const file = ts.createSourceFile('inline.ts', source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hook = calleeRootName(node.expression);

      if (hook !== undefined && HOOK_NAMES.has(hook)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

        for (const argument of node.arguments) {
          const found = new Set<string>();
          registrationNamesIn(argument, found);

          for (const nested of found) {
            violations.push({ line, hook, nested });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return violations;
}

function testFiles(directory: string = TESTS_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return testFiles(path);
    }

    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('registration guard detector', () => {
  it('flags a suite that was moved into a lifecycle hook', () => {
    // The exact shape that shipped: a suite after the hook body's first statement.
    expect(
      findNestedRegistrations(
        [
          'afterAll(async () => {',
          '  await db.close();',
          "  describe('POST /v1/tasks', () => {",
          "    it('works', () => {});",
          '  });',
          '});',
        ].join('\n'),
      ),
    ).toEqual([
      { line: 1, hook: 'afterAll', nested: 'describe' },
      // The suite body is inside the hook too, so its test is reported as well: two independent
      // signals that the block is unreachable.
      { line: 1, hook: 'afterAll', nested: 'it' },
    ]);
  });

  it('flags a test registered in any hook, including modifiers', () => {
    for (const hook of ['beforeAll', 'afterAll', 'beforeEach', 'afterEach']) {
      expect(findNestedRegistrations(`${hook}(() => { it.skip('x', () => {}); });`)).toEqual([
        { line: 1, hook, nested: 'it' },
      ]);
      expect(
        findNestedRegistrations(`${hook}(() => { describe.each([])('x', () => {}); });`),
      ).toEqual([{ line: 1, hook, nested: 'describe' }]);
    }
  });

  it('accepts the correct layout and ignores text that only looks like a registration', () => {
    expect(
      findNestedRegistrations(
        [
          'beforeAll(() => { setup(); });',
          "describe('suite', () => {",
          "  it('works', () => { expect('describe(x)').toBe('describe(x)'); });",
          '});',
          'afterAll(() => { teardown(); });',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('test suite layout', () => {
  it('scans the whole suite rather than a single file', () => {
    const files = testFiles();

    // Guards against a broken directory walk turning this check into a no-op.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.map((file) => relative(TESTS_DIR, file))).toContain(
      join('integration', 'v2-m1-acceptance.test.ts'),
    );
  });

  it('has no suite or test registered inside a lifecycle hook', () => {
    const findings = testFiles().flatMap((file) =>
      findNestedRegistrations(readFileSync(file, 'utf8')).map(
        (violation) =>
          `${relative(TESTS_DIR, file)}:${violation.line} ${violation.nested} inside ${violation.hook}`,
      ),
    );

    expect(findings).toEqual([]);
  });
});
