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
                    <div class="popup-card">
                        <div class="popup-title">🅿️ ${name}</div>
                        <hr class="popup-sep">
                        <div class="popup-stats">
                            <div class="stat"><div class="stat-num c-parking">${dispo}</div><div class="stat-label">Places dispo</div></div>
                            <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total</div></div>
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