import { escapeHtml } from './util.js';

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
                layer.bindPopup(`<div class="pop-card"><div class="pop-title"><svg class="ic" aria-hidden="true"><use href="#i-car"/></svg>Stationnement voirie</div><div class="pop-lbl" style="margin-top:6px">Zone ${escapeHtml(zoneName)}</div></div>`);
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
                    <div class="pop-card">
                        <div class="pop-title"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>Horodateur</div>
                        <div class="pop-lbl" style="margin-top:6px">à environ ${Math.round(item.distance)} m${item.feature.properties.secteur ? ' · ' + escapeHtml(item.feature.properties.secteur) : ''}</div>
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
