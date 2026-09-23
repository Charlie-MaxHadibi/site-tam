import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
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

// Copie locale du dernier tracé de lignes récupéré avec succès. Le tracé ne change presque
// jamais (hors travaux / nouvelle ligne) : si la source TAM est temporairement cassée, on
// repart de cette copie au lieu d'une carte sans tracé.
const SHAPES_CACHE_PATH = process.env.SHAPES_CACHE_PATH || path.join(__dirname, '../data/shapes-cache.json');

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
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
// GeoJSON des tracés (tagué ligne/couleur), servi par /api/shapes. Vide par défaut : si la
// source TAM est indisponible/corrompue ET qu'aucun cache local n'existe, l'appli reste
// utilisable (trams en ligne droite, pas de tracé coloré) plutôt que de planter.
let shapesGeoJson = EMPTY_FC;
// 'live' = tracé frais reçu de la TAM ; 'cache' = repli sur la dernière copie locale connue-bonne.
let shapesSource = null;
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

function readShapesCache() {
  try {
    return JSON.parse(fs.readFileSync(SHAPES_CACHE_PATH, 'utf8'));
  } catch {
    return null; // pas de cache, ou cache illisible -> tant pis, pas grave
  }
}

function writeShapesCache(geojson) {
  try {
    fs.mkdirSync(path.dirname(SHAPES_CACHE_PATH), { recursive: true });
    fs.writeFileSync(SHAPES_CACHE_PATH, JSON.stringify(geojson));
  } catch (error) {
    console.warn("⚠️ Impossible d'écrire le cache local des tracés :", error.message);
  }
}

// Tague chaque tracé (ligne/couleur) et reconstruit la géométrie par ligne servant au
// snapping (tramPath.js), puis mémorise le résultat pour /api/shapes.
function applyShapes(geojson) {
  const geometry = { '1': [], '2': [], '3': [], '4': [], '5': [] };
  geojson.features.forEach(feature => {
    const num = detectLine(feature.properties);
    feature.properties.line = num;
    feature.properties.color = num ? LINE_COLORS[num] : '#888';
    if (num && feature.geometry.type === 'LineString') {
      geometry[num].push(feature);
    }
  });
  tramLinesGeometry = geometry;
  shapesGeoJson = geojson;
}

async function fetchShapesFromTam() {
  const response = await fetch(SHAPES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadShapesInServerMemory() {
  // Le tracé ne change quasiment jamais : 2 essais rapprochés suffisent contre une réponse
  // tronquée passagère, sans avoir besoin de retenter en boucle immédiatement.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`🗺️ Chargement des tracés de tramways depuis la TAM… (essai ${attempt}/2)`);
      const geojson = await fetchShapesFromTam();
      applyShapes(geojson);
      writeShapesCache(geojson); // source TAM valide -> on rafraîchit la copie locale
      shapesSource = 'live';
      console.log("✅ Tracés mémorisés avec succès (source TAM) !");
      return;
    } catch (error) {
      console.error(`❌ Erreur mémorisation tracés (essai ${attempt}/2) :`, error.message);
      if (attempt === 1) await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Source TAM indisponible/corrompue sur les 2 essais : on repart de la dernière version
  // connue-bonne gardée sur disque plutôt que d'afficher une carte sans tracé.
  if (shapesSource !== 'live') {
    const cached = readShapesCache();
    if (cached) {
      applyShapes(cached);
      shapesSource = 'cache';
      console.log("↩️ Tracés restaurés depuis le cache local (data/shapes-cache.json).");
    } else {
      console.warn("⚠️ Aucun cache local de tracés disponible : carte sans tracé pour l'instant.");
    }
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

app.get('/api/shapes', (req, res) => {
  // Servi depuis la mémoire (chargé au démarrage, jamais null : cf. EMPTY_FC).
  res.json(shapesGeoJson);
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

    // On renvoie une fenêtre large (pas juste les 3 prochains) : le client regroupe par ligne
    // et par direction pour afficher tous les horaires de l'arrêt (utile pour prévoir un trajet).
    const windowed = arrivals.slice(0, 40);
    await Promise.all(windowed.map(async (a) => { a.headsign = await getHeadsign(a.tripId); }));
    res.json(windowed);
  } catch (error) { res.status(500).json({ error: "Erreur" }); }
});

// Horaires THÉORIQUES de toute la journée (GTFS statique, pas le temps réel) : utile pour
// prévoir un trajet bien à l'avance, au-delà de la fenêtre de 90 min de /api/times.
// Cache mémoire par (arrêt, date du jour) : la base ne change qu'au réimport GTFS quotidien.
const scheduleCache = new Map();
const todayServiceDate = () => {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

// Deux trajets d'une même ligne/sens peuvent avoir des intitulés différents pour 2 raisons
// bien distinctes :
//  - un simple raccourci/prolongement (ex. ligne 1 : "Occitanie" s'arrête 8 arrêts avant le
//    "Mosson" complet, mais suit exactement le même tracé) -> on peut les fusionner ;
//  - une VRAIE branche (ex. ligne 3 : "Lattes Centre" et "Pérols Étang de l'Or" partagent le
//    tronc commun jusqu'à Soriech puis divergent vers des arrêts totalement différents)
//    -> il ne faut surtout PAS les fusionner, ce sont deux destinations distinctes.
// On tranche en comparant les arrêts réels des trajets : un intitulé est fusionnable avec un
// autre seulement si la suite d'arrêts de l'un est un préfixe exact de l'autre.
function pathOfTrip(tripId) {
  return gtfs.getStoptimes({ trip_id: tripId }, [], [['stop_sequence', 'ASC']]).map((s) => s.stop_id);
}
function isPrefixCompatible(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length > 0 && shorter.every((id, i) => longer[i] === id);
}

// Pour un groupe route+direction ayant plusieurs intitulés, renvoie headsign -> clé de cluster
// (un intitulé représentatif du cluster). `repTripByHeadsign` : Map<headsign, trip_id le plus long>.
function computeMergeClusters(repTripByHeadsign) {
  const headsigns = [...repTripByHeadsign.keys()];
  const pathByHeadsign = new Map(headsigns.map((h) => [h, pathOfTrip(repTripByHeadsign.get(h))]));

  const parent = new Map(headsigns.map((h) => [h, h]));
  const find = (h) => { while (parent.get(h) !== h) h = parent.get(h); return h; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (let i = 0; i < headsigns.length; i++) {
    for (let j = i + 1; j < headsigns.length; j++) {
      if (isPrefixCompatible(pathByHeadsign.get(headsigns[i]), pathByHeadsign.get(headsigns[j]))) {
        union(headsigns[i], headsigns[j]);
      }
    }
  }
  return new Map(headsigns.map((h) => [h, find(h)]));
}

app.get('/api/schedule/:stopId', (req, res) => {
  try {
    const stopId = req.params.stopId;
    const date = todayServiceDate();
    const cacheKey = `${stopId}|${date}`;
    const cached = scheduleCache.get(cacheKey);
    if (cached) return res.json(cached);

    const stoptimes = gtfs.getStoptimes({ stop_id: stopId, date }, [], [['departure_time', 'ASC']]);
    const tripIds = [...new Set(stoptimes.map((s) => s.trip_id))];
    const tripById = new Map(gtfs.getTrips({ trip_id: tripIds }).map((t) => [t.trip_id, t]));

    // Quelques trajets candidats par (route, direction, intitulé) — beaucoup de trajets d'un
    // même intitulé sont en fait des courses partielles (ex. certains "Mosson" ne font que les
    // 4 derniers arrêts) : il faut comparer le tracé le plus LONG de chaque intitulé, sinon la
    // comparaison de préfixe est faussée par une course tronquée. On limite à 5 candidats par
    // intitulé pour ne pas interroger tous les trajets d'une grosse journée.
    const candidatesByRouteDir = new Map(); // "route|dir" -> Map<headsign, [trip_id, ...]>
    for (const trip of tripById.values()) {
      const key = `${trip.route_id}|${trip.direction_id ?? '?'}`;
      const headsign = trip.trip_headsign || 'Terminus';
      if (!candidatesByRouteDir.has(key)) candidatesByRouteDir.set(key, new Map());
      const bucket = candidatesByRouteDir.get(key);
      if (!bucket.has(headsign)) bucket.set(headsign, []);
      const list = bucket.get(headsign);
      if (list.length < 5) list.push(trip.trip_id);
    }
    const longestOf = (tripIdCandidates) => {
      let best = tripIdCandidates[0], bestLen = -1;
      for (const id of tripIdCandidates) {
        const n = gtfs.getStoptimes({ trip_id: id }).length;
        if (n > bestLen) { bestLen = n; best = id; }
      }
      return best;
    };

    // clé "route|direction|headsign" -> clé de cluster fusionné
    const mergeKeyOf = new Map();
    for (const [routeDirKey, headsignToCandidates] of candidatesByRouteDir) {
      if (headsignToCandidates.size <= 1) {
        for (const headsign of headsignToCandidates.keys()) mergeKeyOf.set(`${routeDirKey}|${headsign}`, `${routeDirKey}|${headsign}`);
        continue;
      }
      const headsignToTrip = new Map(
        [...headsignToCandidates].map(([headsign, candidates]) => [headsign, longestOf(candidates)])
      );
      const clusters = computeMergeClusters(headsignToTrip);
      for (const [headsign, clusterId] of clusters) {
        mergeKeyOf.set(`${routeDirKey}|${headsign}`, `${routeDirKey}|${clusterId}`);
      }
    }

    const schedule = stoptimes.map((s) => {
      const trip = tripById.get(s.trip_id);
      // GTFS autorise "25:14:00" pour 1h14 après minuit -> on normalise pour l'affichage
      // tout en gardant minutesOfDay (>= 1440 possible) pour trier/comparer avec "maintenant".
      const [h, m] = s.departure_time.split(':').map(Number);
      const routeId = trip?.route_id ?? '?';
      const directionId = trip?.direction_id ?? null;
      const headsign = trip?.trip_headsign || 'Terminus';
      const routeDirKey = `${routeId}|${directionId ?? '?'}`;
      return {
        routeId,
        tripId: s.trip_id,
        headsign,
        // Clé de regroupement pré-calculée côté serveur (raccourcis fusionnés, vraies
        // branches -comme Lattes Centre / Pérols Étang de l'Or sur la ligne 3- gardées à part).
        mergeKey: mergeKeyOf.get(`${routeDirKey}|${headsign}`) || `${routeDirKey}|${headsign}`,
        time: `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        minutesOfDay: h * 60 + m,
      };
    });

    scheduleCache.set(cacheKey, schedule);
    res.json(schedule);
  } catch (error) {
    console.error('[schedule]', error.message);
    res.status(500).json({ error: 'Horaires indisponibles' });
  }
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

  // Tant qu'on n'a pas reçu une version fraîche de la TAM (source encore vide ou repli sur
  // le cache local), on retente en tâche de fond -> dès que leur fichier redevient valide,
  // le tracé se répare tout seul, sans redémarrage.
  if (shapesSource !== 'live') {
    const shapesRetryTimer = setInterval(async () => {
      await loadShapesInServerMemory();
      if (shapesSource === 'live') clearInterval(shapesRetryTimer);
    }, 10 * 60 * 1000);
    shapesRetryTimer.unref();
  }

  // Réimport GTFS statique en tâche de fond (1×/jour). Après chaque réimport, les caches
  // indexés par trip_id sont vidés, la liste des arrêts reconstruite, et le tracé des lignes
  // rafraîchi (travaux, nouvelle ligne...) même si on tournait déjà sur une source "live".
  scheduleGtfsReimport(async () => {
    headsignCache.clear();
    clearStaticCache();
    scheduleCache.clear();
    await loadStopsInServerMemory();
    await loadShapesInServerMemory();
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