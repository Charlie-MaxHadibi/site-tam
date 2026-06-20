import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as gtfs from 'gtfs';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';

import importGtfs from './gtfsImport.js';
import { startWorker, getCache, getTripUpdates } from './realtimeWorker.js';
import { snapPastSegment } from './tramPath.js';
import { detectLine, LINE_COLORS } from './lines.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CORS : liste blanche (surchargeable via ALLOWED_ORIGINS, séparée par des virgules) ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  'https://infotram.tmaxmls.ovh,http://localhost,https://localhost,capacitor://localhost,ionic://localhost')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Pas d'en-tête Origin (même origine, app native, curl) -> autorisé
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origine non autorisée par CORS'));
  }
};

const app = express();
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ["GET", "POST"] }});
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

let tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [] };
let shapesGeoJson = null;        // GeoJSON des tracés (tagué ligne/couleur), servi par /api/shapes
let lastEnrichedData = [];

// Cache tripId -> destination (évite de réinterroger SQLite à chaque clic sur un arrêt)
const headsignCache = new Map();
async function getHeadsign(tripId) {
  if (!tripId) return "Terminus";
  if (headsignCache.has(tripId)) return headsignCache.get(tripId);
  const trips = await gtfs.getTrips({ trip_id: tripId });
  const headsign = trips.length > 0 ? trips[0].trip_headsign : "Terminus";
  headsignCache.set(tripId, headsign);
  return headsign;
}

async function loadShapesInServerMemory() {
  try {
    console.log("🗺️ Chargement des tracés de tramways en mémoire...");
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    if (!response.ok) throw new Error('Erreur réseau');
    const geojson = await response.json();

    geojson.features.forEach(feature => {
      // On tague chaque tracé : le frontend lira directement properties.line / properties.color
      // (plus de détection dupliquée côté client).
      const num = detectLine(feature.properties);
      feature.properties.line = num;
      feature.properties.color = num ? LINE_COLORS[num] : '#888';

      if (num && feature.geometry.type === 'LineString') {
        tramLinesGeometry[num].push(feature);
      }
    });

    shapesGeoJson = geojson; // mémorisé pour servir /api/shapes sans refaire l'appel distant
    console.log("✅ Tracés mémorisés avec succès !");
  } catch (error) {
    console.error("❌ Erreur mémorisation tracés:", error);
  }
}

// --- ROUTES API ---
app.get('/api/trams', (req, res) => { res.json(getCache()); });

app.get('/api/shapes', async (req, res) => {
  // Servi depuis la mémoire (chargé au démarrage). Repli sur l'appel distant si indisponible.
  if (shapesGeoJson) return res.json(shapesGeoJson);
  try {
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: "Impossible" }); }
});

app.get('/api/stops', async (req, res) => {
  try {
    const routes = await gtfs.getRoutes({ route_type: 0 });
    let groupedStops = {}; 
    for (const route of routes) {
      const stops = await gtfs.getStops({ route_id: route.route_id });
      for (const stop of stops) {
        if (!groupedStops[stop.stop_name]) { groupedStops[stop.stop_name] = { name: stop.stop_name, lat: stop.stop_lat, lon: stop.stop_lon, ids: [] }; }
        if (!groupedStops[stop.stop_name].ids.includes(stop.stop_id)) { groupedStops[stop.stop_name].ids.push(stop.stop_id); }
      }
    }
    res.json(Object.values(groupedStops));
  } catch (error) { res.status(500).json({ error: "Impossible" }); }
});

app.get('/api/times/:stopId', async (req, res) => {
  try {
    const stopId = req.params.stopId;
    // Lecture depuis le cache RAM du worker (plus aucun téléchargement du .pb par requête).
    const raw = getTripUpdates().get(stopId) || [];
    const nowInSeconds = Math.floor(Date.now() / 1000);

    const arrivals = [];
    for (const u of raw) {
      const minutesToWait = Math.floor((u.time - nowInSeconds) / 60);
      if (minutesToWait >= 0 && minutesToWait <= 90) {
        arrivals.push({ routeId: u.routeId, tripId: u.tripId, minutes: minutesToWait });
      }
    }
    arrivals.sort((a, b) => a.minutes - b.minutes);
    const topArrivals = arrivals.slice(0, 3);
    for (const a of topArrivals) {
      a.headsign = await getHeadsign(a.tripId);
    }
    res.json(topArrivals);
  } catch (error) { res.status(500).json({ error: "Erreur" }); }
});

io.on('connection', (socket) => {
  console.log('🔌 Un client est connecté !');
  if (lastEnrichedData.length > 0) {
      socket.emit('trams-update', lastEnrichedData);
  }
});

async function startServer() {
  await importGtfs();
  await loadShapesInServerMemory();

  // Une seule horloge : le worker récupère les positions toutes les 30 s et nous prévient.
  // On enrichit (extrapolation) et on diffuse immédiatement -> parfaitement synchronisé,
  // plus de dérive entre deux timers, calcul idempotent.
  startWorker((vehicles) => {
    if (!vehicles || vehicles.length === 0) return;
    lastEnrichedData = vehicles.map(vehicle => ({
      ...vehicle,
      calculatedPath: snapPastSegment(vehicle, tramLinesGeometry)
    }));
    io.emit('trams-update', lastEnrichedData);
  });

  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

startServer();