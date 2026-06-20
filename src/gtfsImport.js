import fs from 'fs';
import * as gtfs from 'gtfs';
import config from './gtfsConfig.js';

// Au delà de cet âge, on réimporte le GTFS statique. En deçà, on réutilise la base existante
// (le GTFS de la TAM change rarement plus d'une fois par jour) -> démarrage quasi instantané.
const MAX_DB_AGE_HOURS = Number(process.env.GTFS_MAX_AGE_HOURS) || 24;

async function importGtfs() {
  try {
    const dbPath = config.sqlitePath;

    if (fs.existsSync(dbPath)) {
      const ageHours = (Date.now() - fs.statSync(dbPath).mtimeMs) / 3600000;
      if (ageHours < MAX_DB_AGE_HOURS) {
        // On saute le réimport, mais il faut quand même OUVRIR la base sinon les requêtes
        // (getStops, getTrips, getRoutes...) échouent avec "no such table".
        await gtfs.openDb(config);
        console.log(`GTFS import ignoré (base à jour, ${ageHours.toFixed(1)} h).`);
        return;
      }
    }

    console.log('Starting GTFS import...');
    await gtfs.importGtfs(config);
    console.log('GTFS import completed successfully.');
  } catch (error) {
    console.error('Error importing GTFS:', error);
    process.exit(1);
  }
}

export default importGtfs;
