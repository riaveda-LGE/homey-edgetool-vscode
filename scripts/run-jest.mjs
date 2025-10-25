#!/usr/bin/env node
/**
 * Cross-platform Jest runner that normalizes single-test filtering for *all* npm scripts.
 *
 * Supports both:
 *   1) Native Jest flags forwarded after `--` (e.g., `-t`, `--testNamePattern`, file paths)
 *   2) Friendly npm-config style options (become env vars on all shells):
 *        --name="pattern"   -> adds `-t pattern`
 *        --file=path        -> adds `--runTestsByPath path`
 *
 * Examples:
 *   npm run test -- -t "타임존" src/__test__/LogFileIntegration.test.ts
 *   npm run test:perf -- --name="타임존" --file=src/__test__/LogFileIntegration.test.ts
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2); // raw args passed after `--`
const env = process.env;

// Helper to check if an arg already exists in raw argv
const hasArg = (flagLong, flagShort) =>
  argv.some(a => a === flagLong || a.startsWith(`${flagLong}=`) || a === flagShort);

// Read friendly options coming from npm-config env mapping (npm lowercases keys)
const pick = k => (env[k] && `${env[k]}`.length ? env[k] : undefined);
const namePattern =
  pick('npm_config_name') ||
  pick('npm_config_t') ||
  pick('npm_config_testnamepattern') ||
  pick('npm_config_testNamePattern'); // just in case

const filePath =
  pick('npm_config_file') ||
  pick('npm_config_path') ||
  pick('npm_config_runtestsbypath') ||
  pick('npm_config_runTestsByPath'); // just in case

const extra = [];
if (namePattern && !hasArg('--testNamePattern', '-t')) {
  extra.push('-t', namePattern);
}
if (filePath && !hasArg('--runTestsByPath')) {
  extra.push('--runTestsByPath', filePath);
}

// Use the jest CLI directly via Node to avoid shell quoting issues on Windows.
const jestCli = path.resolve('node_modules/jest/bin/jest.js');
const finalArgs = [jestCli, ...argv, ...extra];

const child = spawn(process.execPath, finalArgs, { stdio: 'inherit' });
child.on('exit', code => process.exit(code));
