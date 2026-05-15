import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as gtfs from 'gtfs';

let vehicleCache = [];
let vehicleHistory = {}; 

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

        // Définition des couleurs de base
        if (tripId || routeId) {
          let idStr = tripId ? tripId.toLowerCase() : ''; 
          if (idStr.includes('ligne 1') || routeId == '1' || routeId == '01') { extraInfo.route_color = '#0055A4'; extraInfo.route_type = 0; }
          if (idStr.includes('ligne 2') || routeId == '2' || routeId == '02') { extraInfo.route_color = '#EE7F00'; extraInfo.route_type = 0; }
          if (idStr.includes('ligne 3') || routeId == '3' || routeId == '03') { extraInfo.route_color = '#A8A900'; extraInfo.route_type = 0; }
          if (idStr.includes('ligne 4') || routeId == '4' || routeId == '04') { extraInfo.route_color = '#8F6E3B'; extraInfo.route_type = 0; }
          if (idStr.includes('ligne 5') || routeId == '5' || routeId == '05') { extraInfo.route_color = 'rgb(155, 202, 255)'; extraInfo.route_type = 0; }
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
  } catch (error) {
    console.error('[Worker] Error updating real-time data:', error.message);
  }
}

function startWorker() {
  updateRealtimeData();
  setInterval(updateRealtimeData, process.env.UPDATE_INTERVAL_MS || 30000);
}

function getCache() {
  return vehicleCache;
}

export { startWorker, getCache };