import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as gtfs from 'gtfs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import cors from 'cors';
import http from 'http'; 
import { Server } from 'socket.io'; 

// NOUVEAU : Le serveur importe le mathématicien Turf !
import * as turf from '@turf/turf';

import importGtfs from './gtfsImport.js';
import { startWorker, getCache } from './realtimeWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

const server = http.createServer(app); 

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

// ==========================================
// NOUVEAU : LA MÉMOIRE DU SERVEUR
// ==========================================
let tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [] };
let previousPositions = {}; // <-- LE CERVEAU SE SOUVIENT ENFIN !
let lastEnrichedData = [];  // <-- Stocke le dernier calcul pour les nouveaux venus

// Le serveur télécharge et apprend la carte des rails au démarrage
async function loadShapesInServerMemory() {
  try {
    console.log("🗺️ Chargement des tracés de tramways en mémoire...");
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    if (!response.ok) throw new Error('Erreur réseau');
    const geojson = await response.json();

    geojson.features.forEach(feature => {
      const vals = Object.values(feature.properties).map(v => String(v).trim().toLowerCase());
      let num = null;
      if (vals.includes('1') || vals.includes('ligne 1')) num = '1';
      if (vals.includes('2') || vals.includes('ligne 2')) num = '2';
      if (vals.includes('3') || vals.includes('ligne 3')) num = '3';
      if (vals.includes('4') || vals.includes('ligne 4')) num = '4';
      
      if (num && feature.geometry.type === 'LineString') {
        tramLinesGeometry[num].push(feature);
      }
    });
    console.log("✅ Tracés mémorisés avec succès !");
  } catch (error) {
    console.error("❌ Erreur mémorisation tracés:", error);
  }
}

// ==========================================
// LE MOTEUR DE CALCUL DE TRAJET CORRIGÉ
// ==========================================
function calculatePathWithTurf(vehicle) {
    const { id, latitude, longitude, route_short_name } = vehicle;

    // 1. On interroge la mémoire du serveur pour trouver l'ancienne position
    let old_lat = latitude;
    let old_lon = longitude;

    if (previousPositions[id]) {
        old_lat = previousPositions[id].lat;
        old_lon = previousPositions[id].lon;
    }

    const startPt = turf.point([old_lon, old_lat]);
    const endPt = turf.point([longitude, latitude]);

    const distanceMeters = turf.distance(startPt, endPt, { units: 'meters' });

    // S'il n'a pas bougé de plus de 5m, on ne calcule rien
    if (distanceMeters > 400 || distanceMeters < 5) {
        return [[latitude, longitude], [latitude, longitude]];
    }

    try {
        const lines = tramLinesGeometry[route_short_name];
        if (lines && lines.length > 0) {
            let best = lines[0];
            let dMin = Infinity;

            lines.forEach(l => {
                const s = turf.nearestPointOnLine(l, startPt);
                if(s.properties.dist < dMin) {
                    dMin = s.properties.dist;
                    best = l;
                }
            });

            const sS = turf.nearestPointOnLine(best, startPt);
            const sE = turf.nearestPointOnLine(best, endPt);
            const sliced = turf.lineSlice(sS, sE, best);
            
            let coords = sliced.geometry.coordinates.map(c => [c[1], c[0]]);
            
            const distToStart = turf.distance(startPt, turf.point([coords[0][1], coords[0][0]]));
            const distToEnd = turf.distance(startPt, turf.point([coords[coords.length-1][1], coords[coords.length-1][0]]));
            
            if (distToEnd < distToStart) {
                coords.reverse();
            }
            return coords; 
        }
    } catch (e) {}
    
    return [[old_lat, old_lon], [latitude, longitude]];
}


// --- ANCIENNES ROUTES API (Ne changent pas) ---
app.get('/api/trams', (req, res) => { res.json(getCache()); });

app.get('/api/shapes', async (req, res) => {
  try {
    const response = await fetch('https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json');
    const geojson = await response.json();
    res.json(geojson);
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
    const response = await fetch('https://data.montpellier3m.fr/GTFS/Urbain/TripUpdate.pb');
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
            if (minutesToWait >= 0 && minutesToWait <= 90) arrivals.push({ routeId: entity.tripUpdate.trip.routeId, tripId: entity.tripUpdate.trip.tripId, minutes: minutesToWait });
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
  } catch (error) { res.status(500).json({ error: "Erreur" }); }
});


// ==========================================
// WEBSOCKETS : ENVOI SÉCURISÉ
// ==========================================
io.on('connection', (socket) => {
  console.log('🔌 Un client est connecté !');
  // On envoie le dernier calcul mis en cache pour ne pas casser la mémoire
  if (lastEnrichedData.length > 0) {
      socket.emit('trams-update', lastEnrichedData);
  }
});

async function startServer() {
  await importGtfs();
  await loadShapesInServerMemory(); 
  startWorker();

  setInterval(() => {
    const rawData = getCache();
    if (rawData && rawData.length > 0) {
      
      lastEnrichedData = rawData.map(vehicle => {
          const path = calculatePathWithTurf(vehicle);
          
          // 2. On met à jour la mémoire du serveur APRES avoir calculé le chemin
          previousPositions[vehicle.id] = { lat: vehicle.latitude, lon: vehicle.longitude };

          return {
              ...vehicle,
              calculatedPath: path
          };
      });
      
      io.emit('trams-update', lastEnrichedData);
    }
  }, 30000);

  server.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
  });
}

startServer();