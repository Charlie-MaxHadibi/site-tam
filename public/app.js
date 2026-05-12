const myRenderer = L.canvas({ padding: 1 });
        const SERVER_URL = 'https://infotram.tmaxmls.ovh';
        const OPEN_DATA_URL = 'https://portail-api-data.montpellier3m.fr';

        const map = L.map('map', {
            zoomControl: false,      
            renderer: myRenderer
        }).setView([43.6107, 3.8767], 13);
        map.attributionControl.setPrefix(false);

        const lightTheme = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap' });
        const darkTheme = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap' });
        const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");

        function applyTheme(isDark) {
            if (isDark) {
                if (map.hasLayer(lightTheme)) map.removeLayer(lightTheme);
                darkTheme.addTo(map);
            } else {
                if (map.hasLayer(darkTheme)) map.removeLayer(darkTheme);
                lightTheme.addTo(map);
            }
        }
        applyTheme(prefersDarkScheme.matches);
        prefersDarkScheme.addEventListener("change", (e) => applyTheme(e.matches));

        let currentMode = 'trams';
        
        // --- CALQUES ---
        const tramLinesLayer = L.layerGroup().addTo(map);
        const tramStopsLayer = L.layerGroup().addTo(map);
        const tramMarkersLayer = L.layerGroup().addTo(map);
        const velosLayer = L.layerGroup(); 
        const parkingsLayer = L.layerGroup();
        const stationnementLayer = L.layerGroup(); 
        const userLocationLayer = L.layerGroup().addTo(map); 
        let userCoords = null;
        function toggleMenu() {
            const menu = document.getElementById('side-menu');
            const overlay = document.getElementById('menu-overlay');
            
            if (menu.classList.contains('open')) {
                menu.classList.remove('open');
                overlay.style.display = 'none';
            } else {
                menu.classList.add('open');
                overlay.style.display = 'block';
            }
        }

        function setMode(mode, btnElement) {
            currentMode = mode;
            
            document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
            btnElement.classList.add('active');

            const searchBox = document.getElementById('search-box');

            // 1. On nettoie tout
            map.removeLayer(tramLinesLayer);
            map.removeLayer(tramStopsLayer);
            map.removeLayer(tramMarkersLayer);
            map.removeLayer(velosLayer);
            map.removeLayer(parkingsLayer);
            map.removeLayer(stationnementLayer);

            // 2. On affiche le bon contenu
            if (mode === 'trams') {
                searchBox.style.display = 'block';
                map.addLayer(tramLinesLayer);
                map.addLayer(tramStopsLayer);
                map.addLayer(tramMarkersLayer);
            } 
            else if (mode === 'velos') {
                searchBox.style.display = 'none'; 
                map.addLayer(velosLayer);
                if (Object.keys(velosLayer._layers).length === 0) fetchVelos();
            }
            else if (mode === 'parkings') {
                searchBox.style.display = 'none';
                map.addLayer(parkingsLayer);
                // Chargement à la volée la première fois
                if (Object.keys(parkingsLayer._layers).length === 0) fetchParkings();
            }
            else if (mode === 'stationnement') {
                searchBox.style.display = 'none';
                map.addLayer(stationnementLayer);
                
                // On vide le calque pour forcer un recalcul GPS à chaque fois qu'on clique sur le bouton
                stationnementLayer.clearLayers(); 
                fetchStationnement();
            }

            renderTrams(); 

            // 3. Fermer le menu après la sélection (garanti à 100%)
            const sideMenu = document.getElementById('side-menu');
            if (sideMenu.classList.contains('open')) {
                toggleMenu();
            }
        }

        let markers = {};
        let stationMarkers = {}; 
        let tramLinesGeometry = { '1': [], '2': [], '3': [], '4': [] };
        let lastVehiclesData = []; 

        const socket = io(SERVER_URL);
        socket.on('trams-update', (data) => {
            lastVehiclesData = data || []; 
            if (currentMode === 'trams') renderTrams(); 
        });

        // --- API PARKINGS (NOUVEAU) ---
        async function fetchParkings() {
            try {
                const response = await fetch(`${OPEN_DATA_URL}/offstreetparking?limit=1000`);
                const parkings = await response.json();
                
                parkings.forEach(parking => {
                    // Structure Fiware expliquée dans ta doc Swagger
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
                            fillColor: '#007BFF', // Bleu pour les parkings
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
            } catch (error) {
                console.error("Erreur lors de la récupération des Parkings:", error);
            }
        }

        // --- API VÉLOMAGG ---
        async function fetchVelos() {
            try {
                const response = await fetch(`${OPEN_DATA_URL}/bikestation?limit=1000`);
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
            } catch (error) { console.error("Erreur Vélos:", error); }
        }

        // --- API TRAMS ---
        async function fetchShapes() {
            try {
                const response = await fetch(SERVER_URL + '/api/shapes');
                const geojson = await response.json();
                L.geoJSON(geojson, {
                    style: function(feature) {
                        let couleur = '#888'; 
                        const vals = Object.values(feature.properties).map(v => String(v).trim().toLowerCase());
                        let num = null;
                        if (vals.includes('1') || vals.includes('ligne 1')) { couleur = '#0055A4'; num = '1'; }
                        if (vals.includes('2') || vals.includes('ligne 2')) { couleur = '#EE7F00'; num = '2'; }
                        if (vals.includes('3') || vals.includes('ligne 3')) { couleur = '#A8A900'; num = '3'; }
                        if (vals.includes('4') || vals.includes('ligne 4')) { couleur = '#8F6E3B'; num = '4'; }
                        if (num && feature.geometry.type === 'LineString') tramLinesGeometry[num].push(feature);
                        return { color: couleur, weight: 5, opacity: 0.6 };
                    }
                }).addTo(tramLinesLayer);
            } catch (e) { console.error("Erreur shapes:", e); }
        }

        function filterSearch() {
            const query = document.getElementById('search-input').value.toLowerCase();
            const list = document.getElementById('search-results');
            list.innerHTML = '';
            
            if (query.length < 2) { list.style.display = 'none'; return; }

            const names = Object.keys(stationMarkers).filter(n => n.toLowerCase().includes(query));
            
            if (names.length > 0) {
                list.style.display = 'block';
                names.slice(0, 5).forEach(name => {
                    const li = document.createElement('li');
                    li.textContent = name;
                    li.onclick = () => {
                        const marker = stationMarkers[name];
                        map.flyTo(marker.getLatLng(), 16); 
                        marker.fire('click'); 
                        list.style.display = 'none';
                        document.getElementById('search-input').value = name;
                    };
                    list.appendChild(li);
                });
            } else { list.style.display = 'none'; }
        }

        async function fetchStops() {
            try {
                const response = await fetch(SERVER_URL + '/api/stops');
                const stations = await response.json();
                stations.forEach(station => {
                    const circle = L.circleMarker([station.lat, station.lon], {
                        radius: 5, fillColor: '#ffffff', color: '#000000', weight: 2, opacity: 1, fillOpacity: 1
                    });
                    stationMarkers[station.name] = circle;

                    circle.on('click', async () => {
                        circle.bindPopup(`<div style="text-align:center;"><b>${station.name}</b><br>⏳ Calcul...</div>`).openPopup();
                        try {
                            let arrivals = [];
                            for (let id of station.ids) {
                                const res = await fetch(`${SERVER_URL}/api/times/${id}`);
                                const times = await res.json();
                                arrivals = arrivals.concat(times);
                            }
                            arrivals.sort((a, b) => a.minutes - b.minutes);
                            let html = `<div style="min-width: 200px;"><b>📍 ${station.name}</b><hr style="margin:8px 0;">`;
                            if (arrivals.length === 0) {
                                html += `<i>Aucun tram prévu prochainement</i>`;
                            } else {
                                arrivals.slice(0, 4).forEach((t) => {
                                    let line = String(t.routeId).replace(/^0+/, ''); 
                                    let time = t.minutes === 0 ? "<b style='color:green;'>À l'approche</b>" : `<b>${t.minutes} min</b>`;
                                    html += `<div style="margin-bottom:6px; font-size:13px;"><span style="display:inline-block; width:18px; text-align:center; background:#ddd; border-radius:3px; margin-right:4px;"><b>${line}</b></span> vers ${t.headsign}<br><span style="margin-left: 26px;">⏱️ ${time}</span></div>`;
                                });
                            }
                            html += `</div>`;
                            circle.setPopupContent(html);
                        } catch (e) { circle.setPopupContent(`❌ Info indisponible`); }
                    });
                    circle.addTo(tramStopsLayer);
                });
            } catch (e) { console.error("Erreur stops:", e); }
        }

        function renderTrams() {
            try {
                const visible = (currentMode === 'trams') 
                    ? lastVehiclesData.filter(v => v.route_type === 0 || ['1', '2', '3', '4', '01', '02', '03', '04'].includes(String(v.route_short_name))) 
                    : [];

                const ids = visible.map(t => t.id);
                
                Object.keys(markers).forEach(id => { 
                    if (!ids.includes(id)) { 
                        tramMarkersLayer.removeLayer(markers[id]); 
                        delete markers[id]; 
                    } 
                });

                visible.forEach(vehicle => {
                    const { id, latitude, longitude, old_latitude, old_longitude, route_short_name, trip_headsign, route_color } = vehicle;
                    
                    const newLatLng = [latitude, longitude];
                    const oldLatLngObj = L.latLng(old_latitude || latitude, old_longitude || longitude); 
                    const newLatLngObj = L.latLng(latitude, longitude);

                    const icon = L.divIcon({
                        className: 'custom-div-icon',
                        html: `<div class="tram-icon" style="background-color: ${route_color}; width: 30px; height: 30px;">${route_short_name}</div>`,
                        iconSize: [30, 30], iconAnchor: [15, 15]
                    });

                    let path = [[oldLatLngObj.lat, oldLatLngObj.lng], newLatLng];
                    
                    if (oldLatLngObj.distanceTo(newLatLngObj) > 3) {
                        try {
                            const lines = tramLinesGeometry[route_short_name];
                            if (lines && lines.length > 0) {
                                let best = lines[0]; let dMin = Infinity;
                                lines.forEach(l => { const s = turf.nearestPointOnLine(l, turf.point([oldLatLngObj.lng, oldLatLngObj.lat])); if(s.properties.dist < dMin) { dMin = s.properties.dist; best = l; } });
                                const sS = turf.nearestPointOnLine(best, turf.point([oldLatLngObj.lng, oldLatLngObj.lat]));
                                const sE = turf.nearestPointOnLine(best, turf.point([longitude, latitude]));
                                const sliced = turf.lineSlice(sS, sE, best);
                                let coords = sliced.geometry.coordinates.map(c => [c[1], c[0]]);
                                if (oldLatLngObj.distanceTo(L.latLng(coords[coords.length-1])) < oldLatLngObj.distanceTo(L.latLng(coords[0]))) coords.reverse();
                                path = coords;
                            }
                        } catch (e) {}
                    } else {
                        path = [newLatLng, newLatLng];
                    }

                    if (markers[id]) {
                        tramMarkersLayer.removeLayer(markers[id]);
                    } 
                    
                    markers[id] = L.Marker.movingMarker(path, [28000], { autostart: true, icon: icon })
                        .bindPopup(`<b>Ligne ${route_short_name}</b><br>Destination: ${trip_headsign}`);
                        
                    tramMarkersLayer.addLayer(markers[id]);
                });    
            } catch (e) { console.error("Erreur d'affichage des trams:", e); }
        }

        fetchShapes().then(() => {
            fetchStops();
        });

        function reportBug() {
            const ua = navigator.userAgent;          
            let os = "Web/Inconnu";
            if (/android/i.test(ua)) os = "Android";
            else if (/iPad|iPhone|iPod/.test(ua)) os = "iOS";
            else if (/windows/i.test(ua)) os = "Windows (PC)";
            else if (/macintosh|mac os x/i.test(ua)) os = "Mac (Apple)";

            const emailBody = `Bonjour,\n\nJe souhaite signaler le bug suivant :\n\n[DÉCRIS LE PROBLÈME ICI]\n\n\n--- INFOS TECHNIQUES (Ne pas modifier) ---\nSystème détecté : ${os}\nDétails de l'appareil : ${ua}`;

            const tonEmail = "bloowest@gmail.com";
            const sujet = "Rapport de Bug - InfoTram";
            window.location.href = `mailto:${tonEmail}?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(emailBody)}`;
        }

        // --- NOUVEAU : SUIVI GPS EN DIRECT ---
        function initUserLocation() {
            if ("geolocation" in navigator) {
                // watchPosition s'actualise automatiquement quand le téléphone bouge
                navigator.geolocation.watchPosition((position) => {
                    userCoords = {
                        lat: position.coords.latitude,
                        lon: position.coords.longitude
                    };

                    // On efface l'ancienne position
                    userLocationLayer.clearLayers();

                    // On dessine le nouveau point (en bleu pour faire "GPS classique")
                    L.circleMarker([userCoords.lat, userCoords.lon], {
                        radius: 8, 
                        fillColor: '#2196F3', 
                        color: '#ffffff', 
                        weight: 2, 
                        fillOpacity: 1
                    }).addTo(userLocationLayer).bindPopup("📍 Vous êtes ici");

                }, (error) => {
                    console.warn("GPS indisponible :", error);
                }, {
                    enableHighAccuracy: true // Demande au téléphone d'être très précis
                });
            }
        }

        // --- API STATIONNEMENT SUR RUE (ZONES & HORODATEURS) ---
        async function fetchStationnement() {
            try {
                // 1. Afficher les zones de stationnement
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
                        layer.bindPopup(`<b>Stationnement sur voirie</b><br>📍 Zone ${zoneName}`);
                    }
                }).addTo(stationnementLayer);

                // 2. Trouver les 3 horodateurs les plus proches (seulement si le GPS a trouvé l'utilisateur)
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
                            <div style="text-align:center;">
                                <b>⏱️ Horodateur le plus proche #${index + 1}</b><br>
                                À environ <b>${Math.round(item.distance)} mètres</b> de vous.<br>
                                <small>${item.feature.properties.secteur || ''}</small>
                            </div>
                        `);
                        horoMarker.addTo(stationnementLayer);
                    });

                    // Centre la carte sur l'utilisateur quand il clique sur Stationnement
                    map.flyTo([userCoords.lat, userCoords.lon], 16);
                } else {
                    console.log("En attente de la position GPS pour afficher les horodateurs...");
                }

            } catch (error) {
                console.error("Erreur lors du chargement du stationnement :", error);
            }
        }
        initUserLocation();