/**
 * Test: Einzeltermin-Ausnahmen für Serien (EXDATE, #489)
 * Zweck: Migration v85 (calendar_event_exceptions) + POST /calendar/:id/exceptions
 *        + Filterung in GET /calendar (expandRecurringEvents). Prüft: Ausnahme
 *        blendet genau eine Instanz aus, andere bleiben; nicht-wiederkehrend → 400;
 *        externe Serie → 400; Serien-Löschung entfernt Ausnahmen (CASCADE).
 * Ausführen: node --experimental-sqlite --test test/test-calendar-exceptions.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

// Geteilte :memory:-DB (Singleton) → Events zwischen Tests zurücksetzen.
// Ausnahmen verschwinden per ON DELETE CASCADE mit ihren Events.
beforeEach(() => {
  db.get().prepare('DELETE FROM calendar_events').run();
});

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/', calendarRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

function seedUser() {
  db.get().prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role)
     VALUES (1, 'admin', 'Admin', 'x', 'admin')`
  ).run();
}

// Weekly-Gym-Serie ab Dienstag, 14.07.2026 (lokale, naive Zeit).
// external_source ist NOT NULL DEFAULT 'local' → für lokale Events weglassen.
function seedWeeklyEvent({ external = null } = {}) {
  if (external) {
    return db.get().prepare(
      `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, external_source, created_by)
       VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', ?, 1)`
    ).run(external).lastInsertRowid;
  }
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
     VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', 1)`
  ).run().lastInsertRowid;
}

const RANGE = '?from=2026-07-14&to=2026-07-28';

test('POST exceptions: single occurrence removed from GET, others remain', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const before = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const beforeDates = before.data.map((e) => e.start_datetime);
    assert.deepEqual(beforeDates, ['2026-07-14T18:00', '2026-07-21T18:00', '2026-07-28T18:00']);

    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 201);

    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const afterDates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(afterDates, ['2026-07-14T18:00', '2026-07-28T18:00'], 'nur die ausgenommene Instanz fehlt');
  } finally { await close(); }
});

test('POST exceptions: master start date can be excluded, series continues', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 201);
    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const dates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(dates, ['2026-07-21T18:00', '2026-07-28T18:00']);
  } finally { await close(); }
});

test('POST exceptions: 400 for non-recurring event', async () => {
  seedUser();
  const id = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Einmalig', '2026-07-14T18:00', 1)`
  ).run().lastInsertRowid;
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for externally synced series', async () => {
  seedUser();
  const id = seedWeeklyEvent({ external: 'google' });
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for invalid date', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '14.07.2026' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('DELETE series removes its exceptions (ON DELETE CASCADE)', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    const countBefore = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countBefore, 1);

    const del = await fetch(`${baseUrl}/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const countAfter = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countAfter, 0, 'Ausnahmen der gelöschten Serie sind mitentfernt');
  } finally { await close(); }
});

// --------------------------------------------------------
// #2000: EIN Schluessel fuer "dieses Vorkommen" - der UTC-Tag, auch ueber eine
// Zeitumstellung. Feste Kalendertage, keine Uhr; die Suite laeuft unter
// TZ=UTC und TZ=America/Chicago (package.json), die Prozesszone darf nichts
// aendern.
// --------------------------------------------------------

const { expandRecurringEvents, loadEventExceptions } = await import('../server/services/calendar-events.js');
const { MIGRATIONS } = db;

function setHouseholdZone(zone) {
  db.get().prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(zone);
}

/** Die Starts einer Serie im Fenster, mit den Ausnahmen aus der Datenbank. */
function startsOf(id, from, to) {
  const row = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  return expandRecurringEvents([row], from, to, loadEventExceptions(db.get(), [id]), {
    householdZone: db.get().prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value,
  }).map((occurrence) => occurrence.start_datetime);
}

// New York 19:30, woechentlich ab Montag, 1. Oktober 2035: im Oktober 23:30Z
// am selben Tag, nach dem 4. November 00:30Z am Folgetag. So legt CalDAV die
// Serie ab (Start als UTC, Zone daneben).
function seedNewYorkEvening(external = 'caldav') {
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source, created_by)
     VALUES ('Chor', '2035-10-01T23:30:00Z', '2035-10-02T00:30:00Z', 0, 'FREQ=WEEKLY', 'America/New_York', ?, 1)`
  ).run(external).lastInsertRowid;
}

function addException(id, date) {
  db.get().prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)').run(id, date);
}

test('#2000: EXDATE nach der Zeitumstellung blendet genau dieses Vorkommen aus', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // Der Import legt das Vorkommen vom 12. November (19:30 EST) unter seinem
  // UTC-Tag ab, dem 13. (ics-parser.js: formatICSDate(...).slice(0, 10)).
  addException(id, '2035-11-13');
  assert.deepEqual(startsOf(id, '2035-11-05', '2035-11-25'), [
    '2035-11-06T00:30:00Z',
    '2035-11-20T00:30:00Z',
  ], 'der abgesagte 12. November darf nicht erscheinen, die Nachbarn bleiben');
});

test('#2000: EXDATE vor der Zeitumstellung blendet genau dieses Vorkommen aus', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // 15. Oktober 19:30 EDT = 23:30Z am selben Tag.
  addException(id, '2035-10-15');
  assert.deepEqual(startsOf(id, '2035-10-07', '2035-10-25'), [
    '2035-10-08T23:30:00Z',
    '2035-10-22T23:30:00Z',
  ]);
});

test('#2000: der lokale Tag als EXDATE trifft nach der Umstellung kein Vorkommen', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  // Gegenprobe zur Richtung: der 12. ist nicht der Schluessel des Vorkommens
  // vom 12. November, sonst gaelte je nach Pfad mal der eine, mal der andere.
  addException(id, '2035-11-12');
  assert.deepEqual(startsOf(id, '2035-11-05', '2035-11-25'), [
    '2035-11-06T00:30:00Z',
    '2035-11-13T00:30:00Z',
    '2035-11-20T00:30:00Z',
  ]);
});

test('#2000: Berlin 01:30 ueber die Maerz-Umstellung - EXDATE vor und nach dem Wechsel', () => {
  seedUser();
  setHouseholdZone('Europe/Berlin');
  // 01:30 MEZ = 00:30Z am selben Tag; ab dem 25. Maerz 2035 ist 01:30 MESZ
  // 23:30Z am VORTAG.
  const id = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source, created_by)
     VALUES ('Nacht', '2035-03-05T00:30:00Z', '2035-03-05T01:00:00Z', 0, 'FREQ=WEEKLY', 'Europe/Berlin', 'apple', 1)`
  ).run().lastInsertRowid;
  addException(id, '2035-03-12'); // vor dem Wechsel: Montag 12.03. 01:30 MEZ
  addException(id, '2035-04-01'); // nach dem Wechsel: Montag 02.04. 01:30 MESZ = 01.04. 23:30Z
  assert.deepEqual(startsOf(id, '2035-03-04', '2035-04-10'), [
    '2035-03-05T00:30:00Z',
    '2035-03-19T00:30:00Z',
    '2035-03-25T23:30:00Z',
    '2035-04-08T23:30:00Z',
  ]);
});

test('#2000: die Kennung eines Vorkommens ist sein UTC-Tag, auch fuer einen Start mit Offset', () => {
  // Google speichert den Start mit dem Offset der Serienzone; seine ersten
  // zehn Zeichen sind der lokale Tag.
  const google = {
    id: 9, start_datetime: '2035-11-05T19:30:00-05:00', end_datetime: '2035-11-05T20:30:00-05:00',
    all_day: 0, recurrence_rule: 'FREQ=WEEKLY', tzid: 'America/New_York',
  };
  const rows = expandRecurringEvents([google], '2035-11-04', '2035-11-14', null, { includeRecurrenceIdentity: true });
  assert.deepEqual(rows.map((r) => [r.start_datetime, r.recurrence_identity, r.is_recurring_instance]), [
    ['2035-11-06T00:30:00Z', '2035-11-06', 0],
    ['2035-11-13T00:30:00Z', '2035-11-13', 1],
  ]);
});

test('#2000: GET /calendar zeigt das abgesagte Vorkommen nicht', async () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const id = seedNewYorkEvening();
  addException(id, '2035-11-13');
  const { baseUrl, close } = await startApp();
  try {
    const body = await (await fetch(`${baseUrl}/?from=2035-11-05&to=2035-11-25`)).json();
    assert.deepEqual(body.data.filter((e) => e.id === id).map((e) => e.start_datetime), [
      '2035-11-06T00:30:00Z',
      '2035-11-20T00:30:00Z',
    ]);
  } finally { await close(); }
});

test('#2000: Migration 250 schreibt lokale Schluessel auf den UTC-Tag um, UTC-Schluessel bleiben', () => {
  seedUser();
  setHouseholdZone('America/New_York');
  const migration = MIGRATIONS.find((m) => m.version === 250);
  assert.ok(migration, 'Migration 250 fehlt');
  const exceptions = (id) => db.get().prepare(
    'SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date'
  ).all(id).map((r) => r.exception_date);

  // Google: der Abruf hatte den lokalen Tag abgelegt.
  const google = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, external_source, external_calendar_id, created_by)
     VALUES ('G', '2035-10-01T19:30:00-04:00', '2035-10-01T20:30:00-04:00', 0, 'FREQ=DAILY', 'America/New_York', 'google', 'g1', 1)`
  ).run().lastInsertRowid;
  addException(google, '2035-10-15'); // EDT: derselbe UTC-Tag
  addException(google, '2035-11-12'); // EST: der 13.
  addException(google, '2035-11-13'); // EST: der 14. - taeglich, die beiden verdraengen sich

  // Hier gefuehrt, zonenlose Ziffern neben der tzid (#1993); die Kennung war lokal.
  const local = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, tzid, created_by)
     VALUES ('L', '2035-10-01T19:30', '2035-10-01T20:30', 0, 'FREQ=WEEKLY', 'America/New_York', 1)`
  ).run().lastInsertRowid;
  addException(local, '2035-11-12');
  const child = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_parent_id, recurrence_id, created_by)
     VALUES ('L*', '2035-11-19T21:00', '2035-11-19T22:00', 0, ?, '2035-11-19', 1)`
  ).run(local).lastInsertRowid;

  // CalDAV: schon immer der UTC-Tag - bleibt.
  const caldav = seedNewYorkEvening();
  addException(caldav, '2035-11-13');

  migration.up(db.get());

  assert.deepEqual(exceptions(google), ['2035-10-15', '2035-11-13', '2035-11-14']);
  assert.deepEqual(exceptions(local), ['2035-11-13']);
  assert.equal(db.get().prepare('SELECT recurrence_id FROM calendar_events WHERE id = ?').get(child).recurrence_id, '2035-11-20');
  assert.deepEqual(exceptions(caldav), ['2035-11-13']);

  // Und die Expansion trifft danach das gemeinte Vorkommen.
  const googleStarts = startsOf(google, '2035-11-10', '2035-11-16');
  assert.ok(!googleStarts.includes('2035-11-13T00:30:00Z'), 'Google: der 12. November bleibt abgesagt');
  assert.ok(!googleStarts.includes('2035-11-14T00:30:00Z'), 'Google: der 13. November bleibt abgesagt');
  assert.ok(googleStarts.includes('2035-11-12T00:30:00Z'), 'Google: der 11. November bleibt stehen');
});
