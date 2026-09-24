// Sign Player: shows the Google Slides deck named in the settings Sheet, full screen,
// and keeps it running and up to date with nobody touching the sign.
// How it works and how to set it up: README.md.
// Written for older ChromeOS devices too: no ?. or ?? operators.

import config from './config.js';
import { parseCsv, readSettings, looksLikeCsv, deckAction, nextDailyTime } from './lib.js';

const VERSION = '1.0.0';
const TICK_MS = 5000;              // how often the player checks what it should be doing
const QUICK_CHECK_MS = 15000;      // Sheet check interval while there's no deck, or it may be broken
const FETCH_TIMEOUT_MS = 15000;    // give up on a Sheet check after this long
const LOAD_TIMEOUT_MS = 45000;     // give up on a deck that hasn't loaded after this long
const SETTLE_MS = 2500;            // after a deck loads, let Slides draw its first slide before fading in
const REMOVE_OLD_MS = 1000;        // remove the old deck once the 0.6 s fade has finished
const SAVED_DECK_AFTER_MS = 60000; // Sheet unreachable since startup: show the deck saved on this device after this long
const CLOCK_JUMP_MS = 6 * 3600000; // nightly reload this overdue means the clock jumped: reschedule instead
const STORAGE_KEY = 'signage.lastGoodCsv';
const LOG_LINES = 20;

const params = new URLSearchParams(location.search);
const debug = params.has('debug') && params.get('debug') !== '0';
const settingsUrl = resolveUrl(params.get('settings') || config.settingsCsvUrl);

const stage = document.getElementById('stage');
const messageBox = document.getElementById('message');
const debugBox = document.getElementById('debug');

const state = {
  settings: null,           // last good settings: from the Sheet, or the copy saved on this device
  settingsFrom: 'nowhere yet',
  savedText: '',            // CSV text last saved to localStorage
  shown: null,              // deck on screen: { frame, url, at }
  pending: null,            // deck loading on top, invisible: { frame, url, timer }
  suspect: false,           // the deck on screen may be an error page: reload it at the next good check
  failStreak: 0,            // Sheet checks in a row that couldn't reach Google
  reachedAt: -Infinity,     // when a Sheet check last got any answer from Google (performance.now())
  checked: false,           // at least one Sheet check has finished
  nextCheckAt: 0,
  lastError: '',
  lastErrorIsNetwork: false,
  busy: false,
  reloadAt: nextDailyTime(config.nightlyReloadAt, new Date()),
  wakeLock: null,
  wakeLockRequesting: false,
  wakeLockNote: '',
  log: [],
};

start();

function start() {
  window.signPlayerStarted = true; // tells the watchdog in index.html that the player is running
  debugBox.hidden = !debug;
  loadSaved();
  window.addEventListener('offline', () => markSuspect('the device went offline'));
  window.addEventListener('online', () => {
    note('Back online');
    state.nextCheckAt = 0;
    setTimeout(tick, 3000);
  });
  document.addEventListener('visibilitychange', keepAwake);
  window.addEventListener('error', (event) => note('Error: ' + event.message));
  window.addEventListener('unhandledrejection', (event) => note('Error: ' + describe(event.reason)));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .catch((error) => note('Service worker not registered: ' + describe(error)));
  }
  note('Sign Player ' + VERSION + ' started');
  render();
  tick();
  setInterval(tick, TICK_MS);
}

// Everything the player does happens here, one step at a time.
async function tick() {
  if (state.busy) return;
  state.busy = true;
  try {
    if (nightlyReloadDue()) {
      note('Nightly reload');
      location.reload();
      return;
    }
    if (performance.now() >= state.nextCheckAt) await checkSheet();
    // Still no deck a minute after starting, because the Sheet can't be reached:
    // show the deck saved on this device rather than nothing.
    if (!state.shown && !state.pending && state.settings && state.checked &&
        performance.now() >= SAVED_DECK_AFTER_MS) {
      showDeck(state.settings.embedUrl, 'saved');
    }
    keepAwake();
  } catch (error) {
    note('Unexpected problem: ' + describe(error));
  } finally {
    state.busy = false;
    render();
  }
}

// Read the settings Sheet, then load or reload the deck if needed.
async function checkSheet() {
  const result = await fetchSettings();
  state.checked = true;
  if (result.network) {
    state.failStreak++;
    setError(result.error, true);
    // A failure straight after a deck loaded could mean it loaded an error page.
    if (state.failStreak >= 2 || (state.shown && state.reachedAt < state.shown.at)) markSuspect('no network');
  } else {
    state.failStreak = 0;
    state.reachedAt = performance.now();
    if (result.settings) {
      state.settings = result.settings;
      state.settingsFrom = 'the Sheet at ' + new Date().toLocaleTimeString();
      setError('', false);
      save(result.text);
    } else {
      setError(result.error, false);
    }
    // Google answered, so the network is up. Act on the best settings we have: even when
    // the Sheet itself has a problem, the last good deck keeps being refreshed and recovered.
    if (state.settings) {
      const action = deckAction({
        newUrl: state.settings.embedUrl,
        shownUrl: state.shown ? state.shown.url : null,
        pendingUrl: state.pending ? state.pending.url : null,
        suspect: state.suspect,
        shownAt: state.shown ? state.shown.at : 0,
        refreshMinutes: state.settings.refreshMinutes,
        now: performance.now(),
      });
      if (action) showDeck(state.settings.embedUrl, action);
    }
  }
  const wait = state.shown && !state.suspect ? config.pollSeconds * 1000 : QUICK_CHECK_MS;
  state.nextCheckAt = performance.now() + wait * (0.9 + Math.random() * 0.2); // spread the signs out a little
}

// One Sheet check. Returns { settings, text }, or { error, network } when it fails.
async function fetchSettings() {
  if (!settingsUrl) return { error: 'The settings Sheet link in config.js hasn\'t been filled in yet.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetch(settingsUrl, { cache: 'no-store', signal: controller.signal });
    text = await response.text();
  } catch (error) {
    const why = error.name === 'AbortError' ? 'no answer after ' + FETCH_TIMEOUT_MS / 1000 + ' s' : describe(error);
    return {
      network: true,
      error: 'Can\'t reach the settings Sheet (' + why + '). Check the network, and that the Sheet is published to anyone on the web.',
    };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const hint = response.status === 404 || response.status === 410 ? ' Is its Settings tab still published to the web?' : '';
    return { error: 'The settings Sheet answered with error ' + response.status + '.' + hint };
  }
  if (!looksLikeCsv(response.headers.get('content-type'), text)) {
    return { error: 'The settings link returned a web page, not CSV. Publish the Settings tab as "Comma-separated values (.csv)".' };
  }
  try {
    return { settings: readSettings(parseCsv(text), config), text: text };
  } catch (error) {
    return { error: describe(error) };
  }
}

// Load a deck on top of the current one, invisibly, and fade it in once it's ready.
function showDeck(url, reason) {
  cancelPending();
  note('Loading the deck (' + reason + ')');
  const frame = document.createElement('iframe');
  frame.className = 'deck incoming'; // invisible, but never display:none: Chrome throttles hidden frames
  frame.title = 'Sign';
  frame.tabIndex = -1;
  frame.setAttribute('allow', 'autoplay');
  const load = { frame: frame, url: url, timer: 0 };
  load.timer = setTimeout(() => {
    if (state.pending !== load) return;
    cancelPending();
    markSuspect('the deck did not load within ' + LOAD_TIMEOUT_MS / 1000 + ' s');
  }, LOAD_TIMEOUT_MS);
  frame.addEventListener('load', function onLoad() {
    if (state.pending !== load || isBlank(frame)) return;
    frame.removeEventListener('load', onLoad);
    clearTimeout(load.timer);
    load.timer = setTimeout(() => reveal(load), state.shown ? SETTLE_MS : 0);
  });
  // "load" also fires for error pages. A deck loaded while offline, or from the saved copy,
  // is treated as suspect and reloaded once a Sheet check confirms the network is up.
  state.suspect = reason === 'saved' || !navigator.onLine;
  state.pending = load;
  frame.src = url;
  stage.appendChild(frame);
}

function reveal(load) {
  if (state.pending !== load) return;
  const old = state.shown;
  state.pending = null;
  state.shown = { frame: load.frame, url: load.url, at: performance.now() };
  load.frame.classList.remove('incoming'); // fades in over 0.6 s
  if (old) setTimeout(() => old.frame.remove(), REMOVE_OLD_MS);
  note('Deck on screen');
  render();
}

function cancelPending() {
  const load = state.pending;
  if (!load) return;
  clearTimeout(load.timer);
  load.frame.remove();
  state.pending = null;
}

// The initial about:blank document (same-origin) can fire "load" before the real page.
function isBlank(frame) {
  try {
    return frame.contentWindow.location.href === 'about:blank';
  } catch (error) {
    return false; // cross-origin: the real page (or an error page) has loaded
  }
}

function markSuspect(why) {
  if (!state.suspect) note('The deck may need reloading: ' + why);
  state.suspect = true;
  state.nextCheckAt = Math.min(state.nextCheckAt, performance.now() + QUICK_CHECK_MS);
}

function nightlyReloadDue() {
  if (!state.reloadAt || Date.now() < state.reloadAt.getTime()) return false;
  if (Date.now() - state.reloadAt.getTime() > CLOCK_JUMP_MS) {
    // Far overdue means the clock was set after the page loaded: just schedule the next one.
    state.reloadAt = nextDailyTime(config.nightlyReloadAt, new Date());
    return false;
  }
  // Only reload with the network up, so the sign never reloads into an outage.
  return navigator.onLine && state.checked && state.failStreak === 0;
}

// Ask the browser to keep the screen on. The kiosk power policy in the Admin console matters too.
async function keepAwake() {
  if (!('wakeLock' in navigator)) {
    state.wakeLockNote = 'not supported';
    return;
  }
  if (state.wakeLock || state.wakeLockRequesting || document.visibilityState !== 'visible') return;
  state.wakeLockRequesting = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      if (state.wakeLock === lock) state.wakeLock = null;
    });
    state.wakeLock = lock;
    state.wakeLockNote = '';
  } catch (error) {
    state.wakeLockNote = describe(error);
  } finally {
    state.wakeLockRequesting = false;
  }
}

// The last good settings are saved on the device as the raw CSV text, so the sign can
// still show its deck after a reboot when the Sheet can't be reached.
function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || saved.url !== settingsUrl) return;
    state.settings = readSettings(parseCsv(saved.text), config);
    state.savedText = saved.text;
    state.settingsFrom = 'the copy saved on ' + new Date(saved.at).toLocaleString();
  } catch (error) {
    // Nothing usable saved: wait for the Sheet.
  }
}

function save(text) {
  if (text === state.savedText) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: settingsUrl, text: text, at: Date.now() }));
    state.savedText = text;
  } catch (error) {
    note('Could not save the settings on this device: ' + describe(error));
  }
}

function setError(message, isNetwork) {
  if (message && message !== state.lastError) note(message);
  state.lastError = message;
  state.lastErrorIsNetwork = isNetwork;
}

// Show "Connecting…" or "Sign not set up" when there's no deck, and update the debug panel.
function render() {
  let message = '';
  if (!state.shown && !state.pending && state.checked) {
    message = state.lastError && !state.lastErrorIsNetwork && !state.settings
      ? 'Sign not set up: ' + state.lastError
      : 'Connecting…';
  }
  messageBox.textContent = message;
  messageBox.hidden = !message;
  if (debug) debugBox.textContent = debugText();
}

function debugText() {
  const s = state.settings;
  const secondsToCheck = Math.max(0, Math.round((state.nextCheckAt - performance.now()) / 1000));
  const lines = [
    'Sign Player ' + VERSION + '   ' + new Date().toLocaleString() +
      '   time zone ' + Intl.DateTimeFormat().resolvedOptions().timeZone,
    'Settings Sheet: ' + (settingsUrl || '(not set in config.js)'),
    'Settings from ' + state.settingsFrom,
    'Deck: ' + (state.shown ? state.shown.url : '(none)'),
  ];
  if (state.pending) lines.push('Loading: ' + state.pending.url);
  if (s) {
    lines.push('Seconds per slide ' + s.secondsPerSlide +
      '   refresh ' + (s.refreshMinutes ? 'every ' + s.refreshMinutes + ' min' : 'off (overnight only)'));
  }
  lines.push('Status: ' + (state.suspect ? 'deck will be reloaded at the next good check' : 'ok') +
    '   online ' + navigator.onLine + '   failed checks in a row ' + state.failStreak);
  lines.push('Next Sheet check in ' + secondsToCheck + ' s   nightly reload ' +
    (state.reloadAt ? state.reloadAt.toLocaleString() : 'off'));
  lines.push('Wake lock ' + (state.wakeLock ? 'on' : 'off' + (state.wakeLockNote ? ' (' + state.wakeLockNote + ')' : '')) +
    '   service worker ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'active' : 'not active'));
  if (state.lastError) lines.push('Problem: ' + state.lastError);
  if (s) s.warnings.forEach((warning) => lines.push('Warning: ' + warning));
  return lines.concat([''], state.log).join('\n');
}

function note(message) {
  state.log.unshift(new Date().toLocaleTimeString() + '  ' + message);
  if (state.log.length > LOG_LINES) state.log.length = LOG_LINES;
  console.info('[sign]', message);
}

function describe(error) {
  return error && error.message ? error.message : String(error);
}

function resolveUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    return new URL(text, location.href).href;
  } catch (error) {
    return '';
  }
}
