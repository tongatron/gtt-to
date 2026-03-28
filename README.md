# GTT Radar

App mobile-first per controllare attese, fermate e mezzi GTT live sulla mappa.

## Demo

- demo pubblica: `https://gtt-to.onrender.com`

## Stack

- frontend: React + Vite + Leaflet
- backend: Express + GTFS statico + GTFS Realtime GTT
- PWA: installabile in locale/produzione, con cache base della shell

## Architettura

L'applicazione ha una sola interfaccia utente, ma e composta da due parti:

- frontend React: renderizza la UI e la mappa
- backend Express: raccoglie ed espone i dati tramite API `/api/*`

In sviluppo si usa un solo URL locale:

- app + API: `http://localhost:3210`

Il server Express monta anche Vite in development, cosi non sembra di avere due app separate.

## Avvio sviluppo

```bash
npm install
npm run dev
```

URL:

- app: `http://localhost:3210`
- backend API: `http://localhost:3210/api/*`
- healthcheck: `http://localhost:3210/api/health`

## Build locale completa

```bash
npm run build
npm start
```

La build completa gira su:

- app + backend: `http://localhost:3210/`

Questa e la modalita giusta per provare la PWA, perche il service worker viene registrato solo in produzione.

## Come usare l'app

1. Parti da localizzazione, numero fermata o indirizzo
2. Seleziona una fermata
3. Visualizza i prossimi passaggi della fermata
4. Scegli una linea per entrare nella vista attesa
5. Controlla mappa, mezzi live, direzioni attive e tempi di arrivo

## Deploy

- demo Render: `https://gtt-to.onrender.com`
- il progetto e ottimizzato per Render Free
- il backend usa cache GTFS alleggerite per ridurre memoria e timeout del health check

## Fonti dati

- Feed realtime GTT trip updates: <https://percorsieorari.gtt.to.it/das_gtfsrt/trip_update.aspx>
- Feed realtime GTT vehicle positions: <https://percorsieorari.gtt.to.it/das_gtfsrt/vehicle_position.aspx>
- GTFS statico GTT: <https://www.gtt.to.it/open_data/gtt_gtfs.zip>
- Geocoding: <https://nominatim.openstreetmap.org/>
