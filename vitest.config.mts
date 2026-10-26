import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import os from 'node:os';
import { LIVE_TEST_FILES, CLOUD_E2E_FILES } from './vitest.constants.mjs';

// Adaptive fork worker concurrency:
// On CI, allocate 4 workers. Locally (especially on Windows or systems with <= 4 cores),
// limit to 2 workers to prevent IPC channel congestion and fork worker timeouts during JSDOM initialization.
const resolvedMaxWorkers = process.env.CI
    ? 4
    : (os.cpus().length <= 4 || process.platform === 'win32' ? 2 : 3);

export default defineConfig({
    test: {
        environment: 'node',
        env: {
            VITEST_LIVE: 'false',
        },
        setupFiles: ['./vitest.setup.ts'],
        globals: true,
        testTimeout: 30_000,
        maxWorkers: resolvedMaxWorkers,
        include: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.ts'],
        // Phase 10: LIVE integration suites and external cloud suites are excluded from default runner
        exclude: [...configDefaults.exclude, ...LIVE_TEST_FILES, ...CLOUD_E2E_FILES],
        // Pure unit and contract tests are completely hermetic (zero DB / network).
        // Each test file runs in an isolated fork worker, preventing V8 heap
        // accumulation and environment switching segfaults across mixed jsdom/node suites.
        pool: 'forks',
        execArgv: ['--max-old-space-size=4096'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/lib/ai/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
            'server-only': path.resolve(import.meta.dirname, './src/server/empty.ts'),
        },
    },
});
