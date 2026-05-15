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
                    <div style="text-align:center; min-width: 160px; font-family: sans-serif;">
                        <b style="font-size: 14px;">🚲 ${name}</b><hr style="margin:8px 0; border: 0; border-top: 1px solid #ccc;">
                        <div style="display:flex; justify-content: space-around; margin-top: 10px;">
                            <div style="text-align: center;">
                                <b style="font-size: 20px; color: #4CAF50;">${availableBikes}</b><br>
                                <span style="font-size: 12px; color: #666;">Vélos dispo</span>
                            </div>
                            <div style="text-align: center; border-left: 1px solid #eee; padding-left: 15px;">
                                <b style="font-size: 20px; color: #FF9800;">${freeSlots}</b><br>
                                <span style="font-size: 12px; color: #666;">Places libres</span>
                            </div>
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