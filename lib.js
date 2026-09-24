// Pure helpers for the Sign Player. Nothing here touches the page, so all of it
// can be unit-tested on a PC with `npm test` (see tests/lib.test.js).
// Written for older ChromeOS devices too: no ?. or ?? operators.

const MSG_EMPTY =
  'The "Slides link" cell is empty. In the deck, use File › Share › Publish to web, then copy the link into the Sheet.';
const MSG_EDIT_LINK =
  'The "Slides link" is the deck\'s editing link. In the deck, use File › Share › Publish to web, then copy that link into the Sheet instead.';
const MSG_NOT_SLIDES =
  'The "Slides link" isn\'t a published Google Slides link. In the deck, use File › Share › Publish to web, then paste the whole link as plain text.';

// Settings rows are found by the start of their column-A label, ignoring case and punctuation.
const SETTING_LABELS = [
  ['link', 'slideslink'],
  ['seconds', 'secondsperslide'],
  ['refresh', 'refreshevery'],
];

/**
 * Split CSV text (as Google Sheets publishes it) into rows of cells.
 * Handles quoted cells containing commas, line breaks and doubled quotes ("").
 */
export function parseCsv(text) {
  const input = String(text == null ? '' : text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;     // inside a quoted cell right now
  let wasQuoted = false;  // the current cell started with a quote (so "" is a real, empty cell)
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (input[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      wasQuoted = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      wasQuoted = false;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || wasQuoted || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 'Refresh every (minutes)' → 'refresheveryminutes' */
export function normalizeLabel(label) {
  return String(label == null ? '' : label).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Turn whatever was pasted into the Sheet into the one address the player shows:
 * the deck's /embed page, set to start straight away, loop, advance every `seconds`
 * and hide the Slides controls. Accepts the "Publish to web" link, an /embed link,
 * or the <iframe> embed code. Throws an error message staff can act on.
 */
export function toEmbedUrl(link, seconds) {
  let text = String(link == null ? '' : link).trim();
  if (!text) throw new Error(MSG_EMPTY);
  if (/<iframe/i.test(text)) {
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(text);
    if (!src) throw new Error(MSG_NOT_SLIDES);
    text = src[1].trim();
  }
  text = text.replace(/&amp;/g, '&');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text.replace(/^\/+/, '');

  let url;
  try {
    url = new URL(text);
  } catch (e) {
    throw new Error(MSG_NOT_SLIDES);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname !== 'docs.google.com') {
    throw new Error(MSG_NOT_SLIDES);
  }

  const published = /^\/presentation\/d\/e\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
  if (!published) {
    if (/^\/presentation\/d\/(?!e\/)[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname)) throw new Error(MSG_EDIT_LINK);
    throw new Error(MSG_NOT_SLIDES);
  }
  const delayMs = Math.round(Number(seconds) * 1000);
  if (!(delayMs > 0)) throw new Error('Seconds per slide must be more than 0.');
  // Always rebuilt from the deck ID: the pasted query is never reused, and /pub pages refuse to be framed.
  return 'https://docs.google.com/presentation/d/e/' + published[1] +
    '/embed?start=true&loop=true&delayms=' + delayMs + '&rm=minimal';
}

/**
 * Read the Settings tab (rows from parseCsv) into what the player needs:
 * { embedUrl, secondsPerSlide, refreshMinutes, warnings }.
 * Rows are matched by their label in column A and read from column B; order doesn't matter
 * and the first matching row wins. A missing or unusable link throws; other bad values
 * fall back to the defaults and add a warning.
 */
export function readSettings(rows, defaults) {
  const found = {};
  for (const row of rows) {
    const label = normalizeLabel(row[0]);
    for (const [key, prefix] of SETTING_LABELS) {
      if (!(key in found) && label.startsWith(prefix)) found[key] = String(row[1] == null ? '' : row[1]).trim();
    }
  }
  if (!('link' in found)) {
    throw new Error('The Sheet has no "Slides link" row. Check that the Settings tab is the one published, and that column A hasn\'t been renamed.');
  }

  const warnings = [];
  const secondsPerSlide = wholeNumber(found.seconds, 3, 300, defaults.defaultSecondsPerSlide,
    'Seconds per slide', warnings);
  const refreshMinutes = isZero(found.refresh) ? 0
    : wholeNumber(found.refresh, 5, 1440, defaults.defaultRefreshMinutes, 'Refresh every (minutes)', warnings);
  return { embedUrl: toEmbedUrl(found.link, secondsPerSlide), secondsPerSlide, refreshMinutes, warnings };
}

function toNumber(text) {
  // Allow spaces and thousands separators ("1,440"), but not decimal commas.
  return Number(String(text).replace(/\s/g, '').replace(/,(?=\d{3}(?!\d))/g, ''));
}

function isZero(text) {
  return text !== undefined && text !== '' && toNumber(text) === 0;
}

function wholeNumber(text, min, max, fallback, name, warnings) {
  if (text === undefined || text === '') return fallback;
  const n = toNumber(text);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push('"' + name + '" should be a whole number from ' + min + ' to ' + max +
    ', so ' + fallback + ' is being used instead.');
  return fallback;
}

/** False when a response is a web page (such as a Google sign-in or error page) rather than CSV. */
export function looksLikeCsv(contentType, text) {
  if (/html/i.test(String(contentType || ''))) return false;
  return !/^\s*</.test(String(text == null ? '' : text).replace(/^﻿/, ''));
}

/**
 * After a successful settings check, decide what to do with the deck:
 *   'changed' – the Sheet points at a different deck or timing (or nothing is showing yet)
 *   'recover' – the network dropped around the last load, so the frame may hold an error page
 *   'refresh' – the deck has been up for "Refresh every" minutes; reload it to pick up edits
 *   null      – leave it alone
 * `shownAt` and `now` come from the same clock (performance.now(), in ms).
 */
export function deckAction({ newUrl, shownUrl, pendingUrl, suspect, shownAt, refreshMinutes, now }) {
  const current = pendingUrl || shownUrl;
  if (newUrl !== current) return 'changed';
  if (pendingUrl) return null; // the right deck is already loading
  if (suspect) return 'recover';
  if (refreshMinutes > 0 && now - shownAt >= refreshMinutes * 60000) return 'refresh';
  return null;
}

/**
 * The next moment, strictly after `now`, when this device's clock reads `hhmm` (24-hour "HH:MM").
 * Returns null if `hhmm` isn't a valid time.
 */
export function nextDailyTime(hhmm, now) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm).trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const next = new Date(now.getTime());
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}
