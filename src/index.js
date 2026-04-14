import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as gtfs from 'gtfs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// En ESM, il est obligatoire de préciser l'extension .js pour les fichiers locaux !
import importGtfs from './gtfsImport.js';
import { startWorker, getCache } from './realtimeWorker.js';

// Recréation de __dirname pour les ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, '../public')));

// API Route for trams
app.get('/api/trams', (req, res) => {
  res.json(getCache());
});

// Nouvelle API Route pour relayer les tracés (Proxy)
app.get('/api/shapes', async (req, res) => {
  try {
    // C'est le serveur qui télécharge, donc aucun blocage CORS !
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    if (!response.ok) throw new Error('Erreur réseau');
    const geojson = await response.json();
    
    // Le serveur renvoie le fichier propre à ta carte
    res.json(geojson);
  } catch (error) {
    console.error("Erreur lors de la récupération des tracés :", error);
    res.status(500).json({ error: "Impossible de charger les tracés" });
  }
});
// --- 1. ROUTE DES ARRÊTS (Fusionnés par nom de station) ---
app.get('/api/stops', async (req, res) => {
  try {
    const routes = await gtfs.getRoutes({ route_type: 0 });
    let groupedStops = {}; // Notre "boîte" pour regrouper les quais
    
    for (const route of routes) {
      const stops = await gtfs.getStops({ route_id: route.route_id });
      for (const stop of stops) {
        // Si la station n'existe pas encore dans la boîte, on la crée
        if (!groupedStops[stop.stop_name]) {
          groupedStops[stop.stop_name] = {
            name: stop.stop_name,
            lat: stop.stop_lat,
            lon: stop.stop_lon,
            ids: [] // Un tableau qui contiendra le Quai A et le Quai B
          };
        }
        // On ajoute l'ID du quai dans la station
        if (!groupedStops[stop.stop_name].ids.includes(stop.stop_id)) {
          groupedStops[stop.stop_name].ids.push(stop.stop_id);
        }
      }
    }
    // On renvoie la liste propre
    res.json(Object.values(groupedStops));
  } catch (error) {
    console.error("Erreur stops:", error);
    res.status(500).json({ error: "Impossible de charger les arrêts" });
  }
});

// --- 2. ROUTE DES HORAIRES (Avec recherche de destination) ---
app.get('/api/times/:stopId', async (req, res) => {
  try {
    const stopId = req.params.stopId;
    
    const response = await fetch('https://data.montpellier3m.fr/GTFS/Urbain/TripUpdate.pb');
    if (!response.ok) throw new Error("Erreur réseau TAM");
    
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    
    let arrivals = [];
    const nowInSeconds = Math.floor(Date.now() / 1000);

    feed.entity.forEach(entity => {
      if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
        entity.tripUpdate.stopTimeUpdate.forEach(update => {
          if (update.stopId === stopId && update.arrival && update.arrival.time) {
            const timeValue = typeof update.arrival.time === 'object' ? update.arrival.time.low : update.arrival.time;
            const minutesToWait = Math.floor((timeValue - nowInSeconds) / 60);
            
            if (minutesToWait >= 0 && minutesToWait <= 90) {
              arrivals.push({
                routeId: entity.tripUpdate.trip.routeId,
                tripId: entity.tripUpdate.trip.tripId, // On garde l'ID du trajet pour trouver la destination
                minutes: minutesToWait
              });
            }
          }
        });
      }
    });

    // On trie du plus proche au plus lointain
    arrivals.sort((a, b) => a.minutes - b.minutes);
    let topArrivals = arrivals.slice(0, 3); // On garde les 3 prochains
    
    // LA MAGIE : On cherche le nom du Terminus dans la base de données
    for (let i = 0; i < topArrivals.length; i++) {
        const trips = await gtfs.getTrips({ trip_id: topArrivals[i].tripId });
        topArrivals[i].headsign = trips.length > 0 ? trips[0].trip_headsign : "Terminus";
    }

    res.json(topArrivals);
  } catch (error) {
    console.error("Erreur times:", error);
    res.status(500).json({ error: "Impossible de lire les horaires" });
  }
});
async function startServer() {
  // 1. Import Static GTFS at startup
  await importGtfs();

  // 2. Start Real-time Worker
  startWorker();

  // 3. Start Express Server
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

startServer();