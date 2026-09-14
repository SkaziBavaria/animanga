'use strict';

const { readState, saveState, createDatabaseBackup } = require('./state');
const { migrateLibraryToHianime } = require('./hianime-migrate');
const { migrateLibraryToComicK } = require('./comick-migrate');
const { hasAnimeCatalogMapping } = require('./library-identity');

let running = null;

const migrationFields = ['provider', 'providerId', 'hianimeId', 'legacyAnidbId', 'providerMigrationStatus', 'providerMigrationReason', 'providerMigratedAt', 'providerMigrationAttemptedAt'];

function mergeAnimeMigration(current, migrated) {
  if (!current || hasAnimeCatalogMapping(current)) return current;
  const result = { ...current };
  for (const field of migrationFields) {
    if (Object.hasOwn(migrated, field)) result[field] = migrated[field];
  }
  return result;
}

function migrateLibraries() {
  if (running) return running;
  running = (async () => {
    await createDatabaseBackup({ force: true });
    const state = readState();
    const anime = await migrateLibraryToHianime(state, { limit: 25, save: (snapshot) => {
      // Network lookups may overlap edits, removals or sync. Apply mapping fields
      // to fresh records, never write the old library snapshot back wholesale.
      const latest = readState();
      for (const [id, migrated] of Object.entries(snapshot.shows)) {
        const merged = mergeAnimeMigration(latest.shows[id], migrated);
        if (merged) latest.shows[id] = merged;
      }
      saveState(latest);
    } });
    const manga = await migrateLibraryToComicK(state, { limit: 25 });
    if (manga.migrated || manga.needsRematch) saveState(state);
    return { anime, manga };
  })().finally(() => { running = null; });
  return running;
}

async function waitForLibraryMigrations() {
  if (running) await running.catch(() => {});
}

module.exports = { migrateLibraries, waitForLibraryMigrations, mergeAnimeMigration };
