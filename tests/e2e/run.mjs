#!/usr/bin/env node
/**
 * VidDock End-to-End Test Runner
 * Validates extension build, native companion build, synthetic streams, and live stdio handshake.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureFixtures } from '../helpers/fixtures.ts';
import { TestServer } from '../helpers/server.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

console.log('=== VidDock E2E Test Suite ===');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✗ [FAIL] ${message}`);
    failed++;
  }
}

async function run() {
  // --- 1. Extension Dist Validation ---
  console.log('\n[1/4] Validating Chrome Extension Build...');
  const extDist = resolve(REPO_ROOT, 'apps/extension/dist');
  assert(existsSync(extDist), 'apps/extension/dist exists');

  const manifestPath = resolve(extDist, 'manifest.json');
  assert(existsSync(manifestPath), 'manifest.json exists');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.manifest_version === 3, 'Manifest is version 3');
  assert(manifest.name.startsWith('VidDock'), 'Manifest name starts with VidDock');
  assert(
    manifest.permissions.includes('storage') &&
      manifest.permissions.includes('downloads') &&
      manifest.permissions.includes('nativeMessaging'),
    'Manifest permissions include storage, downloads, nativeMessaging',
  );
  assert(existsSync(resolve(extDist, manifest.background.service_worker)), 'Background service worker file exists');
  assert(existsSync(resolve(extDist, manifest.action.default_popup)), 'Popup HTML file exists');

  for (const page of ['popup/index.html', 'dashboard/index.html', 'settings/index.html']) {
    const pageHtml = readFileSync(resolve(extDist, page), 'utf8');
    assert(!/<script>\s*[\s\S]*?<\/script>/i.test(pageHtml), `${page} strictly avoids inline scripts (CSP compliant)`);
  }

  // --- 2. Native Companion Build Validation ---
  console.log('\n[2/4] Validating Native Companion Host Build...');
  const hostDist = resolve(REPO_ROOT, 'dist/host');
  assert(existsSync(hostDist), 'dist/host directory exists');
  assert(existsSync(resolve(hostDist, 'viddock-host.mjs')), 'viddock-host.mjs binary exists');

  const launcherPath = resolve(hostDist, 'viddock-host-launcher.sh');
  assert(existsSync(launcherPath), 'viddock-host-launcher.sh exists');
  const launcherStat = statSync(launcherPath);
  assert((launcherStat.mode & 0o111) !== 0, 'viddock-host-launcher.sh is executable');

  const hostManifest = JSON.parse(readFileSync(resolve(hostDist, 'com.viddock.host.json'), 'utf8'));
  assert(hostManifest.name === 'com.viddock.host', 'Host manifest name is com.viddock.host');
  assert(hostManifest.type === 'stdio', 'Host manifest type is stdio');

  // --- 3. Live Stdio Native Host Handshake ---
  console.log('\n[3/4] Live Native Messaging Stdio Handshake...');
  const handshakeResult = await new Promise((resolveResult) => {
    const proc = spawn(launcherPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const payload = Buffer.from(JSON.stringify({ id: 'e2e-hello', type: 'hello' }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);

    proc.stdin.write(header);
    proc.stdin.write(payload);

    let stdoutBuf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length >= 4) {
        const len = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length >= 4 + len) {
          const resp = JSON.parse(stdoutBuf.slice(4, 4 + len).toString('utf8'));
          proc.kill();
          resolveResult(resp);
        }
      }
    });

    setTimeout(() => {
      proc.kill();
      resolveResult(null);
    }, 4000);
  });

  assert(handshakeResult !== null, 'Native host replied within timeout');
  assert(handshakeResult?.ok === true, 'Native host hello returned ok: true');
  assert(handshakeResult?.data?.version === '1.0.0', 'Native host reports version 1.0.0');
  assert(handshakeResult?.data?.platform === process.platform, `Native host reports platform ${process.platform}`);
  assert(Boolean(handshakeResult?.data?.ffmpeg), 'Native host reports FFmpeg binary available');
  assert(Boolean(handshakeResult?.data?.ffprobe), 'Native host reports ffprobe binary available');

  // --- 4. Synthetic Stream Server Integration ---
  console.log('\n[4/4] Synthetic Stream Server Integration...');
  const fixtureDir = await ensureFixtures();
  const server = new TestServer(fixtureDir);
  await server.start();
  const baseUrl = server.url;

  try {
    const hlsRes = await fetch(`${baseUrl}/hls/master.m3u8`);
    assert(hlsRes.ok, 'Synthetic HLS master playlist fetched successfully');
    const hlsBody = await hlsRes.text();
    assert(hlsBody.includes('#EXT-X-STREAM-INF'), 'HLS playlist contains valid stream variant headers');

    const dashRes = await fetch(`${baseUrl}/dash/manifest.mpd`);
    assert(dashRes.ok, 'Synthetic DASH MPD fetched successfully');
    const dashBody = await dashRes.text();
    assert(dashBody.includes('<MPD'), 'DASH MPD contains root XML element');

    const directRes = await fetch(`${baseUrl}/sample.mp4`);
    assert(directRes.ok, 'Synthetic direct MP4 stream fetched successfully');
    const directBuf = Buffer.from(await directRes.arrayBuffer());
    assert(directBuf.length > 1000, 'Direct MP4 stream contains media bytes');

    const cameraRes = await fetch(`${baseUrl}/mediasite/camera.mp4`);
    assert(cameraRes.ok, 'Synthetic Mediasite camera track fetched successfully');
    const screenRes = await fetch(`${baseUrl}/mediasite/screen.mp4`);
    assert(screenRes.ok, 'Synthetic Mediasite screen track fetched successfully');
  } finally {
    await server.stop();
  }

  // --- Summary ---
  console.log('\n========================================');
  console.log(`E2E Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
