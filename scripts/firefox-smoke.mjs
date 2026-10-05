// End-to-end extension tests use a disposable bundle/profile, never a personal browser profile.
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixtureServer } from './fixtures.mjs';
import webExt from 'web-ext';

await mkdir('.test-artifacts', { recursive: true });
try { await readFile('.test-artifacts/flower.mp4'); }
catch {
  const response = await fetch('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4');
  if (!response.ok) throw new Error(`CC0 media fixture: HTTP ${response.status}`);
  await writeFile('.test-artifacts/flower.mp4', new Uint8Array(await response.arrayBuffer()));
}
await cp('dist', '.test-extension', { recursive: true });
const manifest = JSON.parse(await readFile('.test-extension/manifest.json', 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
const streams = process.argv.includes('--streams');
const rutube = process.argv.includes('--rutube');
const dzen = process.argv.includes('--dzen');
const okVideo = process.argv.includes('--ok');
if (okVideo) manifest.host_permissions.push('https://ok.ru/*', 'https://*.okcdn.ru/*');
if (dzen) manifest.host_permissions.push('https://dzen.ru/*', 'https://*.okcdn.ru/*');
if (rutube) manifest.host_permissions.push('https://*.rutube.ru/*', 'https://*.rtbcdn.ru/*');
if (streams) manifest.host_permissions.push('https://test-streams.mux.dev/*', 'https://storage.googleapis.com/*');
manifest.background.scripts.push('test-boot.js');
await writeFile('.test-extension/manifest.json', JSON.stringify(manifest));
await writeFile('.test-extension/test-boot.js', `browser.storage.session.get('testStarted').then(async value => { if(value.testStarted) return; await browser.storage.session.set({testStarted:true}); await browser.tabs.create({url:browser.runtime.getURL('test-runner.html')}); });`);
await writeFile('.test-extension/test-runner.html', '<!doctype html><meta charset="utf-8"><title>Extension smoke tests</title><script src="test-runner.js"></script>');
await writeFile('.test-extension/test-runner.js', `const testStreams = ${streams}; const testRutube = ${rutube}; const testDzen = ${dzen}; const testOk = ${okVideo};\n${await readFile('tests/firefox-runner.js', 'utf8')}`);
let finish;
const report = new Promise(resolve => { finish = resolve; });
const server = createFixtureServer(result => { console.log(JSON.stringify(result, null, 2)); finish(result); });
await new Promise(resolve => server.listen(8765, '127.0.0.1', resolve));
const firefox = process.env.FIREFOX_BINARY || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const runner = await webExt.cmd.run({ sourceDir: resolve('.test-extension'), firefox, noReload: true, noInput: true, args: ['-headless'],
  pref: { 'devtools.console.stdout.content': true, 'devtools.console.stdout.chrome': true, 'dom.min_background_timeout_value': 0, 'media.autoplay.default': 0, 'media.block-autoplay-until-in-foreground': false } }, { shouldExitProgram: false });
const timer = setTimeout(() => finish({ ok: false, error: 'Firefox test timeout' }), streams || rutube || dzen ? 240000 : 120000);
const result = await report;
clearTimeout(timer);
if (result.playlist) {
  await writeFile('.test-artifacts/exported-playlist.m3u8', result.playlist);
  if (process.argv.includes('--vlc')) {
    const executable = process.env.VLC_BINARY || 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
    const vlc = spawn(executable, ['--ignore-config', '--intf=dummy', '--vout=dummy', '--aout=dummy', '--no-one-instance', '--no-media-library', '--play-and-exit', '--verbose=2', '--file-logging', `--logfile=${resolve('.test-artifacts/vlc.log')}`, resolve('.test-artifacts/exported-playlist.m3u8')], { windowsHide: true, stdio: 'ignore' });
    const exitCode = await new Promise(resolveExit => {
      const timeout = setTimeout(() => { vlc.kill(); resolveExit('timeout'); }, 45000);
      vlc.on('exit', code => { clearTimeout(timeout); resolveExit(code); });
      vlc.on('error', error => { clearTimeout(timeout); resolveExit(String(error)); });
    });
    const log = await readFile('.test-artifacts/vlc.log', 'utf8').catch(() => '');
    result.vlc = { exitCode, reachedEnd: /end of playlist|nothing to play/i.test(log), decodedVideo: /using video decoder module|Decoded format/i.test(log) };
    if (exitCode !== 0 || !result.vlc.reachedEnd || !result.vlc.decodedVideo) result.ok = false;
    console.log('VLC:', JSON.stringify(result.vlc));
  }
}
await writeFile('.test-artifacts/firefox-report.json', JSON.stringify(result, null, 2));
await runner.exit();
server.close();
process.exitCode = result.ok ? 0 : 1;
