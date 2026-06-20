export async function fetchVelos(velosLayer) {
    console.log("🚲 Chargement des vélos (API Fiware) lancé...");
    const OPEN_DATA_URL = 'https://portail-api-data.montpellier3m.fr';
    
    try {
        const response = await fetch(`${OPEN_DATA_URL}/bikestation?limit=1000`);
        if (!response.ok) throw new Error("Erreur réseau: " + response.status);
        const stations = await response.json();
        
        stations.forEach(station => {
            const name = station.address?.value?.streetAddress || "Station Vélomagg";
            const availableBikes = station.availableBikeNumber?.value || 0;
            const freeSlots = station.freeSlotNumber?.value || 0;
            
            let lat = 0, lon = 0;
            if (station.location?.value?.coordinates) {
                const coords = station.location.value.coordinates;
                if (typeof coords[0] === 'string') {
                    const parts = coords[0].split(',');
                    lon = parseFloat(parts[0].trim());
                    lat = parseFloat(parts[1].trim());
                } else if (coords.length >= 2) {
                    lon = coords[0];
                    lat = coords[1];
                }
            }

            if (lat !== 0 && lon !== 0) {
                const marker = L.circleMarker([lat, lon], {
                    radius: 8, fillColor: '#4CAF50', color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.9
                });

                const popupHtml = `
                    <div class="popup-card">
                        <div class="popup-title">🚲 ${name}</div>
                        <hr class="popup-sep">
                        <div class="popup-stats">
                            <div class="stat"><div class="stat-num c-velo">${availableBikes}</div><div class="stat-label">Vélos dispo</div></div>
                            <div class="stat"><div class="stat-num c-warn">${freeSlots}</div><div class="stat-label">Places libres</div></div>
                        </div>
                    </div>
                `;
                marker.bindPopup(popupHtml);
                marker.addTo(velosLayer);
            }
        });
        console.log("✅ Vélos affichés avec succès !");
    } catch (error) { 
        console.error("❌ Erreur Vélos:", error); 
    }
}