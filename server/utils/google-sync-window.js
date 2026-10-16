/**
 * Modul: Fenster des Google-Full-Resyncs
 * Zweck: EINE Quelle fuer die Grenze, bis zu der ein Abruf ohne syncToken
 *        Termine liefert (`timeMax` in services/google-calendar.js), und fuer
 *        Migration 250, die nur Ausnahmen verwirft, die dieser Abruf auch
 *        wieder schreibt (#2000).
 * Abhängigkeiten: keine
 */

/** So viele Tage reicht `timeMax` eines Full-Resyncs ueber den Abrufzeitpunkt hinaus (exklusiv). */
export const GOOGLE_FULL_SYNC_HORIZON_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `timeMax` eines Full-Resyncs, der zum Zeitpunkt `nowMs` laeuft.
 * @param {number} nowMs
 * @returns {string} ISO-Zeitpunkt
 */
export function googleFullSyncTimeMax(nowMs) {
  return new Date(nowMs + GOOGLE_FULL_SYNC_HORIZON_DAYS * DAY_MS).toISOString();
}
