import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as gtfs from 'gtfs';

let vehicleCache = [];
// NOUVEAU : Le carnet de bord du serveur pour retenir où étaient les trams
let vehicleHistory = {}; 

async function updateRealtimeData() {
  try {
    console.log('Updating real-time data...');
    const response = await axios.get(process.env.GTFS_REALTIME_URL, {
      responseType: 'arraybuffer',
    });

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(response.data)
    );

    const updatedVehicles = [];

    for (const entity of feed.entity) {
      if (entity.vehicle) {
        const { vehicle, trip } = entity.vehicle;
        const tripId = trip ? trip.tripId : null;
        const routeId = trip ? trip.routeId : null;

        let extraInfo = {
          route_short_name: routeId || '?',
          trip_headsign: 'Inconnue',
          route_color: '#808080',
          route_type: null
        };

        if (tripId || routeId) {
            let id = tripId ? tripId.toLowerCase() : ''; 
            
            if (id.includes('ligne 1') || routeId == '1' || routeId == '01') extraInfo.route_color = '#0055A4';
            if (id.includes('ligne 2') || routeId == '2' || routeId == '02') extraInfo.route_color = '#EE7F00';
            if (id.includes('ligne 3') || routeId == '3' || routeId == '03') extraInfo.route_color = '#A8A900';
            if (id.includes('ligne 4') || routeId == '4' || routeId == '04') extraInfo.route_color = '#8F6E3B';
            if (id.includes('ligne 5') || routeId == '5' || routeId == '05') extraInfo.route_color = 'rgb(155, 202, 255)';
        }    

        if (tripId) {
          const trips = await gtfs.getTrips({ trip_id: tripId });

          if (trips.length > 0) {
            extraInfo.trip_headsign = trips[0].trip_headsign;
            const routes = await gtfs.getRoutes({ route_id: trips[0].route_id });
            if (routes.length > 0) {
              extraInfo.route_short_name = routes[0].route_short_name;
              extraInfo.route_color = `#${routes[0].route_color || '808080'}`;
              extraInfo.route_type = routes[0].route_type;
            }
          }
        }

        // --- LA MAGIE OPÈRE ICI ---
        const vId = entity.id;
        const currentLat = entity.vehicle.position.latitude;
        const currentLon = entity.vehicle.position.longitude;

        let oldLat = currentLat;
        let oldLon = currentLon;

        // Si le serveur connaît déjà ce tram, on récupère son ancienne position
        if (vehicleHistory[vId]) {
            oldLat = vehicleHistory[vId].lat;
            oldLon = vehicleHistory[vId].lon;
        }

        // On sauvegarde la position actuelle pour le cycle suivant
        vehicleHistory[vId] = { lat: currentLat, lon: currentLon };

        updatedVehicles.push({
          id: vId,
          latitude: currentLat,
          longitude: currentLon,
          old_latitude: oldLat,   // On ajoute l'ancienne latitude au paquet cadeau
          old_longitude: oldLon,  // On ajoute l'ancienne longitude au paquet cadeau
          bearing: entity.vehicle.position.bearing,
          ...extraInfo
        });
      }
    }

    vehicleCache = updatedVehicles;
    console.log(`Updated cache with ${vehicleCache.length} vehicles.`);
  } catch (error) {
    console.error('Error updating real-time data:', error.message);
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