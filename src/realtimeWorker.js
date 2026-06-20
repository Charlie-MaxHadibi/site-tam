import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as gtfs from 'gtfs';
import { LINE_COLORS } from './lines.js';

let vehicleCache = [];
let vehicleHistory = {};
let tripUpdatesByStop = new Map(); // stopId -> [{ routeId, tripId, time }] (cache des horaires temps réel)
let onUpdateCallback = null; // Appelé à chaque rafraîchissement du cache (sync émission temps réel)

// OPTIMISATION : Cache en RAM pour éviter de marteler SQLite (Requêtes N+1)
const staticMetadataCache = new Map();

async function updateRealtimeData() {
  try {
    const response = await axios.get(process.env.GTFS_REALTIME_URL, {
      responseType: 'arraybuffer',
    });

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(response.data)
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

        const currentLat = entity.vehicle.position.latitude;
        const currentLon = entity.vehicle.position.longitude;

        let oldLat = currentLat;
        let oldLon = currentLon;

        if (vehicleHistory[vId]) {
            oldLat = vehicleHistory[vId].lat;
            oldLon = vehicleHistory[vId].lon;
        }

        vehicleHistory[vId] = { lat: currentLat, lon: currentLon };

        updatedVehicles.push({
          id: vId,
          latitude: currentLat,
          longitude: currentLon,
          old_latitude: oldLat,
          old_longitude: oldLon,
          bearing: entity.vehicle.position.bearing,
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
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(response.data)
    );

    const byStop = new Map();
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.stopTimeUpdate) continue;
      const routeId = tu.trip ? tu.trip.routeId : null;
      const tripId = tu.trip ? tu.trip.tripId : null;

      for (const stu of tu.stopTimeUpdate) {
        if (!stu.stopId || !stu.arrival || !stu.arrival.time) continue;
        // time peut être un Long (objet) -> on prend .low (secondes Unix)
        const time = typeof stu.arrival.time === 'object' ? stu.arrival.time.low : stu.arrival.time;
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
  const interval = Number(process.env.UPDATE_INTERVAL_MS) || 30000;

  updateRealtimeData();
  updateTripUpdates();
  setInterval(updateRealtimeData, interval);
  setInterval(updateTripUpdates, interval);
}

function getCache() {
  return vehicleCache;
}

function getTripUpdates() {
  return tripUpdatesByStop;
}

export { startWorker, getCache, getTripUpdates };