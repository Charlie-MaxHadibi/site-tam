import fs from 'fs';
import path from 'path';
import * as gtfs from 'gtfs';
import config from './gtfsConfig.js';

// Au delà de cet âge, on réimporte le GTFS statique au démarrage. En deçà, on réutilise la
// base existante (le GTFS de la TAM change rarement plus d'une fois par jour) -> démarrage rapide.
const MAX_DB_AGE_HOURS = Number(process.env.GTFS_MAX_AGE_HOURS) || 24;

// Réimport en tâche de fond pendant que le serveur tourne (par défaut : 1 fois par jour).
const REIMPORT_INTERVAL_MS = Number(process.env.GTFS_REIMPORT_INTERVAL_MS) || 24 * 3600 * 1000;

// Délai avant nouvelle tentative quand aucune base locale n'est disponible au démarrage.
const RETRY_DELAY_MS = 60000;

let dbOpened = false;

async function ensureDbOpen() {
  if (dbOpened) return;
  await gtfs.openDb(config);
  dbOpened = true;
}

// Import initial. Ne tue plus le process en cas d'échec :
//  - si une base existe déjà (même périmée), on démarre en mode dégradé ;
//  - sinon on retente en boucle plutôt que de crasher (utile avec `restart: always`).
async function importGtfs() {
  const dbPath = config.sqlitePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // au cas où data/ n'existe pas encore
  const dbExists = fs.existsSync(dbPath);

  if (dbExists) {
    const ageHours = (Date.now() - fs.statSync(dbPath).mtimeMs) / 3600000;
    if (ageHours < MAX_DB_AGE_HOURS) {
      // Il faut quand même OUVRIR la base, sinon les requêtes échouent avec "no such table".
      await ensureDbOpen();
      console.log(`GTFS import ignoré (base à jour, ${ageHours.toFixed(1)} h).`);
      return;
    }
  }

  try {
    console.log('Starting GTFS import...');
    await gtfs.importGtfs(config);
    dbOpened = true; // importGtfs ouvre la base au passage
    console.log('GTFS import completed successfully.');
  } catch (error) {
    console.error('Error importing GTFS:', error.message);
    if (dbExists) {
      await ensureDbOpen();
      console.warn('⚠️  Démarrage en mode dégradé sur la base existante (périmée).');
      return;
    }
    console.error(`Aucune base locale disponible. Nouvelle tentative dans ${RETRY_DELAY_MS / 1000} s...`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return importGtfs();
  }
}

// Relance l'import à intervalle régulier. `onReimport` est appelé après chaque réimport
// réussi : c'est le moment de vider les caches qui référencent des trip_id (ils changent).
function scheduleGtfsReimport(onReimport) {
  const timer = setInterval(async () => {
    try {
      console.log('🔄 Réimport périodique du GTFS statique...');
      await gtfs.importGtfs(config);
      dbOpened = true;
      console.log('✅ Réimport GTFS terminé.');
      if (typeof onReimport === 'function') await onReimport();
    } catch (error) {
      console.error('Réimport GTFS échoué (la base précédente reste en place) :', error.message);
    }
  }, REIMPORT_INTERVAL_MS);
  timer.unref();
  return timer;
}

export default importGtfs;
export { scheduleGtfsReimport };
