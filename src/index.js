import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as gtfs from 'gtfs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import cors from 'cors';

// NOUVEAU : Imports pour les WebSockets
import http from 'http'; 
import { Server } from 'socket.io'; 

import importGtfs from './gtfsImport.js';
import { startWorker, getCache } from './realtimeWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// autorise les app a lire l'API
app.use(cors());

// On crée un serveur HTTP qui "enveloppe" Express
const server = http.createServer(app); 

// NOUVEAU : On attache Socket.io avec les autorisations CORS ouvertes
const io = new Server(server, {
  cors: {
    origin: "*", // Autorise les connexions depuis n'importe où
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

// On garde l'ancienne API pour la compatibilité
app.get('/api/trams', (req, res) => {
  res.json(getCache());
});

app.get('/api/shapes', async (req, res) => {
  try {
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    if (!response.ok) throw new Error('Erreur réseau');
    const geojson = await response.json();
    res.json(geojson);
  } catch (error) {
    console.error("Erreur tracés:", error);
    res.status(500).json({ error: "Impossible de charger les tracés" });
  }
});

app.get('/api/stops', async (req, res) => {
  try {
    const routes = await gtfs.getRoutes({ route_type: 0 });
    let groupedStops = {}; 
    for (const route of routes) {
      const stops = await gtfs.getStops({ route_id: route.route_id });
      for (const stop of stops) {
        if (!groupedStops[stop.stop_name]) {
          groupedStops[stop.stop_name] = { name: stop.stop_name, lat: stop.stop_lat, lon: stop.stop_lon, ids: [] };
        }
        if (!groupedStops[stop.stop_name].ids.includes(stop.stop_id)) {
          groupedStops[stop.stop_name].ids.push(stop.stop_id);
        }
      }
    }
    res.json(Object.values(groupedStops));
  } catch (error) {
    res.status(500).json({ error: "Impossible de charger les arrêts" });
  }
});

app.get('/api/times/:stopId', async (req, res) => {
  try {
    const stopId = req.params.stopId;
    const response = await fetch('https://data.montpellier3m.fr/GTFS/Urbain/TripUpdate.pb');
    if (!response.ok) throw new Error("Erreur réseau");
    
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
              arrivals.push({ routeId: entity.tripUpdate.trip.routeId, tripId: entity.tripUpdate.trip.tripId, minutes: minutesToWait });
            }
          }
        });
      }
    });

    arrivals.sort((a, b) => a.minutes - b.minutes);
    let topArrivals = arrivals.slice(0, 3); 
    
    for (let i = 0; i < topArrivals.length; i++) {
        const trips = await gtfs.getTrips({ trip_id: topArrivals[i].tripId });
        topArrivals[i].headsign = trips.length > 0 ? trips[0].trip_headsign : "Terminus";
    }
    res.json(topArrivals);
  } catch (error) {
    res.status(500).json({ error: "Erreur" });
  }
});

// NOUVEAU : Gérer les connexions des utilisateurs
io.on('connection', (socket) => {
  console.log('🔌 Un client est connecté !');
  // Dès qu'il se connecte, on lui envoie la dernière position connue pour qu'il n'attende pas
  socket.emit('trams-update', getCache());
});

async function startServer() {
  await importGtfs();
  startWorker();

  // NOUVEAU : Au lieu que le client demande, c'est le SERVEUR qui pousse les données !
  setInterval(() => {
    const data = getCache();
    if (data && data.length > 0) {
      io.emit('trams-update', data); // Envoie à tous les clients connectés
    }
  }, 30000);

  // IMPORTANT : On utilise server.listen au lieu de app.listen
  server.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
  });
}

startServer();