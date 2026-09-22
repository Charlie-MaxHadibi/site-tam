import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as gtfs from 'gtfs';
import { LINE_COLORS } from './lines.js';
import { BoundedMap } from './boundedMap.js';

let vehicleCache = [];
let vehicleHistory = {};
let tripUpdatesByStop = new Map(); // stopId -> [{ routeId, tripId, time }] (cache des horaires temps réel)
let onUpdateCallback = null; // Appelé à chaque rafraîchissement du cache (sync émission temps réel)

// Dernier en-tête Last-Modified vu par flux -> requêtes conditionnelles (If-Modified-Since).
// Le fichier TAM n'est régénéré que toutes les ~30 s ; en interrogeant plus souvent (15 s)
// on récupère chaque nouvelle version plus vite, et les polls redondants renvoient un 304 vide.
const lastModified = { vehicles: null, tripUpdates: null };

// GET conditionnel : renvoie { notModified: true } si le serveur répond 304.
async function conditionalGet(url, feedKey) {
  const headers = {};
  if (lastModified[feedKey]) headers['If-Modified-Since'] = lastModified[feedKey];

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers,
    validateStatus: (s) => s === 200 || s === 304 || s === 429,
  });

  if (response.status === 304) return { notModified: true };
  if (response.status === 429) {
    console.warn(`[Worker] 429 sur ${feedKey} : on saute ce cycle.`);
    return { notModified: true };
  }
  if (response.headers['last-modified']) lastModified[feedKey] = response.headers['last-modified'];
  return { data: response.data };
}

// OPTIMISATION : Cache en RAM pour éviter de marteler SQLite (Requêtes N+1).
// Borné : les trip_id tournent chaque jour, sans limite le cache grossit sans fin.
const staticMetadataCache = new BoundedMap(5000);

// Vide le cache des métadonnées statiques (à appeler après un réimport GTFS :
// les trip_id d'hier ne sont plus valides).
function clearStaticCache() {
  staticMetadataCache.clear();
  console.log('[Worker] Cache métadonnées statiques vidé.');
}

// Les timestamps GTFS-RT arrivent parfois en Long (protobuf.js). On normalise en Number.
function longToNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v.low ?? v);
}

async function updateRealtimeData() {
  try {
    const res = await conditionalGet(process.env.GTFS_REALTIME_URL, 'vehicles');
    if (res.notModified) return; // rien de neuf, on garde le cache et on n'émet pas

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(res.data)
    );

    const updatedVehicles = [];
    const activeVehicleIds = new Set(); // Pour le nettoyage mémoire

    for (const entity of feed.entity) {
      if (entity.vehicle) {
        const { vehicle, trip } = entity.vehicle;
        const tripId = trip ? trip.tripId : null;
        const routeId = trip ? trip.routeId : null;
        const vId = entity.id;
        
        activeVehicleIds.add(vId);

        let extraInfo = {
          route_short_name: routeId || '?',
          trip_headsign: 'Inconnue',
          route_color: '#808080',
          route_type: null
        };

        // Définition des couleurs de base (depuis la config partagée des lignes)
        if (tripId || routeId) {
          const idStr = tripId ? tripId.toLowerCase() : '';
          for (const n of ['1', '2', '3', '4', '5']) {
            if (idStr.includes(`ligne ${n}`) || routeId == n || routeId == `0${n}`) {
              extraInfo.route_color = LINE_COLORS[n];
              extraInfo.route_type = 0;
              break;
            }
          }
        }

        // OPTIMISATION : Vérification du cache avant d'interroger SQLite
        if (tripId) {
          if (staticMetadataCache.has(tripId)) {
            const cached = staticMetadataCache.get(tripId);
            extraInfo.trip_headsign = cached.trip_headsign;
            extraInfo.route_short_name = cached.route_short_name;
            extraInfo.route_color = cached.route_color;
            extraInfo.route_type = cached.route_type;
          } else {
            const trips = await gtfs.getTrips({ trip_id: tripId });
            if (trips.length > 0) {
              extraInfo.trip_headsign = trips[0].trip_headsign;
              const routes = await gtfs.getRoutes({ route_id: trips[0].route_id });
              if (routes.length > 0) {
                extraInfo.route_short_name = routes[0].route_short_name;
                extraInfo.route_color = `#${routes[0].route_color || '808080'}`;
                extraInfo.route_type = routes[0].route_type;

                // Enregistrement dans le cache pour les prochains cycles
                staticMetadataCache.set(tripId, { ...extraInfo });
              }
            }
          }
        }

        const pos = entity.vehicle.position;
        const currentLat = pos.latitude;
        const currentLon = pos.longitude;
        // Heure réelle du fix GPS (secondes Unix). Le flux TAM ne rafraîchit une position
        // qu'environ toutes les 60 s, alors qu'on l'interroge toutes les 30 s.
        const fixTs = longToNumber(entity.vehicle.timestamp) || null;

        // `vehicleHistory` conserve le dernier fix DISTINCT (cur) et celui d'avant (old).
        // Sans ça, un cycle sur deux verrait old == current (tram figé) puis un saut.
        const prev = vehicleHistory[vId];
        let rec;
        if (!prev) {
          rec = { curLat: currentLat, curLon: currentLon, curTs: fixTs,
                  oldLat: currentLat, oldLon: currentLon, oldTs: fixTs };
        } else if (!fixTs || prev.curTs !== fixTs) {
          // Nouveau fix distinct : l'ancien "cur" devient "old".
          rec = { curLat: currentLat, curLon: currentLon, curTs: fixTs,
                  oldLat: prev.curLat, oldLon: prev.curLon, oldTs: prev.curTs };
        } else {
          // Même fix qu'au cycle précédent : on ne bouge rien.
          rec = prev;
        }
        vehicleHistory[vId] = rec;

        updatedVehicles.push({
          id: vId,
          latitude: rec.curLat,
          longitude: rec.curLon,
          old_latitude: rec.oldLat,
          old_longitude: rec.oldLon,
          timestamp: rec.curTs,          // heure du fix affiché
          old_timestamp: rec.oldTs,      // heure du fix précédent (=> durée réelle du tronçon)
          bearing: pos.bearing,
          speed: pos.speed ?? null,      // m/s (fourni par la TAM) — utile pour l'extrapolation
          current_status: entity.vehicle.currentStatus ?? null, // STOPPED_AT / IN_TRANSIT_TO
          ...extraInfo
        });
      }
    }

    // OPTIMISATION : Nettoyage des fuites de mémoire (Memory Leak)
    Object.keys(vehicleHistory).forEach(id => {
      if (!activeVehicleIds.has(id)) {
        delete vehicleHistory[id];
      }
    });

    vehicleCache = updatedVehicles;
    console.log(`[Worker] Updated cache with ${vehicleCache.length} vehicles.`);

    // Notifie le serveur dès que des données fraîches sont disponibles.
    if (onUpdateCallback) onUpdateCallback(vehicleCache);
  } catch (error) {
    console.error('[Worker] Error updating real-time data:', error.message);
  }
}

// Récupère et met en cache les horaires temps réel (TripUpdate.pb), indexés par arrêt.
// Évite de retélécharger l'intégralité du flux à chaque clic sur un arrêt.
async function updateTripUpdates() {
  try {
    const url = process.env.GTFS_TRIPUPDATE_URL || 'https://data.montpellier3m.fr/GTFS/Urbain/TripUpdate.pb';
    const res = await conditionalGet(url, 'tripUpdates');
    if (res.notModified) return; // horaires inchangés

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(res.data)
    );

    const byStop = new Map();
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.stopTimeUpdate) continue;
      const routeId = tu.trip ? tu.trip.routeId : null;
      const tripId = tu.trip ? tu.trip.tripId : null;

      for (const stu of tu.stopTimeUpdate) {
        if (!stu.stopId || !stu.arrival || !stu.arrival.time) continue;
        const time = longToNumber(stu.arrival.time); // secondes Unix (peut arriver en Long)
        if (!byStop.has(stu.stopId)) byStop.set(stu.stopId, []);
        byStop.get(stu.stopId).push({ routeId, tripId, time });
      }
    }

    tripUpdatesByStop = byStop;
    console.log(`[Worker] TripUpdates mis en cache pour ${byStop.size} arrêts.`);
  } catch (error) {
    console.error('[Worker] Error updating trip updates:', error.message);
  }
}

function startWorker(onUpdate) {
  onUpdateCallback = typeof onUpdate === 'function' ? onUpdate : null;

  // Deux cadences distinctes : les positions changent vite et le fichier est petit -> 15 s.
  // Les horaires (TripUpdate.pb) sont plus gros et le serveur TAM renvoie 429 si on l'interroge
  // aussi souvent -> 30 s, largement suffisant pour des prochains passages à la minute.
  const posInterval = Number(process.env.UPDATE_INTERVAL_MS) || 15000;
  const tuInterval = Number(process.env.TRIPUPDATE_INTERVAL_MS) || 30000;

  updateRealtimeData();
  updateTripUpdates();
  setInterval(updateRealtimeData, posInterval);
  setInterval(updateTripUpdates, tuInterval);
}

function getCache() {
  return vehicleCache;
}

function getTripUpdates() {
  return tripUpdatesByStop;
}

export { startWorker, getCache, getTripUpdates, clearStaticCache };