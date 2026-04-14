import 'dotenv/config';
exclude: ['shapes'];

const config = {
  agencies: [
    {
      url: process.env.GTFS_STATIC_URL,
      //exclude: ['shapes'] // Shapes are heavy, we might not need them for just markers, but let's keep it simple. Actually, node-gtfs needs them for some queries but for markers we don't.
    }
  ],
  sqlitePath: process.env.SQLITE_PATH || 'data/gtfs.db'
};

export default config;