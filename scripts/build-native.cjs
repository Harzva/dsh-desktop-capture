'use strict';
// Maintainer build only. No install/postinstall hook and no runtime compilation.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const developer = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
const sdk = path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
const compiler = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc');
if (!fs.existsSync(sdk) || !fs.existsSync(compiler)) throw Error('A full Xcode SDK supporting macOS 15+ is required to build this package');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1]))) throw Error('Usage: build-native.cjs [--output /absolute/path]');
const output = args[1] || path.join(__dirname, '..', 'native', 'recording-helper');
fs.mkdirSync(path.dirname(output), { recursive: true });
function run(command, args) { const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: developer } }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status || 1); }
run(compiler, ['-parse-as-library', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-macosx15.0', path.join(__dirname, '..', 'native', 'app-recording-macos.swift'), '-o', output]);
run('/usr/bin/codesign', ['--force', '--sign', '-', output]);
run('/usr/bin/codesign', ['--verify', '--strict', output]);
fs.chmodSync(output, 0o755);
console.log(output);
