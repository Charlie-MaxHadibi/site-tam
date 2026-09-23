# Montpellier Mobilité Tracker

Suivi en temps réel des trams de Montpellier (TAM), avec en bonus les stations Vélomagg, les parkings et le stationnement sur voirie. Site web + application Android (Capacitor).

Hébergé sur **https://infotram.tmaxmls.ovh**.

## Fonctionnement

- Le **backend** (Node.js / Express) importe le GTFS statique de la TAM dans une base SQLite, puis interroge en continu les flux temps réel GTFS-RT (`VehiclePosition.pb` et `TripUpdate.pb`).
- Un **worker** rafraîchit les positions toutes les 30 s. Le serveur reconstitue le tronçon de rail réellement parcouru par chaque tram (snapping via Turf.js) et diffuse le tout aux clients par **WebSocket** (Socket.io).
- Le **frontend** (Leaflet, JS vanilla) anime les trams le long des rails. Retard assumé d'environ 30 s (cadence des données TAM).

## Démarrage

```bash
npm install
cp .env.example .env      # ajuster si besoin
npm start                 # http://localhost:3000
```

Premier lancement : l'import GTFS prend un peu de temps. Les lancements suivants réutilisent la base locale tant qu'elle a moins de `GTFS_MAX_AGE_HOURS` (24 h par défaut). Pendant que le serveur tourne, le GTFS statique est réimporté automatiquement une fois par jour (`GTFS_REIMPORT_INTERVAL_MS`).

### Avec Docker

```bash
docker compose up --build
```

### Tests

```bash
npm test                  # node --test (tracé des trams, détection des lignes)
```

## Variables d'environnement

Voir [.env.example](.env.example).

| Variable | Rôle |
|----------|------|
| `PORT` | Port d'écoute (défaut 3000) |
| `GTFS_STATIC_URL` | Archive GTFS statique (.zip) |
| `GTFS_REALTIME_URL` | Flux positions véhicules (.pb) |
| `GTFS_TRIPUPDATE_URL` | Flux horaires temps réel (.pb) |
| `SQLITE_PATH` | Chemin de la base SQLite |
| `UPDATE_INTERVAL_MS` | Intervalle de rafraîchissement temps réel |
| `GTFS_MAX_AGE_HOURS` | Au-delà, réimport du GTFS statique au démarrage |
| `GTFS_REIMPORT_INTERVAL_MS` | Intervalle du réimport GTFS en tâche de fond (défaut 24 h) |
| `ALLOWED_ORIGINS` | Origines CORS autorisées (séparées par des virgules) |

## Structure

```
src/
    index.js            Serveur Express + WebSocket + routes API
    realtimeWorker.js   Récupération / cache des flux GTFS-RT
    tramPath.js         Snapping du trajet d'un tram sur les rails (testé)
    lines.js            Config des lignes (couleurs + détection, testé)
    gtfsImport.js       Import GTFS statique (cache de fraîcheur + réimport périodique)
    gtfsConfig.js       Config node-gtfs
    boundedMap.js       Map à capacité bornée (caches indexés par trip_id)
    rateLimit.js        Limiteur de débit en mémoire pour /api
public/
    index.html, style.css
    js/
        main.js           Carte, modes, recherche, géoloc
        trams.js          Rendu / animation des trams
        config.js         Base d'URL de l'API (web vs natif)
        util.js           escapeHtml (anti-XSS dans les popups)
        velos.js, parkings.js, stationnement.js
        vendor/MovingMarker.js
test/
    tramPath.test.js
    lines.test.js
```

## API

| Route | Description |
|-------|-------------|
| `GET /healthz` | Sonde de vivacité |
| `GET /api/trams` | Dernières positions véhicules (cache RAM) |
| `GET /api/shapes` | Tracés GeoJSON des lignes (tagués couleur, servis depuis la mémoire). Si la source TAM est indisponible/corrompue, repli automatique sur `data/shapes-cache.json` (dernière version valide reçue) ; retenté en tâche de fond jusqu'à récupérer une version fraîche. |
| `GET /api/stops` | Arrêts de tram regroupés par nom (mémorisés au démarrage) |
| `GET /api/times/:stopId` | Temps réel : horaires à un arrêt sur 90 min (`epoch` + minutes, jusqu'à 40 passages, cache RAM) |
| `GET /api/schedule/:stopId` | Horaires théoriques (GTFS statique) de toute la journée à un arrêt, tous passages, pour prévoir un trajet à l'avance. Regroupe les raccourcis/prolongements d'un même trajet (`mergeKey`, calculé par comparaison des arrêts réels), sans jamais fusionner deux vraies branches. Cache par (arrêt, jour). |
| `GET /api/velos` | Stations Vélomagg + disponibilité temps réel (proxy de l'API FIWARE `portail-api-data.montpellier.fr`, cache 30 s) |
| `GET /api/parkings` | Parkings en ouvrage : places libres / total en temps réel (même API, cache 45 s) |

Les routes `/api/*` sont limitées à 120 requêtes / minute / IP.

Données : [Montpellier Méditerranée Métropole – Open Data](https://data.montpellier3m.fr).
