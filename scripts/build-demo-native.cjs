'use strict';
// Maintainer-only build. Importing this file does not spawn or write anything.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const usage = 'Usage: build-demo-native.cjs [--legacy-swift-driver] [--output /absolute/path] [--self-test --output /absolute/test-binary]';
function parseArguments(args) {
  let output, legacySwiftDriver = false, selfTest = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--legacy-swift-driver' && !legacySwiftDriver) legacySwiftDriver = true;
    else if (args[i] === '--self-test' && !selfTest) selfTest = true;
    else if (args[i] === '--output' && output === undefined && path.isAbsolute(args[i + 1] || '')) output = args[++i];
    else throw Error(usage);
  }
  // A semantic-only executable must never accidentally replace the shipped helper.
  if (selfTest && (!output || path.resolve(output) === path.join(root, 'native', 'demo-ax-helper'))) throw Error(usage);
  return { output: output || path.join(root, 'native', 'demo-ax-helper'), legacySwiftDriver, selfTest };
}
function buildCommands(options, developer = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer') {
  if (!path.isAbsolute(developer)) throw Error('DEVELOPER_DIR must be absolute');
  const sdk = path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
  const compiler = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc');
  // action-next/scripts/build.mjs establishes -O and the public libproc bridge.
  // This package uses the same macOS 15/arm64 deployment baseline as recording.
  const args = [...(options.legacySwiftDriver ? ['-disallow-use-new-driver'] : []), '-swift-version', '5', '-O',
    '-sdk', sdk, '-target', 'arm64-apple-macosx15.0',
    '-module-cache-path', path.join(path.dirname(options.output), '.demo-swift-module-cache'),
    ...(options.selfTest ? ['-D', 'AX_SEMANTIC_TESTS'] : []),
    '-import-objc-header', path.join(root, 'demo/action/LibprocBridge.h'), path.join(root, 'native/demo-ax.swift'), '-o', options.output];
  return { compiler, sdk, developer, commands: [
    { command: compiler, args },
    { command: '/usr/bin/codesign', args: ['--force', '--sign', '-', options.output] },
    { command: '/usr/bin/codesign', args: ['--verify', '--strict', options.output] },
    ...(options.selfTest ? [{ command: options.output, args: [] }] : [])
  ] };
}
function main(args = process.argv.slice(2)) {
  const options = parseArguments(args), build = buildCommands(options);
  if (!fs.existsSync(build.sdk) || !fs.existsSync(build.compiler)) throw Error('A full Xcode SDK supporting macOS 15+ is required to build this package');
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  for (const { command, args } of build.commands) {
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: build.developer } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Build command failed (${result.status ?? result.signal}): ${command}`);
  }
  fs.chmodSync(options.output, 0o755);
  console.log(options.output);
}
module.exports = { parseArguments, buildCommands };
if (require.main === module) main();
