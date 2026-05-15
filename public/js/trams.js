// La fonction n'a plus besoin de tramLinesGeometry puisque le calcul Turf est fait côté serveur
export function setupTrams(map, markersLayer, getCurrentMode) {
    const socket = io();
    let markers = {};
    let lastVehiclesData = [];

    socket.on('trams-update', (data) => {
        lastVehiclesData = data || [];
        renderTrams();
        return renderTrams;
    });

    function renderTrams() {
        try {
            const visible = (getCurrentMode() === 'trams') 
                ? lastVehiclesData.filter(v => v.route_type === 0 || ['1', '2', '3', '4', '01', '02', '03', '04'].includes(String(v.route_short_name))) 
                : [];

            const ids = visible.map(t => t.id);
            
            // Nettoyage des vieux marqueurs
            Object.keys(markers).forEach(id => { 
                if (!ids.includes(id)) { 
                    markersLayer.removeLayer(markers[id]); 
                    delete markers[id]; 
                } 
            });

            visible.forEach(vehicle => {
                const { id, latitude, longitude, route_short_name, trip_headsign, route_color, calculatedPath } = vehicle;
                
                const newLatLngObj = L.latLng(latitude, longitude);
                let startLatLngObj;

                // 1. Position visuelle actuelle pour éviter la "téléportation"
                if (markers[id]) {
                    startLatLngObj = markers[id].getLatLng();
                    markersLayer.removeLayer(markers[id]); 
                } else {
                    // Si c'est un nouveau tram, on démarre au début de son chemin calculé
                    startLatLngObj = calculatedPath && calculatedPath.length > 0 
                        ? L.latLng(calculatedPath[0][0], calculatedPath[0][1])
                        : L.latLng(latitude, longitude);
                }

                const icon = L.divIcon({
                    className: 'custom-div-icon',
                    html: `<div class="tram-icon" style="background-color: ${route_color};">${route_short_name}</div>`,
                    iconSize: [30, 30], 
                    iconAnchor: [15, 15]
                });

                // 1. Nettoyage du chemin : On ignore les points trop proches (évite les bugs de direction Leaflet)
                let validPath = [startLatLngObj]; // On démarre toujours de la position visuelle
                
                if (calculatedPath && calculatedPath.length > 0) {
                    for (let i = 0; i < calculatedPath.length; i++) {
                        let nextPt = L.latLng(calculatedPath[i][0], calculatedPath[i][1]);
                        // On ajoute le point seulement s'il est à plus d'1 mètre du précédent
                        if (validPath[validPath.length - 1].distanceTo(nextPt) > 1) { 
                            validPath.push(nextPt);
                        }
                    }
                }

                // Si le chemin final n'a qu'un point (le tram n'a pas bougé), on ajoute sa destination
                if (validPath.length === 1) {
                    validPath.push(L.latLng(latitude, longitude));
                }

                // 2. Calcul de la distance totale réelle sur les rails
                let pathTotalDist = 0;
                for (let i = 0; i < validPath.length - 1; i++) {
                    pathTotalDist += validPath[i].distanceTo(validPath[i+1]);
                }

                // 3. Durée de l'animation
                const animationDuration = 28000; 
                let durations = [];

                if (pathTotalDist < 5) {
                    // Si le tram a bougé de moins de 5 mètres sur les rails, 
                    // on le fait glisser doucement sur 5 secondes plutôt que 28 pour éviter l'effet "limace"
                    durations = [5000];
                } else {
                    for (let i = 0; i < validPath.length - 1; i++) {
                        let segmentDist = validPath[i].distanceTo(validPath[i+1]);
                        durations.push((segmentDist / pathTotalDist) * animationDuration);
                    }
                }

                // 4. Création du marqueur avec sécurité sur le tableau des durées
                if (durations.length === validPath.length - 1) {
                    markers[id] = L.Marker.movingMarker(validPath, durations, { autostart: true, icon: icon })
                        .bindPopup(`<b>Ligne ${route_short_name}</b><br>Destination: ${trip_headsign}`);
                        
                    markersLayer.addLayer(markers[id]);
                }
            });
 
        } catch (e) { 
            console.error("Erreur d'affichage des trams:", e); 
        }
    }
}