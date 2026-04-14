import * as gtfs from 'gtfs';
import config from './gtfsConfig.js';

async function importGtfs() {
  try {
    console.log('Starting GTFS import...');
    await gtfs.importGtfs(config);
    console.log('GTFS import completed successfully.');
  } catch (error) {
    console.error('Error importing GTFS:', error);
    process.exit(1);
  }
}

export default importGtfs;