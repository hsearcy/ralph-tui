/**
 * ABOUTME: Tests for AC verification configuration schema and log persistence.
 * Tests VerificationConfigSchema Zod validation, config merging defaults,
 * and verificationFailure field in iteration log metadata.
 */

import { describe, test, expect } from 'bun:test';
import {
  VerificationConfigSchema,
  validateStoredConfig,
} from '../../src/config/schema.js';
import {
  DEFAULT_VERIFICATION,
} from '../../src/config/types.js';
import type { VerificationConfig } from '../../src/config/types.js';
import {
  buildMetadata,
  __test__,
} from '../../src/logs/persistence.js';
import type { IterationResult } from '../../src/engine/types.js';

const { formatMetadataHeader, parseMetadataHeader } = __test__;

// --- VerificationConfig schema tests ---

describe('VerificationConfigSchema', () => {
  test('accepts valid full config', () => {
    const result = VerificationConfigSchema.safeParse({
      enabled: true,
      maxAttempts: 3,
      timeoutMs: 60000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.timeoutMs).toBe(60000);
    }
  });

  test('accepts empty object (all fields optional)', () => {
    const result = VerificationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts partial config', () => {
    const result = VerificationConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  test('rejects maxAttempts below minimum (1)', () => {
    const result = VerificationConfigSchema.safeParse({ maxAttempts: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects maxAttempts above maximum (10)', () => {
    const result = VerificationConfigSchema.safeParse({ maxAttempts: 11 });
    expect(result.success).toBe(false);
  });

  test('rejects timeoutMs below minimum (5000)', () => {
    const result = VerificationConfigSchema.safeParse({ timeoutMs: 1000 });
    expect(result.success).toBe(false);
  });

  test('rejects timeoutMs above maximum (600000)', () => {
    const result = VerificationConfigSchema.safeParse({ timeoutMs: 700000 });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer maxAttempts', () => {
    const result = VerificationConfigSchema.safeParse({ maxAttempts: 2.5 });
    expect(result.success).toBe(false);
  });

  test('rejects non-boolean enabled', () => {
    const result = VerificationConfigSchema.safeParse({ enabled: 'yes' });
    expect(result.success).toBe(false);
  });
});

describe('StoredConfig with verification', () => {
  test('validates config with verification section', () => {
    const result = validateStoredConfig({
      verification: {
        enabled: true,
        maxAttempts: 2,
        timeoutMs: 120000,
      },
    });
    expect(result.success).toBe(true);
  });

  test('validates config without verification section', () => {
    const result = validateStoredConfig({
      maxIterations: 10,
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid verification values in stored config', () => {
    const result = validateStoredConfig({
      verification: {
        maxAttempts: -1,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_VERIFICATION', () => {
  test('has expected default values', () => {
    expect(DEFAULT_VERIFICATION.enabled).toBe(false);
    expect(DEFAULT_VERIFICATION.maxAttempts).toBe(2);
    expect(DEFAULT_VERIFICATION.timeoutMs).toBe(120_000);
  });

  test('is disabled by default', () => {
    expect(DEFAULT_VERIFICATION.enabled).toBe(false);
  });
});

// --- Log persistence tests for verificationFailure ---

function createTestIterationResult(overrides: Partial<IterationResult> = {}): IterationResult {
  return {
    iteration: 1,
    status: 'completed',
    task: {
      id: 'test-task-1',
      title: 'Test Task',
      status: 'in_progress',
      priority: 2,
    },
    taskCompleted: false,
    promiseComplete: true,
    durationMs: 5000,
    startedAt: '2024-01-15T10:00:00.000Z',
    endedAt: '2024-01-15T10:00:05.000Z',
    ...overrides,
  };
}

describe('buildMetadata with verificationFailure', () => {
  test('includes verificationFailure when present', () => {
    const result = createTestIterationResult({
      verificationFailure: 'Unit tests not passing',
    });

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    expect(metadata.verificationFailure).toBe('Unit tests not passing');
  });

  test('omits verificationFailure when not present', () => {
    const result = createTestIterationResult();

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    expect(metadata.verificationFailure).toBeUndefined();
  });
});

describe('formatMetadataHeader with verificationFailure', () => {
  test('includes verification failed line when present', () => {
    const result = createTestIterationResult({
      verificationFailure: 'Missing integration tests for API endpoint',
    });

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    const header = formatMetadataHeader(metadata);
    expect(header).toContain('**Verification Failed**: Missing integration tests for API endpoint');
  });

  test('omits verification failed line when not present', () => {
    const result = createTestIterationResult({
      taskCompleted: true,
    });

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    const header = formatMetadataHeader(metadata);
    expect(header).not.toContain('Verification Failed');
  });
});

describe('parseMetadataHeader with verificationFailure', () => {
  test('round-trips verificationFailure through format and parse', () => {
    const result = createTestIterationResult({
      verificationFailure: 'Acceptance criteria #2 not met: no error handling',
    });

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    const header = formatMetadataHeader(metadata);
    const parsed = parseMetadataHeader(header);

    expect(parsed).not.toBeNull();
    expect(parsed!.verificationFailure).toBe(
      'Acceptance criteria #2 not met: no error handling'
    );
  });

  test('parses undefined when no verification failure in header', () => {
    const result = createTestIterationResult({
      taskCompleted: true,
    });

    const metadata = buildMetadata(result, {
      config: {
        agent: { name: 'claude', plugin: 'claude', options: {} },
      },
    });

    const header = formatMetadataHeader(metadata);
    const parsed = parseMetadataHeader(header);

    expect(parsed).not.toBeNull();
    expect(parsed!.verificationFailure).toBeUndefined();
  });
});
