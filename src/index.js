import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as gtfs from 'gtfs';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';

import importGtfs, { scheduleGtfsReimport } from './gtfsImport.js';
import { startWorker, getCache, getTripUpdates, clearStaticCache } from './realtimeWorker.js';
import { snapPastSegment } from './tramPath.js';
import { detectLine, LINE_COLORS } from './lines.js';
import { BoundedMap } from './boundedMap.js';
import { rateLimit } from './rateLimit.js';

// Délai max pour les appels sortants (open data Montpellier) -> pas de requête qui pend.
const FETCH_TIMEOUT_MS = 8000;
const SHAPES_URL = 'https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json';
// Open data temps réel Montpellier (Vélomagg + parkings) — API FIWARE, sans clé, CORS ouvert.
// NB : le domaine a changé, c'est bien .montpellier.fr (et non .montpellier3m.fr).
const MTP_API = 'https://portail-api-data.montpellier.fr';

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
    // Origine non whitelistée : on refuse les en-têtes CORS mais SANS lever d'erreur
    // (sinon Express répond 500, y compris pour un simple <script type="module"> servi
    // en local depuis http://localhost:3000).
    callback(null, false);
  }
};

const app = express();
// Derrière le reverse proxy de prod (OVH) : req.ip reflète l'IP client réelle (X-Forwarded-For).
app.set('trust proxy', 1);
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ["GET", "POST"] }});
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

let tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [], '5': [] };
let shapesGeoJson = null;        // GeoJSON des tracés (tagué ligne/couleur), servi par /api/shapes
let stopsCache = null;           // Arrêts regroupés par nom, mémorisés au démarrage (voir /api/stops)
let lastEnrichedData = [];

// Cache tripId -> destination (évite de réinterroger SQLite à chaque clic sur un arrêt).
// Borné : les trip_id tournent chaque jour, inutile de les garder à vie.
const headsignCache = new BoundedMap(5000);
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
    const response = await fetch(SHAPES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error('Erreur réseau');
    const geojson = await response.json();

    tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [], '5': [] };
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

// Regroupe les arrêts de tram par nom. Coûteux (N+1 sur SQLite) -> exécuté une fois
// au démarrage puis après chaque réimport GTFS, jamais par requête HTTP.
async function loadStopsInServerMemory() {
  try {
    const routes = await gtfs.getRoutes({ route_type: 0 });
    const grouped = {};
    for (const route of routes) {
      const stops = await gtfs.getStops({ route_id: route.route_id });
      for (const stop of stops) {
        if (!grouped[stop.stop_name]) {
          grouped[stop.stop_name] = { name: stop.stop_name, lat: stop.stop_lat, lon: stop.stop_lon, ids: [] };
        }
        if (!grouped[stop.stop_name].ids.includes(stop.stop_id)) {
          grouped[stop.stop_name].ids.push(stop.stop_id);
        }
      }
    }
    stopsCache = Object.values(grouped);
    console.log(`✅ ${stopsCache.length} arrêts de tram mémorisés.`);
  } catch (error) {
    console.error('❌ Erreur mémorisation des arrêts :', error.message);
  }
}

// --- ROUTES API ---
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', rateLimit({ windowMs: 60000, max: 120 }));

app.get('/api/trams', (req, res) => { res.json(getCache()); });

app.get('/api/shapes', async (req, res) => {
  // Servi depuis la mémoire (chargé au démarrage). Repli sur l'appel distant si indisponible.
  if (shapesGeoJson) return res.json(shapesGeoJson);
  try {
    const response = await fetch(SHAPES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: "Impossible" }); }
});

app.get('/api/stops', async (req, res) => {
  if (!stopsCache) await loadStopsInServerMemory();
  if (stopsCache) return res.json(stopsCache);
  res.status(503).json({ error: "Arrêts indisponibles" });
});

// --- Vélomagg + parkings : proxifiés (CORS tiers capricieux, app native) + cache court ---
const extCache = { velos: { at: 0, data: null }, parkings: { at: 0, data: null } };
const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(r => {
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
});

const coordsOf = (e) => e.location?.value?.coordinates; // [lon, lat]

async function getVelos() {
  if (extCache.velos.data && Date.now() - extCache.velos.at < 30000) return extCache.velos.data;
  const raw = await getJson(`${MTP_API}/bikestation?limit=1000`);
  extCache.velos.data = (Array.isArray(raw) ? raw : [])
    .filter(coordsOf)
    .map(s => {
      const [lon, lat] = coordsOf(s);
      return {
        name: s.address?.value?.streetAddress || 'Station Vélomagg',
        lat, lon,
        bikes: s.availableBikeNumber?.value ?? 0,
        docks: s.freeSlotNumber?.value ?? 0,
        offline: String(s.status?.value || '').toLowerCase() !== 'working',
      };
    });
  extCache.velos.at = Date.now();
  return extCache.velos.data;
}

async function getParkings() {
  if (extCache.parkings.data && Date.now() - extCache.parkings.at < 45000) return extCache.parkings.data;
  const raw = await getJson(`${MTP_API}/offstreetparking?limit=1000`);
  extCache.parkings.data = (Array.isArray(raw) ? raw : [])
    .filter(coordsOf)
    .map(p => {
      const [lon, lat] = coordsOf(p);
      return {
        name: p.name?.value || 'Parking',
        lat, lon,
        available: p.availableSpotNumber?.value ?? null,
        total: p.totalSpotNumber?.value ?? null,
        closed: String(p.status?.value || 'Open').toLowerCase() !== 'open',
        updated: p.availableSpotNumber?.metadata?.timestamp?.value || null,
      };
    });
  extCache.parkings.at = Date.now();
  return extCache.parkings.data;
}

app.get('/api/velos', async (req, res) => {
  try { res.json(await getVelos()); }
  catch (e) { console.error('[velos]', e.message); res.status(502).json({ error: 'Vélomagg indisponible' }); }
});
app.get('/api/parkings', async (req, res) => {
  try { res.json(await getParkings()); }
  catch (e) { console.error('[parkings]', e.message); res.status(502).json({ error: 'Parkings indisponibles' }); }
});

app.get('/api/times/:stopId', async (req, res) => {
  try {
    const stopId = req.params.stopId;
    // Lecture depuis le cache RAM du worker (plus aucun téléchargement du .pb par requête).
    const raw = getTripUpdates().get(stopId) || [];
    const nowInSeconds = Math.floor(Date.now() / 1000);

    // Déduplication par tripId : le même passage peut figurer plusieurs fois dans le flux
    // (ré-émissions successives). On garde l'occurrence la plus proche.
    const soonestByTrip = new Map();
    for (const u of raw) {
      const secondsToWait = u.time - nowInSeconds;
      if (secondsToWait < -60 || secondsToWait > 90 * 60) continue; // -1 min de tolérance, +90 min max
      const key = u.tripId || `${u.routeId}@${u.time}`;
      const prev = soonestByTrip.get(key);
      if (!prev || u.time < prev.time) soonestByTrip.set(key, u);
    }

    const arrivals = [...soonestByTrip.values()]
      .map(u => ({
        routeId: u.routeId,
        tripId: u.tripId,
        epoch: u.time,                                       // le client fait son propre décompte
        minutes: Math.max(0, Math.round((u.time - nowInSeconds) / 60)),
      }))
      .sort((a, b) => a.epoch - b.epoch);

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
  await loadStopsInServerMemory();

  // Réimport GTFS statique en tâche de fond (1×/jour). Après chaque réimport, les caches
  // indexés par trip_id sont vidés et la liste des arrêts est reconstruite.
  scheduleGtfsReimport(async () => {
    headsignCache.clear();
    clearStaticCache();
    await loadStopsInServerMemory();
  });

  // Une seule horloge : le worker récupère les positions toutes les 30 s et nous prévient.
  // On enrichit (extrapolation) et on diffuse immédiatement -> parfaitement synchronisé,
  // plus de dérive entre deux timers, calcul idempotent.
  startWorker((vehicles) => {
    if (!vehicles || vehicles.length === 0) return;
    const nowSec = Date.now() / 1000;
    lastEnrichedData = vehicles.map(vehicle => ({
      ...vehicle,
      // Âge du fix GPS au moment de la diffusion (le client peut l'affiner ensuite).
      fix_age_s: vehicle.timestamp ? Math.max(0, Math.round(nowSec - vehicle.timestamp)) : null,
      calculatedPath: snapPastSegment(vehicle, tramLinesGeometry)
    }));
    io.emit('trams-update', lastEnrichedData);
  });

  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

startServer();