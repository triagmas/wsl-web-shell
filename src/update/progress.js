'use strict';

/**
 * Terminal modal (issue #12).
 *
 * Shows the updater output line by line, keeps the last state when the window is
 * opened late, and only offers Close once the run finished. The text is set with
 * `textContent` — never parsed as markup.
 *
 * The main process keeps a rolling buffer of 400 lines and publishes how many
 * lines it dropped from the front (`dropped`). Appending alone would freeze the
 * view once the cap is hit, so a change in `dropped` rebuilds the buffer instead.
 */
const headingEl = document.getElementById('heading');
const statusEl = document.getElementById('status');
const terminalEl = document.getElementById('terminal');
const detailEl = document.getElementById('detail');
const closeButton = document.getElementById('close');

/** Mirrors `planTerminalUpdate` in src/main/core/update.ts. */
let rendered = 0;
let dropped = 0;

function writeLines(lines) {
  terminalEl.textContent = '';
  if (lines.length === 0) return;
  terminalEl.appendChild(document.createTextNode(`${lines.join('\n')}\n`));
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function appendLines(state) {
  const lines = Array.isArray(state.lines) ? state.lines : [];
  const nextDropped = typeof state.dropped === 'number' ? state.dropped : 0;
  if (nextDropped !== dropped) {
    // The rolling cap discarded lines: redraw the whole buffer.
    writeLines(lines);
    dropped = nextDropped;
    rendered = lines.length;
    return;
  }
  const fragment = lines.slice(rendered);
  if (fragment.length === 0) return;
  terminalEl.appendChild(document.createTextNode(`${fragment.join('\n')}\n`));
  rendered = lines.length;
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function render(state) {
  if (!state) return;
  statusEl.textContent = state.message;
  statusEl.dataset.phase = state.phase;
  // The heading names the situation, the status line carries the detail, so the
  // window never shows the same sentence twice.
  headingEl.textContent =
    state.phase === 'done'
      ? 'Update finished'
      : state.phase === 'failed' || state.phase === 'rolled-back'
        ? state.phase === 'rolled-back'
          ? 'Previous version restored'
          : 'Update failed'
        : `Updating DeepSeek Harness to ${state.targetVersion ?? '…'}`;
  detailEl.hidden = state.detail === null || state.detail === '';
  detailEl.textContent = state.detail ?? '';
  appendLines(state);
  const finished = state.phase === 'done' || state.phase === 'failed' || state.phase === 'rolled-back' || state.phase === 'idle';
  closeButton.disabled = !finished;
  closeButton.title = finished ? '' : 'The update is still running';
}

closeButton.addEventListener('click', () => {
  window.update?.close();
});

window.update?.onState(render);
window.update
  ?.state()
  .then(render)
  .catch(() => {
    statusEl.textContent = 'Update state is not available.';
    closeButton.disabled = false;
  });

// Guard against a stuck window: never let the modal become unclosable.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !closeButton.disabled) window.update?.close();
});
