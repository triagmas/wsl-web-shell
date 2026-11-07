/*
 * Footer controller. Plain DOM, no framework, no remote content.
 *
 * The bar is informational: it renders the supervisor snapshot, the DSH versions
 * and a gear that toggles the settings popover. It never navigates anywhere; the
 * upstream release link is handed to the system browser by the main process.
 */
const dot = document.getElementById('dot');
const connLabel = document.getElementById('conn-label');
const endpoint = document.getElementById('endpoint');
const installedButton = document.getElementById('installed');
const latestButton = document.getElementById('latest');
const updateButton = document.getElementById('update');
const updateVersion = document.getElementById('update-version');
const gear = document.getElementById('gear');

const STATE_TONES = {
  CHECKING: 'warn',
  STARTING_WSL: 'warn',
  STARTING_WEB: 'warn',
  CONNECTING: 'warn',
  READY: 'ok',
  HIDDEN_IN_TRAY: 'ok',
  RECOVERING: 'warn',
  ERROR: 'error',
  QUITTING: 'idle',
};

const STATE_LABELS = {
  CHECKING: 'Checking',
  STARTING_WSL: 'Starting WSL',
  STARTING_WEB: 'Starting backend',
  CONNECTING: 'Connecting',
  READY: 'Connected',
  HIDDEN_IN_TRAY: 'Connected (hidden)',
  RECOVERING: 'Reconnecting',
  ERROR: 'Unavailable',
  QUITTING: 'Shutting down',
};

/** Latest release URL, kept so the label can hand it to the system browser. */
let releaseUrl = null;
let installedVersion = null;

function renderStatus(status) {
  if (!status) return;
  const tone = STATE_TONES[status.state] ?? 'idle';
  const label = STATE_LABELS[status.state] ?? status.state;
  dot.dataset.tone = tone;
  connLabel.textContent = label;
  const text = `WSL ${status.distro} :${status.port}`;
  endpoint.textContent = text;
  endpoint.title = text;
  const detail = status.detail ? ` — ${status.detail}` : '';
  document.getElementById('bar').title = `${label} — ${text}${detail}`;
  document.getElementById('bar').dataset.tone = tone;
}

function setLabel(button, text) {
  const target = button.querySelector('.version-text') ?? button;
  target.textContent = text;
}

function renderVersions(snapshot) {
  if (!snapshot) return;
  const arrow = document.getElementById('latest-arrow');
  installedVersion = snapshot.installed ?? null;
  setLabel(installedButton, installedVersion ? `DSH ${installedVersion}` : 'DSH —');
  installedButton.title = installedVersion
    ? `DeepSeek Harness ${installedVersion} (executable in use). Click the GitHub label to open the release page.`
    : 'DeepSeek Harness version is not known yet (backend not started).';
  installedButton.dataset.state = installedVersion ? 'ready' : 'loading';

  // The circular-arrow offer exists only while an update is available: the new
  // version is never shown as an action when there is nothing to install.
  const target = snapshot.updateAvailable ? (snapshot.latest?.version ?? null) : null;
  updateButton.hidden = target === null;
  if (target !== null) {
    updateVersion.textContent = target;
    updateButton.setAttribute('aria-label', `Update DeepSeek Harness to ${target}`);
    updateButton.title = `Update DeepSeek Harness ${installedVersion ?? ''} → ${target} in the isolated runtime`;
  }

  releaseUrl = snapshot.latest?.url ?? null;
  if (snapshot.latest === null) {
    setLabel(latestButton, 'GitHub …');
    arrow.hidden = true;
    latestButton.dataset.state = 'loading';
    latestButton.dataset.update = 'false';
    latestButton.title = snapshot.error
      ? `Latest GitHub release is unknown (${snapshot.error}).`
      : 'Checking the latest DeepSeek Harness release on GitHub…';
    return;
  }
  setLabel(latestButton, `GitHub ${snapshot.latest.version}`);
  latestButton.dataset.state = releaseUrl ? 'link' : 'ready';
  latestButton.dataset.update = snapshot.updateAvailable ? 'true' : 'false';
  // Colour is never the only signal: a newer release also shows an arrow.
  arrow.hidden = !snapshot.updateAvailable;
  const pre = snapshot.latest.prerelease ? ' (pre-release)' : '';
  const checked = snapshot.checkedAt ? `, checked ${new Date(snapshot.checkedAt).toLocaleString()}` : '';
  const newer = snapshot.updateAvailable ? ' Newer than the installed version; upgrade manually if you want it.' : '';
  latestButton.title = `Latest published release on GitHub: ${snapshot.latest.version}${pre}${checked}. Informational only — nothing is downloaded or upgraded.${newer}`;
}

gear.addEventListener('click', () => {
  const rect = gear.getBoundingClientRect();
  const open = gear.getAttribute('aria-expanded') === 'true';
  gear.setAttribute('aria-expanded', String(!open));
  window.footer
    ?.toggleSettings({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    .catch(() => gear.setAttribute('aria-expanded', 'false'));
});

updateButton.addEventListener('click', () => {
  window.footer?.openUpdate();
});

latestButton.addEventListener('click', () => {
  if (releaseUrl) window.footer?.openRelease();
});

window.addEventListener('blur', () => gear.setAttribute('aria-expanded', 'false'));

window.footer?.onStatus(renderStatus);
window.footer?.onVersions(renderVersions);
window.footer?.requestStatus().then(renderStatus).catch(() => undefined);
window.footer?.requestVersions().then(renderVersions).catch(() => undefined);
