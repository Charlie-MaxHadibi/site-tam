export async function fetchParkings(parkingsLayer) {
    console.log("🅿️ Chargement des parkings (API Fiware) lancé...");
    const OPEN_DATA_URL = 'https://portail-api-data.montpellier3m.fr';

    try {
        const response = await fetch(`${OPEN_DATA_URL}/offstreetparking?limit=1000`);
        if (!response.ok) throw new Error("Erreur réseau: " + response.status);
        const parkings = await response.json();
        
        parkings.forEach(parking => {
            const name = parking.name?.value || "Parking";
            const dispo = parking.availableSpotNumber?.value || 0;
            const total = parking.totalSpotNumber?.value || "?";
            
            let lat = 0, lon = 0;
            
            if (parking.location?.value?.coordinates) {
                const coords = parking.location.value.coordinates;
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
                    radius: 8,
                    fillColor: '#007BFF',
                    color: '#ffffff',
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.9
                });

                const popupHtml = `
                    <div style="text-align:center; min-width: 160px; font-family: sans-serif;">
                        <b style="font-size: 14px;">🅿️ ${name}</b><hr style="margin:8px 0; border: 0; border-top: 1px solid #ccc;">
                        <div style="display:flex; justify-content: space-around; margin-top: 10px;">
                            <div style="text-align: center;">
                                <b style="font-size: 20px; color: #007BFF;">${dispo}</b><br>
                                <span style="font-size: 12px; color: #666;">Places dispo</span>
                            </div>
                            <div style="text-align: center; border-left: 1px solid #eee; padding-left: 15px;">
                                <b style="font-size: 20px; color: #333;">${total}</b><br>
                                <span style="font-size: 12px; color: #666;">Total</span>
                            </div>
                        </div>
                    </div>
                `;
                marker.bindPopup(popupHtml);
                marker.addTo(parkingsLayer);
            }
        });
        console.log("✅ Parkings affichés avec succès !");
    } catch (error) {
        console.error("❌ Erreur lors de la récupération des Parkings:", error);
    }
}