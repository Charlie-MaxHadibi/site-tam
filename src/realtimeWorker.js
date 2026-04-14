import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as gtfs from 'gtfs';

let vehicleCache = [];

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
        const routeId = trip ? trip.routeId : null; // <-- LA FAMEUSE LIGNE MANQUANTE !

        let extraInfo = {
          route_short_name: routeId || '?', // On affiche le routeId par défaut au lieu de 'Unknown'
          trip_headsign: 'Inconnue',
          route_color: '#808080',
          route_type: null
        };

        if (tripId || routeId) {
            // On sécurise pour éviter un autre crash si tripId est vide
            let id = tripId ? tripId.toLowerCase() : ''; 
            
            if (id.includes('ligne 1') || routeId == '1' || routeId == '01') extraInfo.route_color = '#0055A4';
            if (id.includes('ligne 2') || routeId == '2' || routeId == '02') extraInfo.route_color = '#EE7F00';
            if (id.includes('ligne 3') || routeId == '3' || routeId == '03') extraInfo.route_color = '#A8A900';
            if (id.includes('ligne 4') || routeId == '4' || routeId == '04') extraInfo.route_color = '#8F6E3B';
            if (id.includes('ligne 5') || routeId == '5' || routeId == '05') extraInfo.route_color = 'rgb(155, 202, 255)';
        }    
            // ... (la suite avec const trips = await gtfs.getTrips... reste identique)

        if (tripId) {
          // Query SQLite for static data
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

        updatedVehicles.push({
          id: entity.id,
          latitude: entity.vehicle.position.latitude,
          longitude: entity.vehicle.position.longitude,
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