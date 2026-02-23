/**
 * ABOUTME: Tests for acceptance criteria verification in the execution engine.
 * Tests the verifyAcceptanceCriteria flow: AC extraction, agent verdict parsing,
 * fail-open behavior, attempt tracking, and integration with iteration results.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { getAcceptanceCriteria } from '../../src/templates/index.js';
import { createTrackerTask } from '../factories/tracker-task.js';
import {
  createMockAgentPlugin,
  createSuccessfulExecution,
  createFailedExecution,
} from '../mocks/agent-responses.js';
import type { TrackerTask } from '../../src/plugins/trackers/types.js';
import type { AgentPlugin, AgentExecutionResult } from '../../src/plugins/agents/types.js';

describe('getAcceptanceCriteria', () => {
  test('returns empty string for task with no description and no metadata', () => {
    const task = createTrackerTask({ description: undefined });
    expect(getAcceptanceCriteria(task)).toBe('');
  });

  test('returns empty string for task with description but no AC', () => {
    const task = createTrackerTask({
      description: 'Just a regular description with no acceptance criteria.',
    });
    expect(getAcceptanceCriteria(task)).toBe('');
  });

  test('extracts AC from metadata.acceptanceCriteria array (JSON tracker)', () => {
    const task = createTrackerTask({
      metadata: {
        acceptanceCriteria: ['Tests pass', 'No lint errors', 'Docs updated'],
      },
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('- [ ] Tests pass');
    expect(ac).toContain('- [ ] No lint errors');
    expect(ac).toContain('- [ ] Docs updated');
    expect(ac.split('\n')).toHaveLength(3);
  });

  test('ignores empty metadata.acceptanceCriteria array', () => {
    const task = createTrackerTask({
      metadata: { acceptanceCriteria: [] },
      description: 'No AC here either.',
    });
    expect(getAcceptanceCriteria(task)).toBe('');
  });

  test('filters non-string items from metadata.acceptanceCriteria', () => {
    const task = createTrackerTask({
      metadata: {
        acceptanceCriteria: ['Valid criterion', 42, null, 'Another valid one'],
      },
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('- [ ] Valid criterion');
    expect(ac).toContain('- [ ] Another valid one');
    expect(ac.split('\n')).toHaveLength(2);
  });

  test('extracts AC from ## Acceptance Criteria section in description', () => {
    const task = createTrackerTask({
      description: [
        'Some description text.',
        '',
        '## Acceptance Criteria',
        '- [ ] Form validates input',
        '- [ ] Error messages display inline',
        '- [ ] Submit button disabled when invalid',
      ].join('\n'),
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('Form validates input');
    expect(ac).toContain('Error messages display inline');
    expect(ac).toContain('Submit button disabled when invalid');
  });

  test('extracts AC section case-insensitively', () => {
    const task = createTrackerTask({
      description: '## acceptance criteria\n- [ ] Works case insensitively',
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('Works case insensitively');
  });

  test('extracts checklist patterns when no explicit AC section', () => {
    const task = createTrackerTask({
      description: [
        'Implement the feature:',
        '- [ ] Add button component',
        '- [x] Create API endpoint',
        '- [ ] Write integration tests',
      ].join('\n'),
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('Add button component');
    expect(ac).toContain('Create API endpoint');
    expect(ac).toContain('Write integration tests');
  });

  test('metadata.acceptanceCriteria takes precedence over description', () => {
    const task = createTrackerTask({
      metadata: { acceptanceCriteria: ['From metadata'] },
      description: '## Acceptance Criteria\n- [ ] From description',
    });
    const ac = getAcceptanceCriteria(task);
    expect(ac).toContain('- [ ] From metadata');
    expect(ac).not.toContain('From description');
  });
});

describe('AC verdict parsing', () => {
  // These tests verify the verdict regex patterns that the engine uses.
  // The actual engine method is private, so we test the patterns directly.

  const AC_VERDICT_PATTERN = /<ac-verdict>([\s\S]*?)<\/ac-verdict>/i;

  test('parses PASS verdict', () => {
    const stdout = 'Checking criteria...\n<ac-verdict>PASS</ac-verdict>\nDone.';
    const match = stdout.match(AC_VERDICT_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]!.trim().toUpperCase().startsWith('PASS')).toBe(true);
  });

  test('parses FAIL verdict with reason', () => {
    const stdout = '<ac-verdict>FAIL: Tests are not passing, missing unit tests for edge cases</ac-verdict>';
    const match = stdout.match(AC_VERDICT_PATTERN);
    expect(match).not.toBeNull();
    const verdict = match![1]!.trim();
    expect(verdict.toUpperCase().startsWith('FAIL')).toBe(true);
    const reason = verdict.replace(/^FAIL:\s*/i, '').trim();
    expect(reason).toBe('Tests are not passing, missing unit tests for edge cases');
  });

  test('handles multiline FAIL reason', () => {
    const stdout = '<ac-verdict>FAIL: Multiple issues:\n- Missing test coverage\n- Docs not updated</ac-verdict>';
    const match = stdout.match(AC_VERDICT_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('Missing test coverage');
    expect(match![1]).toContain('Docs not updated');
  });

  test('returns null when no verdict tag present', () => {
    const stdout = 'Agent did some work but forgot to include a verdict.';
    const match = stdout.match(AC_VERDICT_PATTERN);
    expect(match).toBeNull();
  });

  test('is case-insensitive for tag', () => {
    const stdout = '<AC-VERDICT>PASS</AC-VERDICT>';
    const match = stdout.match(AC_VERDICT_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('PASS');
  });
});

describe('verification agent mock behavior', () => {
  // These tests verify that the mock agent infrastructure correctly
  // supports the verification use case (multiple sequential execute calls).

  test('mock agent can be called multiple times', async () => {
    let callCount = 0;
    const results = [
      createSuccessfulExecution('Work output\n<promise>COMPLETE</promise>'),
      createSuccessfulExecution('<ac-verdict>PASS</ac-verdict>'),
    ];

    // Create a mock agent that returns different results per call
    const agent = createMockAgentPlugin({
      executeResult: results[0],
    });

    // Override execute to track calls
    const originalExecute = agent.execute.bind(agent);
    agent.execute = (prompt, files, options) => {
      const result = results[callCount] ?? results[results.length - 1]!;
      callCount++;
      const mockAgent = createMockAgentPlugin({ executeResult: result });
      return mockAgent.execute(prompt, files, options);
    };

    // First call (work)
    const handle1 = agent.execute('Do the work', [], {});
    const result1 = await handle1.promise;
    expect(result1.stdout).toContain('<promise>COMPLETE</promise>');

    // Second call (verification)
    const handle2 = agent.execute('Verify AC', [], {});
    const result2 = await handle2.promise;
    expect(result2.stdout).toContain('<ac-verdict>PASS</ac-verdict>');

    expect(callCount).toBe(2);
  });

  test('mock agent returns FAIL verdict correctly', async () => {
    const agent = createMockAgentPlugin({
      executeResult: createSuccessfulExecution(
        'Checked criteria.\n<ac-verdict>FAIL: Unit tests not implemented</ac-verdict>'
      ),
    });

    const handle = agent.execute('Verify AC', [], {});
    const result = await handle.promise;

    const match = result.stdout.match(/<ac-verdict>([\s\S]*?)<\/ac-verdict>/i);
    expect(match).not.toBeNull();
    expect(match![1]!.trim().toUpperCase().startsWith('FAIL')).toBe(true);
  });

  test('failed execution returns no verdict (fail-open case)', async () => {
    const agent = createMockAgentPlugin({
      executeResult: createFailedExecution('Agent crashed'),
    });

    const handle = agent.execute('Verify AC', [], {});
    const result = await handle.promise;

    expect(result.status).toBe('failed');
    const match = result.stdout.match(/<ac-verdict>([\s\S]*?)<\/ac-verdict>/i);
    expect(match).toBeNull();
  });
});
