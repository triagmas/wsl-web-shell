'use strict';

/**
 * Confirmation window (issue #12).
 *
 * Renders the snapshot the main process validated. The Update button is only
 * enabled when the plan was accepted, so the window cannot start something the
 * safety checks rejected.
 */
const installedEl = document.getElementById('installed');
const targetEl = document.getElementById('target');
const distroEl = document.getElementById('distro');
const rootEl = document.getElementById('root');
const rollbackEl = document.getElementById('rollback');
const blockedEl = document.getElementById('blocked');
const startButton = document.getElementById('start');
const cancelButton = document.getElementById('cancel');

function render(probe) {
  installedEl.textContent = probe.installed ?? 'unknown';
  targetEl.textContent = probe.target ?? 'unknown';
  distroEl.textContent = probe.distro;
  rootEl.textContent = probe.runtimeRoot;
  rollbackEl.textContent = probe.rollbackPath ?? 'kept next to the runtime';
  if (probe.eligible) {
    blockedEl.hidden = true;
    startButton.disabled = false;
  } else {
    blockedEl.hidden = false;
    blockedEl.textContent = probe.description ?? 'This update cannot be started safely.';
    startButton.disabled = true;
  }
  if (probe.running) {
    blockedEl.hidden = false;
    blockedEl.textContent = 'An update is already running.';
    startButton.disabled = true;
  }
}

startButton.addEventListener('click', () => {
  startButton.disabled = true;
  window.update
    ?.start()
    .then((result) => {
      if (result.started === true) return;
      blockedEl.hidden = false;
      blockedEl.textContent = result.description ?? 'The update could not be started.';
      startButton.disabled = false;
    })
    .catch(() => {
      blockedEl.hidden = false;
      blockedEl.textContent = 'The update could not be started.';
      startButton.disabled = false;
    });
});

cancelButton.addEventListener('click', () => {
  window.update?.close();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.update?.close();
});

window.update
  ?.probe()
  .then(render)
  .catch(() => {
    blockedEl.hidden = false;
    blockedEl.textContent = 'Update details are not available.';
    startButton.disabled = true;
  });
