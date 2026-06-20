export async function fetchStationnement(stationnementLayer, userCoords, map) {
    try {
        // 1. Zones de stationnement
        const zonesResponse = await fetch('/data/TAM_MMM_ZoneStationnement.json'); 
        const zonesGeojson = await zonesResponse.json();

        L.geoJSON(zonesGeojson, {
            style: function(feature) {
                let nomZone = (feature.properties.zone || feature.properties.name || '').toLowerCase();
                let color = '#888'; 
                
                if (nomZone.includes('vert')) color = '#4CAF50';
                else if (nomZone.includes('orange')) color = '#FF9800';
                else if (nomZone.includes('jaune')) color = '#FFEB3B';
                else if (nomZone.includes('rouge')) color = '#F44336';

                return { color: color, weight: 2, fillOpacity: 0.3, opacity: 0.8 };
            },
            onEachFeature: function (feature, layer) {
                let zoneName = feature.properties.zone || feature.properties.name || 'Inconnue';
                layer.bindPopup(`<div class="popup-card"><div class="popup-title">🚘 Stationnement voirie</div><div class="popup-row"><span class="dest">Zone ${zoneName}</span></div></div>`);
            }
        }).addTo(stationnementLayer);

        // 2. Horodateurs proches
        if (userCoords) {
            const userPt = turf.point([userCoords.lon, userCoords.lat]);

            const horoResponse = await fetch('/data/TAM_MTP_Horodateurs.json');
            const horoGeojson = await horoResponse.json();

            let distances = horoGeojson.features.map(horo => {
                const dist = turf.distance(userPt, horo, { units: 'meters' });
                return { feature: horo, distance: dist };
            });

            distances.sort((a, b) => a.distance - b.distance);
            const top3 = distances.slice(0, 3);

            top3.forEach((item, index) => {
                const coords = item.feature.geometry.coordinates;
                const horoMarker = L.circleMarker([coords[1], coords[0]], {
                    radius: 7, fillColor: '#E91E63', color: '#ffffff', weight: 2, fillOpacity: 1
                });

                horoMarker.bindPopup(`
                    <div class="popup-card">
                        <div class="popup-title">⏱️ Horodateur #${index + 1}</div>
                        <div class="popup-row"><span class="dest">À environ</span><span class="arrival-time">${Math.round(item.distance)} m</span></div>
                        ${item.feature.properties.secteur ? `<div class="popup-empty">${item.feature.properties.secteur}</div>` : ''}
                    </div>
                `);
                horoMarker.addTo(stationnementLayer);
            });

            map.flyTo([userCoords.lat, userCoords.lon], 16);
        }
    } catch (error) {
        console.error("Erreur Stationnement:", error);
    }
}
