/*
 * Headless check of the app-owned chrome (issue #9), and the source of the
 * screenshots in docs/media.
 *
 * It loads the shipped footer and popover pages with their shipped preloads and
 * answers the IPC channels with fixed test data — no WSL, no DeepSeek Harness, no
 * owner desktop. After loading, it asserts what the pages actually rendered and
 * exercises the popover's save path, so a broken footer fails in CI instead of
 * only looking wrong in a picture.
 *
 *   npm run chrome:smoke      render + assert (used by CI)
 *   npm run screenshots       render + assert + write docs/media/*.png
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

// Software rendering only: capturePage under Xvfb fails with a viz error when a
// GPU process is involved.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const root = join(__dirname, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'media');
const scratch = mkdtempSync(join(tmpdir(), 'wsl-web-shell-shots-'));
const WIDTH = 1100;
const HEIGHT = 700;
const FOOTER_HEIGHT = 32;
const POPOVER = { width: 360, height: 460 };
const writeImages = process.argv.includes('--write-images');

const status = {
  state: 'READY',
  detail: null,
  distro: 'Ubuntu',
  port: 3080,
  pid: 48211,
  origin: 'http://127.0.0.1:3080/',
  dshVersion: '0.2.1-rc.5',
  updatedAt: '2026-11-06T13:41:00.000Z',
};

const versions = {
  installed: '0.2.1-rc.5',
  latest: {
    version: '0.2.2-rc.1',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
    prerelease: true,
    publishedAt: '2026-11-04T09:12:00.000Z',
  },
  checkedAt: '2026-11-06T13:41:02.000Z',
  error: null,
  updateAvailable: true,
};

const config = {
  distro: 'Ubuntu',
  port: 3080,
  workspace: '/home/tester/projects/harness',
  dshPath: null,
  isolateEnvironment: true,
  runtimeRoot: '~/.local/share/wsl-web-shell',
  openOnLaunch: true,
  autoRestart: true,
  maxRestartAttempts: 3,
};

/** The update fixture is what the confirmation window shows (issue #12). */
const updateProbe = {
  installed: '0.2.1-rc.5',
  target: '0.2.2-rc.1',
  distro: 'Ubuntu',
  runtimeRoot: '~/.local/share/wsl-web-shell/runtime',
  eligible: true,
  reason: null,
  description: null,
  rollbackPath: '~/.local/share/wsl-web-shell/update/previous-20261106T134500Z',
  running: false,
};

const updateRunning = {
  phase: 'installing',
  message: 'Installing 0.2.2-rc.1',
  detail: 'Staged into ~/.local/share/wsl-web-shell/update/stage-20261106T134500Z',
  targetVersion: '0.2.2-rc.1',
  installedVersion: '0.2.1-rc.5',
  updateAvailable: true,
  dropped: 0,
  lines: [
    'update: published version 0.2.2-rc.1 confirmed by npm',
    'update: staging into ~/.local/share/wsl-web-shell/update/stage-20261106T134500Z',
    'npm: add 1 package in 4s',
    'npm: found 0 vulnerabilities',
  ],
  startedAt: '2026-11-06T13:45:00.000Z',
  finishedAt: null,
};

const updateDone = {
  ...updateRunning,
  phase: 'done',
  message: 'Updated to 0.2.2-rc.1',
  detail: 'Previous installation kept at ~/.local/share/wsl-web-shell/update/previous-20261106T134500Z',
  lines: [
    ...updateRunning.lines,
    'update: verifying the staged installation',
    'update: staged executable reports 0.2.2-rc.1',
    'update: activating',
    'update: installed version 0.2.2-rc.1',
    'update: previous installation kept at ~/.local/share/wsl-web-shell/update/previous-20261106T134500Z',
    'update: starting the new version',
    'update: 0.2.2-rc.1 is serving the WebUI',
  ],
  finishedAt: '2026-11-06T13:45:24.000Z',
};

/** Patches received through `settings:save`, asserted below. */
const saves = [];
let releaseOpened = 0;
let popoverCloseCalls = 0;
let updateOpened = 0;
let updateStarted = 0;
let updateCloseCalls = 0;

function registerIpc() {
  ipcMain.handle('footer:status', () => status);
  ipcMain.handle('footer:versions', () => versions);
  ipcMain.handle('footer:toggle-settings', () => undefined);
  ipcMain.handle('footer:open-release', () => {
    releaseOpened += 1;
  });
  ipcMain.handle('footer:open-update', () => {
    updateOpened += 1;
  });
  ipcMain.handle('update:probe', () => updateProbe);
  ipcMain.handle('update:start', () => {
    updateStarted += 1;
    return { started: true, reason: null, description: null };
  });
  ipcMain.handle('update:state', () => updateRunning);
  ipcMain.handle('update:close', () => {
    updateCloseCalls += 1;
  });
  ipcMain.handle('popover:close', () => {
    popoverCloseCalls += 1;
  });
  ipcMain.handle('settings:open-window', () => undefined);
  ipcMain.handle('settings:distros', () => ['Ubuntu', 'Ubuntu-24.04', 'Debian']);
  ipcMain.handle('settings:load', () => ({
    config,
    distros: ['Ubuntu', 'Ubuntu-24.04', 'Debian'],
    status,
    restartRequired: false,
  }));
  ipcMain.handle('settings:save', (_event, patch) => {
    // Mirrors the real handler: the normalised value comes back to the page.
    saves.push(patch);
    if (typeof patch?.workspace === 'string' && patch.workspace.endsWith('/')) {
      config.workspace = patch.workspace.replace(/\/+$/, '');
    }
    return { ok: true, errors: [], restartRequired: false, config };
  });
}

async function windowFor(width, height, preload, file) {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#0b0f16',
    webPreferences: {
      preload: join(dist, 'preload', preload),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await window.loadURL(file.startsWith('file:') ? file : pathToFileURL(file).href);
  window.showInactive();
  return window;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(window, script) {
  return window.webContents.executeJavaScript(script, true);
}

/** Let the preload's invoke() round-trip resolve and the DOM update. */
async function waitForText(window, selector, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
    if (text.includes(expected)) return text;
    await settle(50);
  }
  return evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
}

async function capture(window, name) {
  await settle(250);
  const image = await window.webContents.capturePage();
  const file = join(scratch, name);
  writeFileSync(file, image.toPNG());
  return pathToFileURL(file).href;
}

function compose(file, body) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0b0f16;overflow:hidden}
    img{display:block}
    .stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px}
    .pop{position:absolute;right:16px;bottom:${FOOTER_HEIGHT + 6}px;width:${POPOVER.width}px;
      border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.6)}
  </style><div class="stage">${body}</div>`;
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function checkFooter() {
  const bar = await windowFor(WIDTH, FOOTER_HEIGHT, 'chrome.js', join(dist, 'chrome', 'index.html'));
  const stateLabel = await waitForText(bar, '#conn-label', 'Connected');
  check('footer renders the connection state', stateLabel.trim() === 'Connected', stateLabel);

  const endpoint = await evaluate(bar, "document.querySelector('#endpoint')?.textContent ?? ''");
  check('footer shows distro and port', endpoint === 'WSL Ubuntu :3080', endpoint);

  const tone = await evaluate(bar, "document.querySelector('#dot')?.dataset.tone ?? ''");
  check('healthy state is green', tone === 'ok', tone);

  const installed = await waitForText(bar, '#installed', '0.2.1-rc.5');
  check('footer shows the running DSH version', installed.includes('0.2.1-rc.5'), installed);

  const latest = await waitForText(bar, '#latest', '0.2.2-rc.1');
  check('footer shows the latest GitHub release', latest.includes('GitHub 0.2.2-rc.1'), latest);

  const arrow = await evaluate(bar, "!document.querySelector('#latest-arrow')?.hidden");
  check('a newer release is signalled without relying on colour', arrow === true);

  await evaluate(bar, "document.querySelector('#latest').click(), null");
  await settle(120);
  check('the release link is handed to the main process', releaseOpened === 1, String(releaseOpened));

  const pill = await evaluate(bar, "document.querySelector('#update')?.hidden ?? true");
  check('the update offer is visible while an update exists', pill === false, String(pill));
  const pillVersion = await waitForText(bar, '#update-version', '0.2.2-rc.1');
  check('the update offer names the new version', pillVersion.trim() === '0.2.2-rc.1', pillVersion);
  const icon = await evaluate(bar, "document.querySelector('#update .update-icon path')?.getAttribute('stroke') ?? ''");
  check('the update offer carries the circular arrow', icon === 'currentColor', icon);

  await evaluate(bar, "document.querySelector('#update').click(), null");
  await settle(120);
  check('the update offer asks the main process for the confirmation window', updateOpened === 1, String(updateOpened));

  await evaluate(bar, "document.querySelector('#gear').click(), null");
  await settle(120);
  const expanded = await evaluate(bar, "document.querySelector('#gear').getAttribute('aria-expanded')");
  check('the gear announces the settings popover state', expanded === 'true', expanded);

  const height = await evaluate(bar, "document.querySelector('#bar').getBoundingClientRect().height");
  check('the bar is 30-34 px tall', height >= 30 && height <= 34, String(height));

  return bar;
}

async function checkPopover() {
  const popover = await windowFor(POPOVER.width, POPOVER.height, 'popover.js', join(dist, 'popover', 'index.html'));
  const groups = await evaluate(popover, "document.querySelectorAll('details.group').length");
  check('settings are grouped and collapsible', groups === 3, String(groups));

  const distroOptions = await evaluate(popover, "document.querySelectorAll('#distro option').length");
  check('the distro list is populated', distroOptions >= 3, String(distroOptions));

  const values = await evaluate(
    popover,
    `(() => {
      const v = (id) => document.getElementById(id);
      return { port: v('port').value, workspace: v('workspace').value, isolate: v('isolateEnvironment').checked };
    })()`,
  );
  check('the popover is pre-filled from the stored config', values.port === '3080', JSON.stringify(values));
  check('the workspace field shows the stored value', values.workspace === '/home/tester/projects/harness', values.workspace);
  check('the isolation toggle reflects the stored config', values.isolate === true);

  // Trailing slash: accepted by Settings, normalised before it reaches the config.
  await evaluate(
    popover,
    `(() => {
      const field = document.getElementById('workspace');
      field.value = '/home/tester/projects/harness/';
      document.getElementById('form').requestSubmit();
      return null;
    })()`,
  );
  await settle(200);
  const saved = saves.at(-1);
  check('save goes through the existing settings channel', saves.length === 1, String(saves.length));
  check('the typed value is sent unchanged for main-process validation', saved?.workspace === '/home/tester/projects/harness/');
  const notice = await evaluate(popover, "document.querySelector('#notice')?.textContent ?? ''");
  check('a successful save is reported', notice.toLowerCase().includes('saved'), notice);
  const normalised = await evaluate(popover, "document.getElementById('workspace').value");
  check('the canonical value is re-rendered after save', normalised === '/home/tester/projects/harness', normalised);

  await evaluate(popover, "document.getElementById('close').click(), null");
  await settle(120);
  check('the popover closes itself on request', popoverCloseCalls === 1, String(popoverCloseCalls));

  return popover;
}

async function checkUpdateWindows() {
  const confirm = await windowFor(620, 520, 'update.js', join(dist, 'update', 'confirm.html'));
  const target = await waitForText(confirm, '#target', '0.2.2-rc.1');
  check('the confirmation window states the exact target version', target.trim() === '0.2.2-rc.1', target);
  const rollback = await evaluate(confirm, "document.querySelector('#rollback')?.textContent ?? ''");
  check('the confirmation window names the rollback copy', rollback.includes('previous-'), rollback);
  const startDisabled = await evaluate(confirm, "document.getElementById('start').disabled");
  check('an accepted plan enables the update button', startDisabled === false, String(startDisabled));
  await evaluate(confirm, "document.getElementById('start').click(), null");
  await settle(150);
  check('starting the update goes through the main process', updateStarted === 1, String(updateStarted));
  await evaluate(confirm, "document.getElementById('cancel').click(), null");
  await settle(120);
  check('the confirmation window can be dismissed', updateCloseCalls === 1, String(updateCloseCalls));

  const progress = await windowFor(720, 520, 'update.js', join(dist, 'update', 'progress.html'));
  const phase = await evaluate(progress, "document.querySelector('#status')?.dataset.phase ?? ''");
  check('the terminal window shows the running phase', phase === 'installing', phase);
  const lines = await evaluate(progress, "document.querySelector('#terminal')?.textContent ?? ''");
  check('the terminal shows the updater output', lines.includes('update: staging into'), lines.slice(0, 60));
  const closeDisabled = await evaluate(progress, "document.getElementById('close').disabled");
  check('the terminal window cannot be closed mid-run', closeDisabled === true, String(closeDisabled));

  // Rolling-cap regression (review blocker D): the main process keeps 400 lines
  // and publishes how many it dropped. Appending alone would freeze the view.
  const streamed = Array.from({ length: 450 }, (_, index) => `update: line ${index + 1}`);
  progress.webContents.send('update:state', {
    ...updateRunning,
    phase: 'installing',
    message: 'Installing 0.2.2-rc.1',
    lines: streamed.slice(0, 400),
    dropped: 0,
  });
  await settle(150);
  progress.webContents.send('update:state', {
    ...updateRunning,
    phase: 'installing',
    message: 'Installing 0.2.2-rc.1',
    lines: streamed.slice(50),
    dropped: 50,
  });
  await settle(200);
  const tail = await evaluate(progress, "document.querySelector('#terminal')?.textContent ?? ''");
  check('the terminal keeps streaming past the 400-line cap', tail.includes('update: line 450'), tail.slice(-60));
  check('the terminal drops the oldest lines instead of freezing', !tail.includes('update: line 1\n'), 'contains line 1');

  progress.webContents.send('update:state', updateDone);
  await settle(250);
  const donePhase = await evaluate(progress, "document.querySelector('#status')?.dataset.phase ?? ''");
  check('a finished update switches the terminal to done', donePhase === 'done', donePhase);
  const closeEnabled = await evaluate(progress, "document.getElementById('close').disabled");
  check('the terminal window is closable once the update finished', closeEnabled === false, String(closeEnabled));
  const keptLines = await evaluate(progress, "document.querySelector('#terminal')?.textContent ?? ''");
  check(
    'the terminal keeps the earlier output instead of replacing it',
    keptLines.includes('update: staging into') && keptLines.includes('is serving the WebUI'),
  );

  // The rollback phase is reported as a finished, closable state.
  progress.webContents.send('update:state', {
    ...updateRunning,
    phase: 'rolled-back',
    message: 'Update failed, previous version restored',
    detail: 'The previous installation was restored. The previous version is running again.',
  });
  await settle(200);
  const rolledBack = await evaluate(progress, "document.querySelector('#status')?.dataset.phase ?? ''");
  const rollbackClose = await evaluate(progress, "document.getElementById('close').disabled");
  check('a rolled-back update is reported and closable', rolledBack === 'rolled-back' && rollbackClose === false, rolledBack);

  return { confirm, progress, done: updateDone };
}

async function writeScreenshots(bar, updateWindows) {
  mkdirSync(outDir, { recursive: true });
  // The checks left the gear in its expanded state; screenshots show it idle.
  await evaluate(bar, "document.querySelector('#gear').setAttribute('aria-expanded','false'), null");
  const webui = await windowFor(WIDTH, HEIGHT - FOOTER_HEIGHT, 'chrome.js', join(root, 'scripts', 'mock-webui.html'));
  const webuiUrl = await capture(webui, 'webui.png');
  const barUrl = await capture(bar, 'footer.png');
  const popover = await windowFor(POPOVER.width, POPOVER.height, 'popover.js', join(dist, 'popover', 'index.html'));
  const popoverUrl = await capture(popover, 'popover.png');

  const plain = compose(
    join(scratch, 'compose-plain.html'),
    `<img src="${webuiUrl}" width="${WIDTH}"><img src="${barUrl}" width="${WIDTH}">`,
  );
  const withPopover = compose(
    join(scratch, 'compose-popover.html'),
    `<img src="${webuiUrl}" width="${WIDTH}"><img src="${barUrl}" width="${WIDTH}"><img class="pop" src="${popoverUrl}">`,
  );

  const shot = await windowFor(WIDTH, HEIGHT, 'chrome.js', plain);
  writeFileSync(join(outDir, 'footer-bar.png'), (await shot.webContents.capturePage()).toPNG());
  const shotPopover = await windowFor(WIDTH, HEIGHT, 'chrome.js', withPopover);
  writeFileSync(join(outDir, 'footer-settings.png'), (await shotPopover.webContents.capturePage()).toPNG());

  // Issue #12: the two steps of a one-click update.
  writeFileSync(join(outDir, 'update-confirm.png'), (await updateWindows.confirm.webContents.capturePage()).toPNG());
  writeFileSync(join(outDir, 'update-terminal.png'), (await updateWindows.progress.webContents.capturePage()).toPNG());
  console.log(`screenshots written to ${outDir}`);
}

async function main() {
  registerIpc();
  const bar = await checkFooter();
  await checkPopover();
  const updateWindows = await checkUpdateWindows();
  if (writeImages) await writeScreenshots(bar, updateWindows);
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} chrome check(s) failed`);
  }
  console.log(`chrome smoke: ok (${results.length} checks)`);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(`chrome smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
