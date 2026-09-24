import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCsv, normalizeLabel, toEmbedUrl, readSettings, looksLikeCsv, deckAction, nextDailyTime,
} from '../lib.js';

const ID = '2PACX-1vTestDeck_abc-123';
const PUB = `https://docs.google.com/presentation/d/e/${ID}/pub?start=false&loop=false&delayms=3000`;
const embed = (seconds) =>
  `https://docs.google.com/presentation/d/e/${ID}/embed?start=true&loop=true&delayms=${seconds * 1000}&rm=minimal`;
const DEFAULTS = { defaultSecondsPerSlide: 10, defaultRefreshMinutes: 5 };

// Settings rows in the shape of the Sheet: label, value, notes.
const sheet = (link, seconds = '10', refresh = '5') => [
  ['Setting', 'Value', 'Notes'],
  ['Slides link', link, 'From the deck'],
  ['Seconds per slide', seconds, ''],
  ['Refresh every (minutes)', refresh, ''],
];

// ---------------------------------------------------------------- parseCsv

test('parseCsv: simple rows with LF or CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseCsv: quoted commas, doubled quotes and line breaks inside quotes', () => {
  assert.deepEqual(parseCsv('"a,b","say ""hi""","line1\nline2"'), [['a,b', 'say "hi"', 'line1\nline2']]);
});

test('parseCsv: empty cells, uneven rows, trailing comma', () => {
  assert.deepEqual(parseCsv('a,,c\nd\ne,'), [['a', '', 'c'], ['d'], ['e', '']]);
  assert.deepEqual(parseCsv('a,""\n""'), [['a', ''], ['']]);
});

test('parseCsv: byte-order mark removed, trailing newline adds no row, empty input', () => {
  assert.deepEqual(parseCsv('﻿a,b\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(undefined), []);
});

test('parseCsv: a quote in the middle of a plain cell is kept as-is', () => {
  assert.deepEqual(parseCsv('5" screen,x'), [['5" screen', 'x']]);
});

// ---------------------------------------------------------------- normalizeLabel

test('normalizeLabel ignores case, spaces and punctuation', () => {
  assert.equal(normalizeLabel('Refresh every (minutes)'), 'refresheveryminutes');
  assert.equal(normalizeLabel('  SLIDES   Link: '), 'slideslink');
  assert.equal(normalizeLabel(undefined), '');
});

// ---------------------------------------------------------------- toEmbedUrl

test('toEmbedUrl: Publish-to-web link becomes the looping, minimal embed URL', () => {
  assert.equal(toEmbedUrl(PUB, 10), embed(10));
  assert.equal(toEmbedUrl(PUB, 3), embed(3));
});

test('toEmbedUrl: /embed links are rebuilt, never reusing the pasted query', () => {
  const pasted = `https://docs.google.com/presentation/d/e/${ID}/embed?start=false&loop=false&delayms=60000&slide=id.p4`;
  assert.equal(toEmbedUrl(pasted, 10), embed(10));
});

test('toEmbedUrl: pasted <iframe> embed code, with &amp; and size attributes', () => {
  const code = `<iframe src="https://docs.google.com/presentation/d/e/${ID}/embed?start=false&amp;loop=false&amp;delayms=3000" frameborder="0" width="960" height="569" allowfullscreen="true"></iframe>`;
  assert.equal(toEmbedUrl(code, 10), embed(10));
});

test('toEmbedUrl: missing https://, surrounding spaces, http and upper-case host are fine', () => {
  assert.equal(toEmbedUrl(`docs.google.com/presentation/d/e/${ID}/pub`, 10), embed(10));
  assert.equal(toEmbedUrl(`  ${PUB}  `, 10), embed(10));
  assert.equal(toEmbedUrl(`http://docs.google.com/presentation/d/e/${ID}/pub`, 10), embed(10));
  assert.equal(toEmbedUrl(`https://DOCS.GOOGLE.COM/presentation/d/e/${ID}/pub`, 10), embed(10));
});

test('toEmbedUrl: the editing link gets its own explanation', () => {
  assert.throws(() => toEmbedUrl('https://docs.google.com/presentation/d/1AbC_dEf-123/edit?usp=sharing', 10),
    /editing link/);
});

test('toEmbedUrl: empty values are rejected with a clear message', () => {
  assert.throws(() => toEmbedUrl('', 10), /empty/);
  assert.throws(() => toEmbedUrl('   ', 10), /empty/);
  assert.throws(() => toEmbedUrl(undefined, 10), /empty/);
});

test('toEmbedUrl: anything that is not a published Google Slides link is rejected', () => {
  const bad = [
    'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml',
    'https://docs.google.com/document/d/e/2PACX-abc/pub',
    `https://docs.google.com.evil.example/presentation/d/e/${ID}/pub`,
    `https://evil.example/?u=https://docs.google.com/presentation/d/e/${ID}/pub`,
    `https://evil.example/docs.google.com/presentation/d/e/${ID}/pub`,
    'javascript:alert(1)',
    'https://docs.google.com/presentation/d/e/abc$def/pub',
    'Announcements deck',
    '<iframe width="960"></iframe>',
  ];
  for (const link of bad) {
    assert.throws(() => toEmbedUrl(link, 10), /isn't a published Google Slides link/, link);
  }
});

// ---------------------------------------------------------------- readSettings

test('readSettings: reads the Sheet layout', () => {
  assert.deepEqual(readSettings(sheet(PUB, '15', '10'), DEFAULTS), {
    embedUrl: embed(15), secondsPerSlide: 15, refreshMinutes: 10, warnings: [],
  });
});

test('readSettings: labels in any case or punctuation, reordered and blank rows, first row wins', () => {
  const rows = [
    [''],
    ['refresh EVERY (mins)', '30'],
    ['SLIDES LINK:', PUB],
    ['seconds-per-slide', '20'],
    ['Slides link', 'https://example.com/ignored-duplicate'],
  ];
  const s = readSettings(rows, DEFAULTS);
  assert.equal(s.embedUrl, embed(20));
  assert.equal(s.refreshMinutes, 30);
});

test('readSettings: blank values use the defaults without warnings', () => {
  const s = readSettings(sheet(PUB, '', ''), DEFAULTS);
  assert.equal(s.secondsPerSlide, 10);
  assert.equal(s.refreshMinutes, 5);
  assert.deepEqual(s.warnings, []);
  const missingRows = readSettings([['Slides link', PUB]], DEFAULTS);
  assert.equal(missingRows.secondsPerSlide, 10);
  assert.equal(missingRows.refreshMinutes, 5);
});

test('readSettings: seconds per slide must be a whole number from 3 to 300', () => {
  assert.equal(readSettings(sheet(PUB, '3'), DEFAULTS).secondsPerSlide, 3);
  assert.equal(readSettings(sheet(PUB, '300'), DEFAULTS).secondsPerSlide, 300);
  for (const bad of ['abc', '2', '301', '10.5', '-5', '10,5']) {
    const s = readSettings(sheet(PUB, bad), DEFAULTS);
    assert.equal(s.secondsPerSlide, 10, bad);
    assert.equal(s.embedUrl, embed(10), bad);
    assert.match(s.warnings[0], /Seconds per slide.*3 to 300/, bad);
  }
});

test('readSettings: refresh is 0 (off) or a whole number from 5 to 1440', () => {
  assert.equal(readSettings(sheet(PUB, '10', '0'), DEFAULTS).refreshMinutes, 0);
  assert.equal(readSettings(sheet(PUB, '10', '5'), DEFAULTS).refreshMinutes, 5);
  assert.equal(readSettings(sheet(PUB, '10', '1440'), DEFAULTS).refreshMinutes, 1440);
  assert.equal(readSettings(sheet(PUB, '10', '1,440'), DEFAULTS).refreshMinutes, 1440);
  for (const bad of ['4', 'x', '1441', '7.5']) {
    const s = readSettings(sheet(PUB, '10', bad), DEFAULTS);
    assert.equal(s.refreshMinutes, 5, bad);
    assert.match(s.warnings[0], /Refresh every.*5 to 1440/, bad);
  }
});

test('readSettings: a missing or unusable link throws a message for staff', () => {
  assert.throws(() => readSettings([['Setting', 'Value'], ['Seconds per slide', '10']], DEFAULTS),
    /no "Slides link" row/);
  assert.throws(() => readSettings(sheet(''), DEFAULTS), /empty/);
  assert.throws(() => readSettings(sheet('https://docs.google.com/presentation/d/1AbC/edit'), DEFAULTS),
    /editing link/);
  assert.throws(() => readSettings([], DEFAULTS), /no "Slides link" row/);
});

test('readSettings: end to end from CSV as Google publishes it, with pasted embed code', () => {
  const code = `<iframe src="https://docs.google.com/presentation/d/e/${ID}/embed?start=false&loop=false&delayms=3000" frameborder="0" width="960" height="569"></iframe>`;
  const csv = 'Setting,Value,Notes\r\n' +
    `Slides link,"${code.replace(/"/g, '""')}","From the deck: File › Share › Publish to web"\r\n` +
    'Seconds per slide,8,"Whole number, 3–300"\r\n' +
    'Refresh every (minutes),0,"0 = only overnight"';
  assert.deepEqual(readSettings(parseCsv(csv), DEFAULTS), {
    embedUrl: embed(8), secondsPerSlide: 8, refreshMinutes: 0, warnings: [],
  });
});

test('readSettings: the fixture files used for local testing', () => {
  const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const good = readSettings(parseCsv(read('settings.csv')), DEFAULTS);
  assert.match(good.embedUrl, /\/embed\?start=true&loop=true&delayms=10000&rm=minimal$/);
  assert.equal(good.refreshMinutes, 5);
  assert.throws(() => readSettings(parseCsv(read('settings-edit-link.csv')), DEFAULTS), /editing link/);
});

// ---------------------------------------------------------------- looksLikeCsv

test('looksLikeCsv accepts CSV however it is labelled, and rejects web pages', () => {
  assert.equal(looksLikeCsv('text/csv', 'Setting,Value'), true);
  assert.equal(looksLikeCsv('application/vnd.ms-excel', 'Setting,Value'), true); // Python's server on Windows
  assert.equal(looksLikeCsv(null, 'Setting,Value'), true);
  assert.equal(looksLikeCsv('text/html; charset=utf-8', 'Setting,Value'), false);
  assert.equal(looksLikeCsv('text/plain', '<!DOCTYPE html><html>'), false);
  assert.equal(looksLikeCsv('', '﻿  <html>'), false);
});

// ---------------------------------------------------------------- deckAction

test('deckAction: what to do after a successful settings check', () => {
  const base = { newUrl: 'A', shownUrl: 'A', pendingUrl: null, suspect: false, shownAt: 0, refreshMinutes: 5, now: 60000 };
  const min = 60000;
  const cases = [
    [{ shownUrl: undefined }, 'changed', 'nothing on screen yet'],
    [{ newUrl: 'B' }, 'changed', 'Sheet points at another deck'],
    [{}, null, 'same deck, nothing due'],
    [{ suspect: true }, 'recover', 'network dropped around the last load'],
    [{ now: 5 * min }, 'refresh', 'refresh is due'],
    [{ now: 5 * min - 1 }, null, 'refresh not quite due'],
    [{ refreshMinutes: 0, now: 1000 * min }, null, 'refresh turned off'],
    [{ pendingUrl: 'A', suspect: true, now: 1000 * min }, null, 'the right deck is already loading'],
    [{ newUrl: 'B', pendingUrl: 'C' }, 'changed', 'a different deck is loading'],
    [{ newUrl: 'A', pendingUrl: 'B' }, 'changed', 'switched back to the deck on screen while another loads'],
  ];
  for (const [change, expected, why] of cases) {
    assert.equal(deckAction({ ...base, ...change }), expected, why);
  }
});

// ---------------------------------------------------------------- nextDailyTime

function inZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

test('nextDailyTime: later today, or tomorrow once the time has passed', () => {
  inZone('America/New_York', () => {
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 8, 24, 2, 59))), [2026, 9, 24, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 8, 24, 3, 0))), [2026, 9, 25, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 8, 24, 15, 0))), [2026, 9, 25, 3, 0]);
    assert.deepEqual(local(nextDailyTime('23:59', new Date(2026, 8, 24, 23, 58))), [2026, 9, 24, 23, 59]);
    assert.deepEqual(local(nextDailyTime('3:05', new Date(2026, 8, 24, 1, 0))), [2026, 9, 24, 3, 5]);
  });
});

test('nextDailyTime: month and year rollover', () => {
  inZone('America/New_York', () => {
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 0, 31, 12, 0))), [2026, 2, 1, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 11, 31, 23, 59))), [2027, 1, 1, 3, 0]);
  });
});

test('nextDailyTime: stays at 03:00 local across daylight-saving changes', () => {
  inZone('America/New_York', () => {
    // Clocks spring forward 02:00 → 03:00 on 8 Mar 2026 and fall back 02:00 → 01:00 on 1 Nov 2026.
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 2, 8, 1, 0))), [2026, 3, 8, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 2, 7, 4, 0))), [2026, 3, 8, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 10, 1, 1, 30))), [2026, 11, 1, 3, 0]);
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 9, 31, 4, 0))), [2026, 11, 1, 3, 0]);
  });
  inZone('Europe/London', () => {
    // Clocks go forward 01:00 → 02:00 on 29 Mar 2026.
    assert.deepEqual(local(nextDailyTime('03:00', new Date(2026, 2, 29, 0, 30))), [2026, 3, 29, 3, 0]);
  });
});

test('nextDailyTime: invalid times give null', () => {
  for (const bad of ['3am', '25:00', '12:60', '', undefined, '03:00:00']) {
    assert.equal(nextDailyTime(bad, new Date()), null, String(bad));
  }
});
