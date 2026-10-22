'use strict';
// Pure parameter/command tests; no compiler, native helper or permission call.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { parseArguments, buildCommands } = require('../scripts/build-demo-native.cjs');
test('default rebuild targets packaged helper; CLI rejects ambiguous output and semantic replacement', () => {
  assert.equal(parseArguments([]).output, path.resolve(__dirname, '../native/demo-ax-helper'));
  for (const args of [['--output'], ['--output', 'relative'], ['--output', '/a', '--output', '/b'], ['--self-test'],
    ['--self-test', '--output', path.resolve(__dirname, '../native/demo-ax-helper')], ['--legacy-swift-driver', '--legacy-swift-driver'], ['--self-test', '--self-test', '--output', '/test'], ['--unknown']])
    assert.throws(() => parseArguments(args), /Usage:/);
});
test('production command includes exact bridge and deployment flags without invoking a helper', () => {
  const options = parseArguments(['--output', '/fixture with spaces/demo-helper']);
  const build = buildCommands(options, '/Fixture Xcode/Contents/Developer'), args = build.commands[0].args;
  assert.equal(build.commands.length, 3); assert.equal(args[args.indexOf('-target') + 1], 'arm64-apple-macosx15.0');
  assert.equal(args[args.indexOf('-import-objc-header') + 1], path.resolve(__dirname, '../demo/action/LibprocBridge.h'));
  assert.equal(args[args.indexOf('-o') + 1], options.output);
  assert(!args.includes('-parse-as-library')); assert(!args.includes('-D')); assert(!args.includes('-disallow-use-new-driver'));
  assert.deepEqual(build.commands.slice(1), [
    { command: '/usr/bin/codesign', args: ['--force', '--sign', '-', options.output] },
    { command: '/usr/bin/codesign', args: ['--verify', '--strict', options.output] }
  ]);
});
test('explicit workaround and self-test compile semantic-only branch and run only that output', () => {
  const options = parseArguments(['--legacy-swift-driver', '--self-test', '--output', '/fixture/semantic-test']);
  const build = buildCommands(options, '/Fixture Xcode'), args = build.commands[0].args;
  assert.equal(args[0], '-disallow-use-new-driver'); assert.equal(args[args.indexOf('-D') + 1], 'AX_SEMANTIC_TESTS');
  assert.deepEqual(build.commands.at(-1), { command: options.output, args: [] });
  assert.throws(() => buildCommands(options, 'relative'), /absolute/);
});
