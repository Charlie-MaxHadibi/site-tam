import 'dotenv/config';

const config = {
  agencies: [
    {
      url: process.env.GTFS_STATIC_URL,
      exclude: ['shapes'] // C'est ici qu'il faut le mettre pour alléger la base de données !
    }
  ],
  sqlitePath: process.env.SQLITE_PATH || 'data/gtfs.db'
};

export default config;