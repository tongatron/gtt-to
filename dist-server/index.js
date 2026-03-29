import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { unzipSync, strFromU8 } from 'fflate';
import { parse } from 'csv-parse/sync';
import protobuf from 'protobufjs';
const PORT = Number(process.env.PORT ?? 3210);
const TRIP_UPDATE_FEED_URL = 'https://percorsieorari.gtt.to.it/das_gtfsrt/trip_update.aspx';
const VEHICLE_POSITION_FEED_URL = 'https://percorsieorari.gtt.to.it/das_gtfsrt/vehicle_position.aspx';
const STATIC_GTFS_URL = 'https://www.gtt.to.it/open_data/gtt_gtfs.zip';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const REALTIME_CACHE_TTL_MS = 10_000;
const STATIC_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ARRIVALS_RESPONSE_CACHE_TTL_MS = 30_000;
const VEHICLES_RESPONSE_CACHE_TTL_MS = 30_000;
const LINE_PATHS_RESPONSE_CACHE_TTL_MS = 60 * 60 * 1000;
const UPCOMING_WINDOW_MS = 2 * 60 * 60 * 1000;
const PAST_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_NEARBY_RADIUS_METERS = 700;
const DEFAULT_NEARBY_LIMIT = 12;
const RELATED_STOP_RADIUS_METERS = 400;
const RELATED_STOP_LIMIT = 6;
const ROME_TIME_ZONE = 'Europe/Rome';
const TORINO_VIEWBOX = '7.52,45.16,7.83,44.97';
const TORINO_QUERY_SUFFIX = 'Torino, Piemonte, Italia';
const IS_RENDER_RUNTIME = Boolean(process.env.RENDER ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RENDER_SERVICE_ID);
const SUPPORTED_SURFACE_MODES = new Set([
    'bus',
    'trolleybus',
    'tram',
    'metro',
    'rail',
]);
const MODE_SORT_ORDER = {
    tram: 0,
    bus: 1,
    trolleybus: 2,
    metro: 3,
    rail: 4,
    other: 5,
};
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRootDir = path.resolve(serverDir, '..');
const staticDistDir = path.resolve(serverDir, '../dist');
const sourceIndexHtmlPath = path.join(projectRootDir, 'index.html');
const isDevelopment = process.env.NODE_ENV !== 'production';
const staticCache = {
    data: {
        routesById: new Map(),
        tripsById: new Map(),
        stopsById: new Map(),
        stopsByCode: new Map(),
        shapesById: new Map(),
        tripStopPointsByTripId: new Map(),
        stopSchedulesByStopId: new Map(),
        calendarsByServiceId: new Map(),
        calendarDateExceptionsByServiceId: new Map(),
    },
    expiresAt: 0,
    promise: null,
};
const staticArrivalsCache = {
    data: {
        routesById: new Map(),
        tripsById: new Map(),
        stopsById: new Map(),
        stopsByCode: new Map(),
        stopSchedulesByStopId: new Map(),
        calendarsByServiceId: new Map(),
        calendarDateExceptionsByServiceId: new Map(),
    },
    expiresAt: 0,
    promise: null,
};
const staticRoutesTripsCache = {
    data: {
        routesById: new Map(),
        tripsById: new Map(),
    },
    expiresAt: 0,
    promise: null,
};
const staticStopsIndexCache = {
    data: {
        stopsById: new Map(),
        stopsByCode: new Map(),
    },
    expiresAt: 0,
    promise: null,
};
const staticStopsLiteCache = {
    data: {
        stopsById: new Map(),
        stopsByCode: new Map(),
    },
    expiresAt: 0,
    promise: null,
};
const realtimeCache = {
    data: null,
    expiresAt: 0,
    promise: null,
};
const vehiclePositionCache = {
    data: null,
    expiresAt: 0,
    promise: null,
};
const arrivalsResponseCache = new Map();
const vehiclesResponseCache = new Map();
const linePathsResponseCache = new Map();
const geocodeCache = new Map();
let feedMessageTypePromise = null;
function normalizeColor(value) {
    if (!value || value.trim().length === 0) {
        return null;
    }
    return `#${value.trim().replace(/^#/, '')}`;
}
function toIsoString(value) {
    const numeric = typeof value === 'string' ? Number.parseInt(value, 10) : value ?? null;
    if (!numeric || Number.isNaN(numeric)) {
        return null;
    }
    return new Date(numeric * 1000).toISOString();
}
function getTimedCachedResponse(cache, key) {
    const cachedEntry = cache.get(key);
    if (!cachedEntry) {
        return null;
    }
    if (cachedEntry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return cachedEntry.value;
}
function setTimedCachedResponse(cache, key, value, ttlMs) {
    cache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
    });
}
function resolveRouteMode(routeTypeRaw) {
    switch (routeTypeRaw) {
        case '0':
            return { mode: 'tram', label: 'Tram' };
        case '1':
            return { mode: 'metro', label: 'Metro' };
        case '2':
            return { mode: 'rail', label: 'Treno' };
        case '3':
            return { mode: 'bus', label: 'Bus' };
        case '11':
            return { mode: 'trolleybus', label: 'Filobus' };
        default:
            return { mode: 'other', label: 'Servizio' };
    }
}
function compareLineCodes(left, right) {
    return left.localeCompare(right, 'it', {
        numeric: true,
        sensitivity: 'base',
    });
}
function buildStopServiceKey(lineCode, mode) {
    return `${mode}:${lineCode}`;
}
function compareStopServices(left, right) {
    const modeOrderDifference = MODE_SORT_ORDER[left.mode] - MODE_SORT_ORDER[right.mode];
    if (modeOrderDifference !== 0) {
        return modeOrderDifference;
    }
    return compareLineCodes(left.lineCode, right.lineCode);
}
function buildLineCatalog(staticData) {
    const linesByKey = new Map();
    for (const routeRecord of staticData.routesById.values()) {
        const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
        if (!SUPPORTED_SURFACE_MODES.has(mode)) {
            continue;
        }
        const lineCode = routeRecord.routeShortName.trim();
        if (!lineCode) {
            continue;
        }
        const catalogKey = buildStopServiceKey(lineCode, mode);
        if (linesByKey.has(catalogKey)) {
            continue;
        }
        linesByKey.set(catalogKey, {
            lineCode,
            mode,
            modeLabel: label,
            routeColor: routeRecord.routeColor,
            routeTextColor: routeRecord.routeTextColor,
        });
    }
    return Array.from(linesByKey.values()).sort((left, right) => {
        const modeOrderDifference = MODE_SORT_ORDER[left.mode] - MODE_SORT_ORDER[right.mode];
        if (modeOrderDifference !== 0) {
            return modeOrderDifference;
        }
        return compareLineCodes(left.lineCode, right.lineCode);
    });
}
function metersBetween(latitudeA, longitudeA, latitudeB, longitudeB) {
    const earthRadiusMeters = 6_371_000;
    const latitudeDelta = ((latitudeB - latitudeA) * Math.PI) / 180;
    const longitudeDelta = ((longitudeB - longitudeA) * Math.PI) / 180;
    const latitudeARadians = (latitudeA * Math.PI) / 180;
    const latitudeBRadians = (latitudeB * Math.PI) / 180;
    const haversine = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(latitudeARadians) *
            Math.cos(latitudeBRadians) *
            Math.sin(longitudeDelta / 2) ** 2;
    return Math.round(2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine)));
}
function parseGtfsDateTime(serviceDate, gtfsTime) {
    if (!serviceDate || !gtfsTime) {
        return null;
    }
    const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(serviceDate);
    const timeMatch = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(gtfsTime);
    if (!dateMatch || !timeMatch) {
        return null;
    }
    const year = Number.parseInt(dateMatch[1], 10);
    const monthIndex = Number.parseInt(dateMatch[2], 10) - 1;
    const day = Number.parseInt(dateMatch[3], 10);
    const rawHours = Number.parseInt(timeMatch[1], 10);
    const minutes = Number.parseInt(timeMatch[2], 10);
    const seconds = Number.parseInt(timeMatch[3], 10);
    const dayOffset = Math.floor(rawHours / 24);
    const hours = rawHours % 24;
    return new Date(year, monthIndex, day + dayOffset, hours, minutes, seconds).toISOString();
}
function formatLocalServiceDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
function getCandidateServiceDates(nowMs) {
    return [-1, 0, 1].map((offsetDays) => {
        const candidateDate = new Date(nowMs);
        candidateDate.setDate(candidateDate.getDate() + offsetDays);
        return formatLocalServiceDate(candidateDate);
    });
}
function getWeekdayIndexFromServiceDate(serviceDate) {
    const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(serviceDate);
    if (!dateMatch) {
        return null;
    }
    const year = Number.parseInt(dateMatch[1], 10);
    const monthIndex = Number.parseInt(dateMatch[2], 10) - 1;
    const day = Number.parseInt(dateMatch[3], 10);
    const jsDay = new Date(year, monthIndex, day).getDay();
    return jsDay === 0 ? 6 : jsDay - 1;
}
function isServiceActiveOnDate(serviceId, serviceDate, staticData) {
    const exceptions = staticData.calendarDateExceptionsByServiceId.get(serviceId);
    const exception = exceptions?.get(serviceDate);
    if (typeof exception === 'boolean') {
        return exception;
    }
    const calendarRecord = staticData.calendarsByServiceId.get(serviceId);
    if (!calendarRecord) {
        return false;
    }
    if (serviceDate < calendarRecord.startDate ||
        serviceDate > calendarRecord.endDate) {
        return false;
    }
    const weekdayIndex = getWeekdayIndexFromServiceDate(serviceDate);
    return weekdayIndex === null ? false : calendarRecord.weekdays[weekdayIndex] ?? false;
}
function normalizeAddressQuery(query) {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return '';
    }
    const lowerCaseQuery = trimmedQuery.toLowerCase();
    if (lowerCaseQuery.includes('torino') ||
        lowerCaseQuery.includes('turin') ||
        lowerCaseQuery.includes('piemonte')) {
        return trimmedQuery;
    }
    return `${trimmedQuery}, ${TORINO_QUERY_SUFFIX}`;
}
async function geocodeAddress(query) {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        throw new Error('address is required.');
    }
    const cacheKey = trimmedQuery.toLowerCase();
    const cachedEntry = geocodeCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
        return cachedEntry.result;
    }
    const requestUrl = new URL(NOMINATIM_SEARCH_URL);
    requestUrl.searchParams.set('q', normalizeAddressQuery(trimmedQuery));
    requestUrl.searchParams.set('format', 'jsonv2');
    requestUrl.searchParams.set('limit', '1');
    requestUrl.searchParams.set('countrycodes', 'it');
    requestUrl.searchParams.set('viewbox', TORINO_VIEWBOX);
    requestUrl.searchParams.set('bounded', '1');
    const response = await fetch(requestUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: {
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
            'User-Agent': 'gtt-torino-local/1.0 (Codex local app)',
        },
    });
    if (!response.ok) {
        throw new Error(`Geocoding request failed with ${response.status}`);
    }
    const results = (await response.json());
    const firstResult = results[0];
    if (!firstResult?.display_name || !firstResult.lat || !firstResult.lon) {
        throw new Error('Indirizzo non trovato nell’area di Torino.');
    }
    const latitude = Number.parseFloat(firstResult.lat);
    const longitude = Number.parseFloat(firstResult.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
        throw new Error('Coordinate indirizzo non valide.');
    }
    const result = {
        query: trimmedQuery,
        displayName: firstResult.display_name,
        latitude,
        longitude,
    };
    geocodeCache.set(cacheKey, {
        expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS,
        result,
    });
    return result;
}
function stopToApiRecord(stop, distanceMeters) {
    return {
        stopId: stop.stopId,
        stopCode: stop.stopCode,
        stopName: stop.stopName,
        stopDescription: stop.stopDescription,
        latitude: stop.latitude,
        longitude: stop.longitude,
        url: stop.url,
        wheelchairBoarding: stop.wheelchairBoarding,
        modes: Array.from(stop.modes).sort(),
        lines: Array.from(stop.lines).sort(compareLineCodes),
        services: Array.from(stop.services.values()).sort(compareStopServices),
        ...(typeof distanceMeters === 'number' ? { distanceMeters } : {}),
    };
}
function normalizePathPoints(points) {
    const normalized = [];
    for (const point of [...points].sort((left, right) => left.sequence - right.sequence)) {
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
            continue;
        }
        const lastPoint = normalized.at(-1);
        if (lastPoint &&
            lastPoint.latitude === point.latitude &&
            lastPoint.longitude === point.longitude) {
            continue;
        }
        normalized.push({
            latitude: point.latitude,
            longitude: point.longitude,
        });
    }
    return normalized;
}
function buildFallbackPathKey(routeId, directionId, headsign, points) {
    const firstPoint = points[0];
    const lastPoint = points.at(-1);
    return [
        routeId,
        directionId ?? 'na',
        headsign ?? 'na',
        points.length,
        firstPoint ? `${firstPoint.latitude.toFixed(5)}:${firstPoint.longitude.toFixed(5)}` : 'none',
        lastPoint ? `${lastPoint.latitude.toFixed(5)}:${lastPoint.longitude.toFixed(5)}` : 'none',
    ].join('|');
}
function getLinePathPointsForTrip(tripRecord, staticData) {
    if (tripRecord.shapeId) {
        const shapePoints = staticData.shapesById.get(tripRecord.shapeId);
        if (shapePoints && shapePoints.length >= 2) {
            return normalizePathPoints(shapePoints);
        }
    }
    const stopPoints = staticData.tripStopPointsByTripId?.get(tripRecord.tripId);
    if (stopPoints && stopPoints.length >= 2) {
        return normalizePathPoints(stopPoints);
    }
    return [];
}
function buildLinePaths(normalizedLine, staticData) {
    const pathsByKey = new Map();
    for (const tripRecord of staticData.tripsById.values()) {
        const routeRecord = staticData.routesById.get(tripRecord.routeId);
        if (!routeRecord) {
            continue;
        }
        const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
        if (!SUPPORTED_SURFACE_MODES.has(mode)) {
            continue;
        }
        if (routeRecord.routeShortName.toUpperCase() !== normalizedLine) {
            continue;
        }
        const points = getLinePathPointsForTrip(tripRecord, staticData);
        if (points.length < 2) {
            continue;
        }
        const pathKey = tripRecord.shapeId
            ? `shape:${tripRecord.shapeId}`
            : buildFallbackPathKey(routeRecord.routeId, tripRecord.directionId, tripRecord.headsign, points);
        const candidatePath = {
            pathId: pathKey,
            lineCode: routeRecord.routeShortName,
            headsign: tripRecord.headsign,
            directionId: tripRecord.directionId,
            mode,
            modeLabel: label,
            routeColor: routeRecord.routeColor,
            routeTextColor: routeRecord.routeTextColor,
            points,
        };
        const currentPath = pathsByKey.get(pathKey);
        if (!currentPath || candidatePath.points.length > currentPath.points.length) {
            pathsByKey.set(pathKey, candidatePath);
        }
    }
    return Array.from(pathsByKey.values())
        .sort((left, right) => {
        const directionDifference = (left.directionId ?? 9) - (right.directionId ?? 9);
        if (directionDifference !== 0) {
            return directionDifference;
        }
        const headsignComparison = (left.headsign ?? '').localeCompare(right.headsign ?? '', 'it');
        if (headsignComparison !== 0) {
            return headsignComparison;
        }
        return right.points.length - left.points.length;
    })
        .slice(0, 8);
}
function samplePathPoints(points, maxPoints = 32) {
    if (points.length <= maxPoints) {
        return points;
    }
    const sampled = [];
    const lastIndex = points.length - 1;
    for (let index = 0; index < maxPoints; index += 1) {
        const pointIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
        const point = points[pointIndex];
        if (!point) {
            continue;
        }
        const lastPoint = sampled.at(-1);
        if (lastPoint &&
            lastPoint.latitude === point.latitude &&
            lastPoint.longitude === point.longitude) {
            continue;
        }
        sampled.push(point);
    }
    return sampled;
}
async function getRenderLinePathsData(normalizedLine) {
    const metadata = await getStaticRoutesTripsData();
    const relevantTripIds = new Set();
    for (const tripRecord of metadata.tripsById.values()) {
        const routeRecord = metadata.routesById.get(tripRecord.routeId);
        if (!routeRecord) {
            continue;
        }
        const { mode } = resolveRouteMode(routeRecord.routeTypeRaw);
        if (!SUPPORTED_SURFACE_MODES.has(mode)) {
            continue;
        }
        if (routeRecord.routeShortName.toUpperCase() === normalizedLine) {
            relevantTripIds.add(tripRecord.tripId);
        }
    }
    if (relevantTripIds.size === 0) {
        return {
            fetchedAt: new Date().toISOString(),
            line: normalizedLine,
            paths: [],
        };
    }
    const archive = await fetchStaticGtfsArchive();
    const stopsText = archive['stops.txt'];
    const stopTimesText = archive['stop_times.txt'];
    if (!stopsText || !stopTimesText) {
        throw new Error('Static GTFS archive is missing files for render line paths.');
    }
    const stopsIndex = buildStopsIndex(parseCsvRows(stopsText));
    const tripStopPointsByTripId = new Map();
    await scanStopTimesFile(stopTimesText, metadata.tripsById, metadata.routesById, stopsIndex.stopsById, (schedule, stopId) => {
        if (!relevantTripIds.has(schedule.tripId)) {
            return;
        }
        const stopRecord = stopsIndex.stopsById.get(stopId);
        if (!stopRecord) {
            return;
        }
        const points = tripStopPointsByTripId.get(schedule.tripId) ?? [];
        points.push({
            sequence: schedule.stopSequence,
            latitude: stopRecord.latitude,
            longitude: stopRecord.longitude,
        });
        tripStopPointsByTripId.set(schedule.tripId, points);
    });
    const linePaths = buildLinePaths(normalizedLine, {
        routesById: metadata.routesById,
        tripsById: metadata.tripsById,
        shapesById: new Map(),
        tripStopPointsByTripId,
    }).map((path) => ({
        ...path,
        points: samplePathPoints(path.points),
    }));
    return {
        fetchedAt: new Date().toISOString(),
        line: normalizedLine,
        paths: linePaths,
    };
}
function getRelatedStops(stop, staticData) {
    return Array.from(staticData.stopsById.values())
        .filter((candidate) => candidate.stopId !== stop.stopId &&
        candidate.stopName === stop.stopName &&
        candidate.services.size > 0)
        .map((candidate) => ({
        stop: candidate,
        distanceMeters: metersBetween(stop.latitude, stop.longitude, candidate.latitude, candidate.longitude),
    }))
        .filter((candidate) => candidate.distanceMeters <= RELATED_STOP_RADIUS_METERS)
        .sort((left, right) => left.distanceMeters - right.distanceMeters)
        .slice(0, RELATED_STOP_LIMIT)
        .map((candidate) => stopToApiRecord(candidate.stop, Math.round(candidate.distanceMeters)));
}
function getRelatedStopsFromArrivalsData(stop, staticData) {
    const candidates = Array.from(staticData.stopsById.values())
        .filter((candidateStop) => candidateStop.stopId !== stop.stopId)
        .map((candidateStop) => ({
        stop: candidateStop,
        distanceMeters: metersBetween(stop.latitude, stop.longitude, candidateStop.latitude, candidateStop.longitude),
    }))
        .filter((candidate) => candidate.distanceMeters <= RELATED_STOP_RADIUS_METERS)
        .sort((left, right) => left.distanceMeters - right.distanceMeters)
        .slice(0, RELATED_STOP_LIMIT);
    return candidates.map((candidate) => stopToApiRecord(candidate.stop, Math.round(candidate.distanceMeters)));
}
async function getFeedMessageType() {
    if (!feedMessageTypePromise) {
        feedMessageTypePromise = (async () => {
            const protoCandidates = [
                path.join(serverDir, 'gtfs-realtime.proto'),
                path.resolve(serverDir, '../server/gtfs-realtime.proto'),
                path.resolve(projectRootDir, 'server/gtfs-realtime.proto'),
                path.resolve(process.cwd(), 'server/gtfs-realtime.proto'),
                path.resolve(process.cwd(), 'gtfs-realtime.proto'),
            ];
            const protoPath = protoCandidates.find((candidate) => existsSync(candidate));
            if (!protoPath) {
                throw new Error('Missing GTFS Realtime proto schema.');
            }
            const root = await protobuf.load(protoPath);
            return root.lookupType('transit_realtime.FeedMessage');
        })();
    }
    return feedMessageTypePromise;
}
async function fetchStaticGtfsArchive() {
    const response = await fetch(STATIC_GTFS_URL, {
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new Error(`Static GTFS request failed with ${response.status}`);
    }
    return unzipSync(new Uint8Array(await response.arrayBuffer()));
}
function parseCsvRows(file) {
    return parse(strFromU8(file), {
        bom: true,
        columns: true,
        skip_empty_lines: true,
    });
}
function stripCsvCell(value) {
    return (value ?? '').trim().replace(/^"(.*)"$/, '$1');
}
function buildRoutesById(rows) {
    const routesById = new Map();
    for (const row of rows) {
        const routeId = row.route_id?.trim();
        if (!routeId) {
            continue;
        }
        routesById.set(routeId, {
            routeId,
            routeShortName: row.route_short_name?.trim() || routeId,
            routeLongName: row.route_long_name?.trim() || routeId,
            routeTypeRaw: row.route_type?.trim() || '',
            routeColor: normalizeColor(row.route_color),
            routeTextColor: normalizeColor(row.route_text_color),
        });
    }
    return routesById;
}
function buildTripsById(rows) {
    const tripsById = new Map();
    for (const row of rows) {
        const tripId = row.trip_id?.trim();
        const routeId = row.route_id?.trim();
        const serviceId = row.service_id?.trim();
        if (!tripId || !routeId || !serviceId) {
            continue;
        }
        const directionIdRaw = row.direction_id?.trim();
        const shapeId = row.shape_id?.trim() || null;
        tripsById.set(tripId, {
            tripId,
            routeId,
            serviceId,
            headsign: row.trip_headsign?.trim() || null,
            directionId: directionIdRaw && directionIdRaw.length > 0
                ? Number.parseInt(directionIdRaw, 10)
                : null,
            shapeId,
        });
    }
    return tripsById;
}
function buildStopsIndex(rows) {
    const stopsById = new Map();
    const stopsByCode = new Map();
    for (const row of rows) {
        const stopId = row.stop_id?.trim();
        const stopCode = row.stop_code?.trim();
        const latitude = row.stop_lat ? Number.parseFloat(row.stop_lat) : Number.NaN;
        const longitude = row.stop_lon ? Number.parseFloat(row.stop_lon) : Number.NaN;
        if (!stopId || !stopCode || Number.isNaN(latitude) || Number.isNaN(longitude)) {
            continue;
        }
        const stopRecord = {
            stopId,
            stopCode,
            stopName: row.stop_name?.replace(/^Fermata\s+\d+\s+-\s+/i, '').trim() || stopCode,
            stopDescription: row.stop_desc?.trim() || null,
            latitude,
            longitude,
            url: row.stop_url?.trim() || null,
            wheelchairBoarding: row.wheelchair_boarding?.trim() || null,
            modes: new Set(),
            lines: new Set(),
            services: new Map(),
        };
        stopsById.set(stopId, stopRecord);
        stopsByCode.set(stopCode, stopRecord);
    }
    return {
        stopsById,
        stopsByCode,
    };
}
async function yieldToEventLoop() {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
}
async function scanStopTimesFile(stopTimesFile, tripsById, routesById, stopsById, onSchedule) {
    const text = strFromU8(stopTimesFile);
    const firstNewlineIndex = text.indexOf('\n');
    const headerLine = (firstNewlineIndex === -1 ? text : text.slice(0, firstNewlineIndex))
        .replace(/^\uFEFF/, '')
        .replace(/\r$/, '');
    const headers = headerLine.split(',').map(stripCsvCell);
    const tripIdIndex = headers.indexOf('trip_id');
    const stopIdIndex = headers.indexOf('stop_id');
    const arrivalTimeIndex = headers.indexOf('arrival_time');
    const stopSequenceIndex = headers.indexOf('stop_sequence');
    if (tripIdIndex === -1 || stopIdIndex === -1) {
        return;
    }
    let lineStart = firstNewlineIndex === -1 ? text.length : firstNewlineIndex + 1;
    let processedRows = 0;
    while (lineStart < text.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1) {
            lineEnd = text.length;
        }
        const row = text.slice(lineStart, lineEnd).replace(/\r$/, '');
        lineStart = lineEnd + 1;
        if (!row) {
            continue;
        }
        const columns = row.split(',').map(stripCsvCell);
        const tripId = columns[tripIdIndex];
        const stopId = columns[stopIdIndex];
        if (!tripId || !stopId) {
            processedRows += 1;
            if (processedRows % 5_000 === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        const tripRecord = tripsById.get(tripId);
        if (!tripRecord) {
            processedRows += 1;
            if (processedRows % 5_000 === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        const routeRecord = routesById.get(tripRecord.routeId);
        if (!routeRecord) {
            processedRows += 1;
            if (processedRows % 5_000 === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
        if (!SUPPORTED_SURFACE_MODES.has(mode)) {
            processedRows += 1;
            if (processedRows % 5_000 === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        const stopRecord = stopsById.get(stopId);
        if (!stopRecord) {
            processedRows += 1;
            if (processedRows % 5_000 === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        stopRecord.modes.add(mode);
        stopRecord.lines.add(routeRecord.routeShortName);
        stopRecord.services.set(buildStopServiceKey(routeRecord.routeShortName, mode), {
            lineCode: routeRecord.routeShortName,
            mode,
            modeLabel: label,
        });
        if (onSchedule && arrivalTimeIndex !== -1 && stopSequenceIndex !== -1) {
            const arrivalTime = columns[arrivalTimeIndex];
            const stopSequenceRaw = columns[stopSequenceIndex];
            if (arrivalTime && stopSequenceRaw) {
                const stopSequence = Number.parseInt(stopSequenceRaw, 10);
                if (!Number.isNaN(stopSequence)) {
                    onSchedule({
                        tripId,
                        stopSequence,
                        arrivalTime,
                    }, stopId);
                }
            }
        }
        processedRows += 1;
        if (processedRows % 5_000 === 0) {
            await yieldToEventLoop();
        }
    }
}
function parseRelevantShapePoints(shapesFile, relevantShapeIds) {
    const shapesById = new Map();
    if (!shapesFile || relevantShapeIds.size === 0) {
        return shapesById;
    }
    const text = strFromU8(shapesFile);
    const firstNewlineIndex = text.indexOf('\n');
    const headerLine = (firstNewlineIndex === -1 ? text : text.slice(0, firstNewlineIndex))
        .replace(/^\uFEFF/, '')
        .replace(/\r$/, '');
    const headers = headerLine.split(',').map(stripCsvCell);
    const shapeIdIndex = headers.indexOf('shape_id');
    const latitudeIndex = headers.indexOf('shape_pt_lat');
    const longitudeIndex = headers.indexOf('shape_pt_lon');
    const sequenceIndex = headers.indexOf('shape_pt_sequence');
    if (shapeIdIndex === -1 ||
        latitudeIndex === -1 ||
        longitudeIndex === -1 ||
        sequenceIndex === -1) {
        return shapesById;
    }
    let lineStart = firstNewlineIndex === -1 ? text.length : firstNewlineIndex + 1;
    while (lineStart < text.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1) {
            lineEnd = text.length;
        }
        const row = text.slice(lineStart, lineEnd).replace(/\r$/, '');
        lineStart = lineEnd + 1;
        if (!row) {
            continue;
        }
        const columns = row.split(',').map(stripCsvCell);
        const shapeId = columns[shapeIdIndex];
        if (!shapeId || !relevantShapeIds.has(shapeId)) {
            continue;
        }
        const latitude = Number.parseFloat(columns[latitudeIndex] ?? '');
        const longitude = Number.parseFloat(columns[longitudeIndex] ?? '');
        const sequence = Number.parseInt(columns[sequenceIndex] ?? '', 10);
        if (Number.isNaN(latitude) ||
            Number.isNaN(longitude) ||
            Number.isNaN(sequence)) {
            continue;
        }
        const points = shapesById.get(shapeId) ?? [];
        points.push({
            sequence,
            latitude,
            longitude,
        });
        shapesById.set(shapeId, points);
    }
    for (const points of shapesById.values()) {
        points.sort((left, right) => left.sequence - right.sequence);
    }
    return shapesById;
}
async function getStaticRoutesTripsData() {
    if (Date.now() < staticRoutesTripsCache.expiresAt) {
        return staticRoutesTripsCache.data;
    }
    if (staticRoutesTripsCache.promise) {
        return staticRoutesTripsCache.promise;
    }
    staticRoutesTripsCache.promise = (async () => {
        const archive = await fetchStaticGtfsArchive();
        const routesText = archive['routes.txt'];
        const tripsText = archive['trips.txt'];
        if (!routesText || !tripsText) {
            throw new Error('Static GTFS archive is missing route metadata files.');
        }
        const data = {
            routesById: buildRoutesById(parseCsvRows(routesText)),
            tripsById: buildTripsById(parseCsvRows(tripsText)),
        };
        staticRoutesTripsCache.data = data;
        staticRoutesTripsCache.expiresAt = Date.now() + STATIC_CACHE_TTL_MS;
        return data;
    })();
    try {
        return await staticRoutesTripsCache.promise;
    }
    finally {
        staticRoutesTripsCache.promise = null;
    }
}
async function getLinePathsStaticData(normalizedLine) {
    const metadata = await getStaticRoutesTripsData();
    const relevantShapeIds = new Set();
    for (const tripRecord of metadata.tripsById.values()) {
        const routeRecord = metadata.routesById.get(tripRecord.routeId);
        if (!routeRecord) {
            continue;
        }
        const { mode } = resolveRouteMode(routeRecord.routeTypeRaw);
        if (!SUPPORTED_SURFACE_MODES.has(mode)) {
            continue;
        }
        if (routeRecord.routeShortName.toUpperCase() === normalizedLine &&
            tripRecord.shapeId) {
            relevantShapeIds.add(tripRecord.shapeId);
        }
    }
    const archive = await fetchStaticGtfsArchive();
    return {
        routesById: metadata.routesById,
        tripsById: metadata.tripsById,
        shapesById: parseRelevantShapePoints(archive['shapes.txt'], relevantShapeIds),
    };
}
async function getStaticStopsIndexData() {
    if (Date.now() < staticStopsIndexCache.expiresAt) {
        return staticStopsIndexCache.data;
    }
    if (staticStopsIndexCache.promise) {
        return staticStopsIndexCache.promise;
    }
    staticStopsIndexCache.promise = (async () => {
        const archive = await fetchStaticGtfsArchive();
        const routesText = archive['routes.txt'];
        const tripsText = archive['trips.txt'];
        const stopsText = archive['stops.txt'];
        const stopTimesText = archive['stop_times.txt'];
        if (!routesText || !tripsText || !stopsText || !stopTimesText) {
            throw new Error('Static GTFS archive is missing required stop index files.');
        }
        const routesById = buildRoutesById(parseCsvRows(routesText));
        const tripsById = buildTripsById(parseCsvRows(tripsText));
        const data = buildStopsIndex(parseCsvRows(stopsText));
        await scanStopTimesFile(stopTimesText, tripsById, routesById, data.stopsById);
        staticStopsIndexCache.data = data;
        staticStopsIndexCache.expiresAt = Date.now() + STATIC_CACHE_TTL_MS;
        return data;
    })();
    try {
        return await staticStopsIndexCache.promise;
    }
    finally {
        staticStopsIndexCache.promise = null;
    }
}
async function getStaticStopsLiteData() {
    if (Date.now() < staticStopsLiteCache.expiresAt) {
        return staticStopsLiteCache.data;
    }
    if (staticStopsLiteCache.promise) {
        return staticStopsLiteCache.promise;
    }
    staticStopsLiteCache.promise = (async () => {
        const archive = await fetchStaticGtfsArchive();
        const stopsText = archive['stops.txt'];
        if (!stopsText) {
            throw new Error('Static GTFS archive is missing stops.txt.');
        }
        const data = buildStopsIndex(parseCsvRows(stopsText));
        staticStopsLiteCache.data = data;
        staticStopsLiteCache.expiresAt = Date.now() + STATIC_CACHE_TTL_MS;
        return data;
    })();
    try {
        return await staticStopsLiteCache.promise;
    }
    finally {
        staticStopsLiteCache.promise = null;
    }
}
async function getStaticArrivalsData() {
    if (Date.now() < staticArrivalsCache.expiresAt) {
        return staticArrivalsCache.data;
    }
    if (staticArrivalsCache.promise) {
        return staticArrivalsCache.promise;
    }
    staticArrivalsCache.promise = (async () => {
        const archive = await fetchStaticGtfsArchive();
        const routesText = archive['routes.txt'];
        const tripsText = archive['trips.txt'];
        const stopsText = archive['stops.txt'];
        const stopTimesText = archive['stop_times.txt'];
        const calendarText = archive['calendar.txt'];
        const calendarDatesText = archive['calendar_dates.txt'];
        if (!routesText || !tripsText || !stopsText || !stopTimesText || !calendarText) {
            throw new Error('Static GTFS archive is missing required GTFS files.');
        }
        const routesById = buildRoutesById(parseCsvRows(routesText));
        const tripsById = buildTripsById(parseCsvRows(tripsText));
        const stopsIndex = buildStopsIndex(parseCsvRows(stopsText));
        const calendarRows = parseCsvRows(calendarText);
        const calendarDatesRows = calendarDatesText
            ? parseCsvRows(calendarDatesText)
            : [];
        const stopSchedulesByStopId = new Map();
        const calendarsByServiceId = new Map();
        const calendarDateExceptionsByServiceId = new Map();
        for (const row of calendarRows) {
            const serviceId = row.service_id?.trim();
            const startDate = row.start_date?.trim();
            const endDate = row.end_date?.trim();
            if (!serviceId || !startDate || !endDate) {
                continue;
            }
            calendarsByServiceId.set(serviceId, {
                startDate,
                endDate,
                weekdays: [
                    row.monday?.trim() === '1',
                    row.tuesday?.trim() === '1',
                    row.wednesday?.trim() === '1',
                    row.thursday?.trim() === '1',
                    row.friday?.trim() === '1',
                    row.saturday?.trim() === '1',
                    row.sunday?.trim() === '1',
                ],
            });
        }
        for (const row of calendarDatesRows) {
            const serviceId = row.service_id?.trim();
            const date = row.date?.trim();
            const exceptionType = row.exception_type?.trim();
            if (!serviceId || !date || !exceptionType) {
                continue;
            }
            const serviceExceptions = calendarDateExceptionsByServiceId.get(serviceId) ?? new Map();
            if (exceptionType === '1') {
                serviceExceptions.set(date, true);
            }
            else if (exceptionType === '2') {
                serviceExceptions.set(date, false);
            }
            calendarDateExceptionsByServiceId.set(serviceId, serviceExceptions);
        }
        await scanStopTimesFile(stopTimesText, tripsById, routesById, stopsIndex.stopsById, (schedule, stopId) => {
            const schedules = stopSchedulesByStopId.get(stopId) ?? [];
            schedules.push(schedule);
            stopSchedulesByStopId.set(stopId, schedules);
        });
        const data = {
            routesById,
            tripsById,
            stopsById: stopsIndex.stopsById,
            stopsByCode: stopsIndex.stopsByCode,
            stopSchedulesByStopId,
            calendarsByServiceId,
            calendarDateExceptionsByServiceId,
        };
        staticArrivalsCache.data = data;
        staticArrivalsCache.expiresAt = Date.now() + STATIC_CACHE_TTL_MS;
        return data;
    })();
    try {
        return await staticArrivalsCache.promise;
    }
    finally {
        staticArrivalsCache.promise = null;
    }
}
function resolveModeFromHtml(modeClass) {
    const normalized = modeClass.trim().toLowerCase();
    switch (normalized) {
        case 'tram':
            return { mode: 'tram', label: 'Tram' };
        case 'bus':
            return { mode: 'bus', label: 'Bus' };
        case 'rail':
            return { mode: 'rail', label: 'Treno' };
        case 'metro':
            return { mode: 'metro', label: 'Metro' };
        default:
            return { mode: 'other', label: 'Mezzo' };
    }
}
function decodeHtmlEntities(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}
function stripHtmlTags(value) {
    return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}
function getTimeZoneOffsetMinutes(timeZone, date) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        timeZoneName: 'shortOffset',
    });
    const offsetValue = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-]\d{1,2})(?::?(\d{2}))?/i.exec(offsetValue);
    if (!match) {
        return 0;
    }
    const hours = Number.parseInt(match[1] ?? '0', 10);
    const minutes = Number.parseInt(match[2] ?? '0', 10);
    const sign = hours >= 0 ? 1 : -1;
    return hours * 60 + sign * minutes;
}
function getRomeDateParts(nowMs) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: ROME_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(nowMs));
    return {
        year: Number.parseInt(parts.find((part) => part.type === 'year')?.value ?? '0', 10),
        month: Number.parseInt(parts.find((part) => part.type === 'month')?.value ?? '0', 10),
        day: Number.parseInt(parts.find((part) => part.type === 'day')?.value ?? '0', 10),
    };
}
function buildRomeLocalTimestamp(year, month, day, hours, minutes) {
    let utcTimestamp = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
    let offsetMinutes = getTimeZoneOffsetMinutes(ROME_TIME_ZONE, new Date(utcTimestamp));
    utcTimestamp = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMinutes * 60_000;
    const resolvedOffsetMinutes = getTimeZoneOffsetMinutes(ROME_TIME_ZONE, new Date(utcTimestamp));
    if (resolvedOffsetMinutes !== offsetMinutes) {
        utcTimestamp =
            Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - resolvedOffsetMinutes * 60_000;
    }
    return utcTimestamp;
}
function parseOfficialStopMinutes(rawTime, nowMs) {
    const normalized = stripHtmlTags(rawTime);
    if (!normalized) {
        return null;
    }
    if (/in arrivo/i.test(normalized)) {
        return {
            predictedArrival: new Date(nowMs).toISOString(),
            minutesUntil: 0,
        };
    }
    const minutesMatch = /(\d+)\s*min/i.exec(normalized);
    if (minutesMatch) {
        const minutesUntil = Number.parseInt(minutesMatch[1] ?? '', 10);
        if (!Number.isNaN(minutesUntil)) {
            return {
                predictedArrival: new Date(nowMs + minutesUntil * 60_000).toISOString(),
                minutesUntil,
            };
        }
    }
    const timeMatch = /(\d{1,2}):(\d{2})/.exec(normalized);
    if (!timeMatch) {
        return null;
    }
    const hours = Number.parseInt(timeMatch[1] ?? '', 10);
    const minutes = Number.parseInt(timeMatch[2] ?? '', 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
        return null;
    }
    const romeNowDateParts = getRomeDateParts(nowMs);
    let arrivalTimestamp = buildRomeLocalTimestamp(romeNowDateParts.year, romeNowDateParts.month, romeNowDateParts.day, hours, minutes);
    if (arrivalTimestamp < nowMs - 5 * 60_000) {
        arrivalTimestamp += 24 * 60 * 60_000;
    }
    return {
        predictedArrival: new Date(arrivalTimestamp).toISOString(),
        minutesUntil: Math.max(0, Math.ceil((arrivalTimestamp - nowMs) / 60_000)),
    };
}
async function fetchOfficialStopArrivals(stopCode, stop) {
    const stopUrl = `https://www.muoversiatorino.it/stops/gtt%3A${encodeURIComponent(stopCode)}`;
    const pageResponse = await fetch(stopUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; GTT-Radar/1.0; +https://gtt-to.onrender.com)',
        },
    });
    if (!pageResponse.ok) {
        throw new Error(`Official stop page request failed with ${pageResponse.status}`);
    }
    const html = await pageResponse.text();
    const stopNameMatch = /<span class="h3">([^<]+)<span class="link-arrow">/i.exec(html) ??
        /<h1 class="h2"><span>Fermata<\/span><\/h1>[\s\S]*?<span class="h3">([^<]+)/i.exec(html);
    const officialStopName = stopNameMatch ? stripHtmlTags(stopNameMatch[1] ?? '') : stop.stopName;
    const departureBlocks = html.match(/<p class="departure route-detail-text[\s\S]*?<\/p>/gi) ?? [];
    const nowMs = Date.now();
    const arrivals = [];
    const servicesByKey = new Map();
    for (const block of departureBlocks) {
        const lineMatch = /<span class="vehicle-number\s+([a-z-]+)">([^<]+)<\/span>/i.exec(block);
        const destinationMatch = /<span class="destination"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
        const timeMatch = /<span[^>]*class="time[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span class="route-number">/i.exec(block) ??
            /<span[^>]*class="time[^"]*"[^>]*>([\s\S]*?)$/i.exec(block);
        if (!lineMatch || !destinationMatch || !timeMatch) {
            continue;
        }
        const lineCode = stripHtmlTags(lineMatch[2] ?? '');
        const parsedTime = parseOfficialStopMinutes(timeMatch[1] ?? '', nowMs);
        if (!lineCode || !parsedTime) {
            continue;
        }
        const { mode, label } = resolveModeFromHtml(lineMatch[1] ?? '');
        const headsign = stripHtmlTags(destinationMatch[1] ?? '') || null;
        const routeId = `official:${lineCode}`;
        const serviceKey = buildStopServiceKey(lineCode, mode);
        servicesByKey.set(serviceKey, {
            lineCode,
            mode,
            modeLabel: label,
        });
        arrivals.push({
            tripId: `${routeId}:${arrivals.length}`,
            lineCode,
            routeId,
            routeName: lineCode,
            headsign,
            mode,
            modeLabel: label,
            routeColor: null,
            routeTextColor: null,
            scheduledArrival: parsedTime.predictedArrival,
            predictedArrival: parsedTime.predictedArrival,
            delaySeconds: null,
            minutesUntil: parsedTime.minutesUntil,
            vehicleId: null,
            vehicleLabel: null,
            vehiclePosition: null,
            realtime: /realtime/i.test(block) || /In arrivo/i.test(block),
        });
    }
    const renderStop = {
        ...stop,
        stopName: officialStopName || stop.stopName,
        lines: new Set(Array.from(servicesByKey.values()).map((service) => service.lineCode)),
        modes: new Set(Array.from(servicesByKey.values()).map((service) => service.mode)),
        services: new Map(Array.from(servicesByKey.entries())),
    };
    return {
        fetchedAt: new Date().toISOString(),
        feedTimestamp: null,
        stale: false,
        warnings: ['Render Free: passaggi fermata ottenuti dalla pagina ufficiale Muoversi a Torino.'],
        stop: stopToApiRecord(renderStop),
        relatedStops: [],
        arrivals: arrivals
            .sort((left, right) => left.minutesUntil - right.minutesUntil)
            .slice(0, 18),
    };
}
async function getStaticGtfsData() {
    if (Date.now() < staticCache.expiresAt) {
        return staticCache.data;
    }
    if (staticCache.promise) {
        return staticCache.promise;
    }
    staticCache.promise = (async () => {
        const archive = await fetchStaticGtfsArchive();
        const routesText = archive['routes.txt'];
        const tripsText = archive['trips.txt'];
        const stopsText = archive['stops.txt'];
        const stopTimesText = archive['stop_times.txt'];
        const shapesText = archive['shapes.txt'];
        const calendarText = archive['calendar.txt'];
        const calendarDatesText = archive['calendar_dates.txt'];
        if (!routesText || !tripsText || !stopsText || !stopTimesText || !calendarText) {
            throw new Error('Static GTFS archive is missing required GTFS files.');
        }
        const stopsRows = parseCsvRows(stopsText);
        const stopTimesRows = parseCsvRows(stopTimesText);
        const shapesRows = shapesText ? parseCsvRows(shapesText) : [];
        const calendarRows = parseCsvRows(calendarText);
        const calendarDatesRows = calendarDatesText
            ? parseCsvRows(calendarDatesText)
            : [];
        const routesById = buildRoutesById(parseCsvRows(routesText));
        const tripsById = buildTripsById(parseCsvRows(tripsText));
        const stopsById = new Map();
        const stopsByCode = new Map();
        const shapesById = new Map();
        const tripStopPointsByTripId = new Map();
        const stopSchedulesByStopId = new Map();
        const calendarsByServiceId = new Map();
        const calendarDateExceptionsByServiceId = new Map();
        for (const row of shapesRows) {
            const shapeId = row.shape_id?.trim();
            const sequenceRaw = row.shape_pt_sequence?.trim();
            const latitude = row.shape_pt_lat ? Number.parseFloat(row.shape_pt_lat) : Number.NaN;
            const longitude = row.shape_pt_lon ? Number.parseFloat(row.shape_pt_lon) : Number.NaN;
            if (!shapeId || !sequenceRaw || Number.isNaN(latitude) || Number.isNaN(longitude)) {
                continue;
            }
            const sequence = Number.parseInt(sequenceRaw, 10);
            if (Number.isNaN(sequence)) {
                continue;
            }
            const points = shapesById.get(shapeId) ?? [];
            points.push({
                sequence,
                latitude,
                longitude,
            });
            shapesById.set(shapeId, points);
        }
        for (const row of calendarRows) {
            const serviceId = row.service_id?.trim();
            const startDate = row.start_date?.trim();
            const endDate = row.end_date?.trim();
            if (!serviceId || !startDate || !endDate) {
                continue;
            }
            calendarsByServiceId.set(serviceId, {
                startDate,
                endDate,
                weekdays: [
                    row.monday?.trim() === '1',
                    row.tuesday?.trim() === '1',
                    row.wednesday?.trim() === '1',
                    row.thursday?.trim() === '1',
                    row.friday?.trim() === '1',
                    row.saturday?.trim() === '1',
                    row.sunday?.trim() === '1',
                ],
            });
        }
        for (const row of calendarDatesRows) {
            const serviceId = row.service_id?.trim();
            const date = row.date?.trim();
            const exceptionType = row.exception_type?.trim();
            if (!serviceId || !date || !exceptionType) {
                continue;
            }
            const serviceExceptions = calendarDateExceptionsByServiceId.get(serviceId) ?? new Map();
            if (exceptionType === '1') {
                serviceExceptions.set(date, true);
            }
            else if (exceptionType === '2') {
                serviceExceptions.set(date, false);
            }
            calendarDateExceptionsByServiceId.set(serviceId, serviceExceptions);
        }
        for (const row of stopsRows) {
            const stopId = row.stop_id?.trim();
            const stopCode = row.stop_code?.trim();
            const latitude = row.stop_lat ? Number.parseFloat(row.stop_lat) : Number.NaN;
            const longitude = row.stop_lon ? Number.parseFloat(row.stop_lon) : Number.NaN;
            if (!stopId || !stopCode || Number.isNaN(latitude) || Number.isNaN(longitude)) {
                continue;
            }
            const stopRecord = {
                stopId,
                stopCode,
                stopName: row.stop_name?.replace(/^Fermata\s+\d+\s+-\s+/i, '').trim() || stopCode,
                stopDescription: row.stop_desc?.trim() || null,
                latitude,
                longitude,
                url: row.stop_url?.trim() || null,
                wheelchairBoarding: row.wheelchair_boarding?.trim() || null,
                modes: new Set(),
                lines: new Set(),
                services: new Map(),
            };
            stopsById.set(stopId, stopRecord);
            stopsByCode.set(stopCode, stopRecord);
        }
        for (const row of stopTimesRows) {
            const tripId = row.trip_id?.trim();
            const stopId = row.stop_id?.trim();
            const arrivalTime = row.arrival_time?.trim();
            const stopSequenceRaw = row.stop_sequence?.trim();
            if (!tripId || !stopId || !arrivalTime || !stopSequenceRaw) {
                continue;
            }
            const tripRecord = tripsById.get(tripId);
            if (!tripRecord) {
                continue;
            }
            const routeRecord = routesById.get(tripRecord.routeId);
            if (!routeRecord) {
                continue;
            }
            const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
            if (!SUPPORTED_SURFACE_MODES.has(mode)) {
                continue;
            }
            const stopSequence = Number.parseInt(stopSequenceRaw, 10);
            if (Number.isNaN(stopSequence)) {
                continue;
            }
            const schedules = stopSchedulesByStopId.get(stopId) ?? [];
            schedules.push({
                tripId,
                stopSequence,
                arrivalTime,
            });
            stopSchedulesByStopId.set(stopId, schedules);
            const stopRecord = stopsById.get(stopId);
            if (stopRecord) {
                const tripPathPoints = tripStopPointsByTripId.get(tripId) ?? [];
                tripPathPoints.push({
                    sequence: stopSequence,
                    latitude: stopRecord.latitude,
                    longitude: stopRecord.longitude,
                });
                tripStopPointsByTripId.set(tripId, tripPathPoints);
                stopRecord.modes.add(mode);
                stopRecord.lines.add(routeRecord.routeShortName);
                stopRecord.services.set(buildStopServiceKey(routeRecord.routeShortName, mode), {
                    lineCode: routeRecord.routeShortName,
                    mode,
                    modeLabel: label,
                });
            }
        }
        for (const points of shapesById.values()) {
            points.sort((left, right) => left.sequence - right.sequence);
        }
        for (const points of tripStopPointsByTripId.values()) {
            points.sort((left, right) => left.sequence - right.sequence);
        }
        const data = {
            routesById,
            tripsById,
            stopsById,
            stopsByCode,
            shapesById,
            tripStopPointsByTripId,
            stopSchedulesByStopId,
            calendarsByServiceId,
            calendarDateExceptionsByServiceId,
        };
        staticCache.data = data;
        staticCache.expiresAt = Date.now() + STATIC_CACHE_TTL_MS;
        return data;
    })();
    try {
        return await staticCache.promise;
    }
    finally {
        staticCache.promise = null;
    }
}
async function fetchRealtimeSnapshot() {
    const [feedMessageType, response] = await Promise.all([
        getFeedMessageType(),
        fetch(TRIP_UPDATE_FEED_URL, {
            signal: AbortSignal.timeout(15_000),
        }),
    ]);
    if (!response.ok) {
        throw new Error(`Trip updates request failed with ${response.status}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const message = feedMessageType.decode(buffer);
    const object = feedMessageType.toObject(message, {
        longs: Number,
        enums: String,
        defaults: false,
        arrays: true,
        objects: true,
    });
    const tripUpdatesByTripId = new Map();
    for (const entity of object.entity ?? []) {
        const tripUpdate = entity.tripUpdate;
        const tripId = tripUpdate?.trip?.tripId;
        if (!tripId) {
            continue;
        }
        tripUpdatesByTripId.set(tripId, {
            tripId,
            startDate: tripUpdate.trip?.startDate ?? null,
            startTime: tripUpdate.trip?.startTime ?? null,
            vehicleId: tripUpdate.vehicle?.id ?? null,
            vehicleLabel: tripUpdate.vehicle?.label ?? null,
            stopTimeUpdates: tripUpdate.stopTimeUpdate ?? [],
        });
    }
    return {
        feedTimestamp: toIsoString(object.header?.timestamp),
        tripUpdatesByTripId,
    };
}
async function fetchVehiclePositionSnapshot() {
    const [feedMessageType, response] = await Promise.all([
        getFeedMessageType(),
        fetch(VEHICLE_POSITION_FEED_URL, {
            signal: AbortSignal.timeout(15_000),
        }),
    ]);
    if (!response.ok) {
        throw new Error(`Vehicle positions request failed with ${response.status}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const message = feedMessageType.decode(buffer);
    const object = feedMessageType.toObject(message, {
        longs: Number,
        enums: String,
        defaults: false,
        arrays: true,
        objects: true,
    });
    const positionsByTripId = new Map();
    const positionsByVehicleId = new Map();
    for (const entity of object.entity ?? []) {
        const vehiclePosition = entity.vehicle;
        const position = vehiclePosition?.position;
        const latitude = position?.latitude;
        const longitude = position?.longitude;
        if (!vehiclePosition || !position || typeof latitude !== 'number' || typeof longitude !== 'number') {
            continue;
        }
        const record = {
            tripId: vehiclePosition.trip?.tripId ?? null,
            vehicleId: vehiclePosition.vehicle?.id ?? null,
            vehicleLabel: vehiclePosition.vehicle?.label ?? null,
            latitude,
            longitude,
            bearing: typeof position.bearing === 'number'
                ? position.bearing
                : null,
            speedMetersPerSecond: typeof position.speed === 'number'
                ? position.speed
                : null,
            timestamp: toIsoString(vehiclePosition.timestamp),
        };
        if (record.tripId) {
            positionsByTripId.set(record.tripId, record);
        }
        if (record.vehicleId) {
            positionsByVehicleId.set(record.vehicleId, record);
        }
    }
    return {
        feedTimestamp: toIsoString(object.header?.timestamp),
        positionsByTripId,
        positionsByVehicleId,
    };
}
async function getRealtimeSnapshot() {
    if (Date.now() < realtimeCache.expiresAt && realtimeCache.data) {
        return {
            snapshot: realtimeCache.data,
            stale: false,
            warnings: [],
        };
    }
    if (realtimeCache.promise) {
        return {
            snapshot: await realtimeCache.promise,
            stale: false,
            warnings: [],
        };
    }
    realtimeCache.promise = (async () => {
        const snapshot = await fetchRealtimeSnapshot();
        realtimeCache.data = snapshot;
        realtimeCache.expiresAt = Date.now() + REALTIME_CACHE_TTL_MS;
        return snapshot;
    })();
    try {
        const snapshot = await realtimeCache.promise;
        return {
            snapshot,
            stale: false,
            warnings: [],
        };
    }
    catch (error) {
        if (realtimeCache.data) {
            return {
                snapshot: realtimeCache.data,
                stale: true,
                warnings: [
                    error instanceof Error
                        ? `Feed realtime temporaneamente non raggiungibile: ${error.message}`
                        : 'Feed realtime temporaneamente non raggiungibile.',
                ],
            };
        }
        throw error;
    }
    finally {
        realtimeCache.promise = null;
    }
}
async function getVehiclePositionSnapshot() {
    if (Date.now() < vehiclePositionCache.expiresAt && vehiclePositionCache.data) {
        return {
            snapshot: vehiclePositionCache.data,
            stale: false,
            warnings: [],
        };
    }
    if (vehiclePositionCache.promise) {
        return {
            snapshot: await vehiclePositionCache.promise,
            stale: false,
            warnings: [],
        };
    }
    vehiclePositionCache.promise = (async () => {
        const snapshot = await fetchVehiclePositionSnapshot();
        vehiclePositionCache.data = snapshot;
        vehiclePositionCache.expiresAt = Date.now() + REALTIME_CACHE_TTL_MS;
        return snapshot;
    })();
    try {
        const snapshot = await vehiclePositionCache.promise;
        return {
            snapshot,
            stale: false,
            warnings: [],
        };
    }
    catch (error) {
        if (vehiclePositionCache.data) {
            return {
                snapshot: vehiclePositionCache.data,
                stale: true,
                warnings: [
                    error instanceof Error
                        ? `Feed posizioni veicoli temporaneamente non raggiungibile: ${error.message}`
                        : 'Feed posizioni veicoli temporaneamente non raggiungibile.',
                ],
            };
        }
        return {
            snapshot: {
                feedTimestamp: null,
                positionsByTripId: new Map(),
                positionsByVehicleId: new Map(),
            },
            stale: true,
            warnings: [
                error instanceof Error
                    ? `Feed posizioni veicoli temporaneamente non raggiungibile: ${error.message}`
                    : 'Feed posizioni veicoli temporaneamente non raggiungibile.',
            ],
        };
    }
    finally {
        vehiclePositionCache.promise = null;
    }
}
function buildArrivalRecord(schedule, stopId, staticData, nowMs, serviceDate, realtimeTrip, vehiclePosition) {
    const tripRecord = staticData.tripsById.get(schedule.tripId);
    if (!tripRecord) {
        return null;
    }
    const routeRecord = staticData.routesById.get(tripRecord.routeId);
    if (!routeRecord) {
        return null;
    }
    const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
    if (!SUPPORTED_SURFACE_MODES.has(mode)) {
        return null;
    }
    if (!realtimeTrip && !isServiceActiveOnDate(tripRecord.serviceId, serviceDate, staticData)) {
        return null;
    }
    const scheduledArrival = parseGtfsDateTime(serviceDate, schedule.arrivalTime);
    if (!scheduledArrival) {
        return null;
    }
    const scheduledArrivalMs = new Date(scheduledArrival).getTime();
    const matchingStopTimeUpdate = realtimeTrip?.stopTimeUpdates.find((stopTimeUpdate) => stopTimeUpdate.stopSequence === schedule.stopSequence ||
        stopTimeUpdate.stopId === stopId);
    const stopTimeEvent = matchingStopTimeUpdate?.arrival ?? matchingStopTimeUpdate?.departure ?? null;
    const hasRealtimePrediction = typeof stopTimeEvent?.time === 'number' || typeof stopTimeEvent?.delay === 'number';
    const predictedArrival = typeof stopTimeEvent?.time === 'number'
        ? new Date(stopTimeEvent.time * 1000).toISOString()
        : typeof stopTimeEvent?.delay === 'number'
            ? new Date(scheduledArrivalMs + stopTimeEvent.delay * 1000).toISOString()
            : scheduledArrival;
    const predictedArrivalMs = new Date(predictedArrival).getTime();
    if (predictedArrivalMs < nowMs - PAST_GRACE_MS ||
        predictedArrivalMs > nowMs + UPCOMING_WINDOW_MS) {
        return null;
    }
    return {
        tripId: schedule.tripId,
        lineCode: routeRecord.routeShortName,
        routeId: routeRecord.routeId,
        routeName: routeRecord.routeLongName,
        headsign: tripRecord.headsign,
        mode,
        modeLabel: label,
        routeColor: routeRecord.routeColor,
        routeTextColor: routeRecord.routeTextColor,
        scheduledArrival,
        predictedArrival,
        delaySeconds: typeof stopTimeEvent?.delay === 'number'
            ? stopTimeEvent.delay
            : hasRealtimePrediction
                ? Math.round((predictedArrivalMs - scheduledArrivalMs) / 1000)
                : null,
        minutesUntil: Math.max(0, Math.ceil((predictedArrivalMs - nowMs) / 60_000)),
        vehicleId: hasRealtimePrediction ? realtimeTrip?.vehicleId ?? null : null,
        vehicleLabel: hasRealtimePrediction ? realtimeTrip?.vehicleLabel ?? null : null,
        vehiclePosition: hasRealtimePrediction && vehiclePosition
            ? {
                latitude: vehiclePosition.latitude,
                longitude: vehiclePosition.longitude,
                bearing: vehiclePosition.bearing,
                speedMetersPerSecond: vehiclePosition.speedMetersPerSecond,
                timestamp: vehiclePosition.timestamp,
            }
            : null,
        realtime: hasRealtimePrediction,
    };
}
const app = express();
const DEFAULT_BOUNDS_LIMIT = 220;
app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
});
app.get('/api/geocode', async (request, response, next) => {
    try {
        const address = String(request.query.address ?? '').trim();
        if (!address) {
            response.status(400).json({ error: 'address is required.' });
            return;
        }
        const payload = await geocodeAddress(address);
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/stops/nearby', async (request, response, next) => {
    try {
        const latitude = Number.parseFloat(String(request.query.lat ?? ''));
        const longitude = Number.parseFloat(String(request.query.lon ?? ''));
        const radiusMeters = Number.parseInt(String(request.query.radius ?? DEFAULT_NEARBY_RADIUS_METERS), 10);
        const limit = Number.parseInt(String(request.query.limit ?? DEFAULT_NEARBY_LIMIT), 10);
        if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
            response.status(400).json({ error: 'Latitude and longitude are required.' });
            return;
        }
        const staticData = IS_RENDER_RUNTIME
            ? await getStaticStopsLiteData()
            : await getStaticStopsIndexData();
        const candidates = Array.from(staticData.stopsById.values())
            .filter((stop) => (IS_RENDER_RUNTIME ? true : stop.lines.size > 0))
            .map((stop) => ({
            stop,
            distanceMeters: metersBetween(latitude, longitude, stop.latitude, stop.longitude),
        }))
            .sort((left, right) => left.distanceMeters - right.distanceMeters);
        const inRadius = candidates.filter((candidate) => candidate.distanceMeters <= radiusMeters);
        const stops = (inRadius.length > 0 ? inRadius : candidates)
            .slice(0, limit)
            .map((candidate) => stopToApiRecord(candidate.stop, candidate.distanceMeters));
        const payload = {
            fetchedAt: new Date().toISOString(),
            userLocation: {
                latitude,
                longitude,
            },
            stops,
        };
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/lines', async (_request, response, next) => {
    try {
        const staticData = await getStaticRoutesTripsData();
        const payload = {
            fetchedAt: new Date().toISOString(),
            lines: buildLineCatalog(staticData),
        };
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/stops/bounds', async (request, response, next) => {
    try {
        const north = Number.parseFloat(String(request.query.north ?? ''));
        const south = Number.parseFloat(String(request.query.south ?? ''));
        const east = Number.parseFloat(String(request.query.east ?? ''));
        const west = Number.parseFloat(String(request.query.west ?? ''));
        const limit = Number.parseInt(String(request.query.limit ?? DEFAULT_BOUNDS_LIMIT), 10);
        if ([north, south, east, west].some((value) => Number.isNaN(value))) {
            response
                .status(400)
                .json({ error: 'north, south, east and west are required.' });
            return;
        }
        const minLatitude = Math.min(north, south);
        const maxLatitude = Math.max(north, south);
        const minLongitude = Math.min(east, west);
        const maxLongitude = Math.max(east, west);
        const centerLatitude = (minLatitude + maxLatitude) / 2;
        const centerLongitude = (minLongitude + maxLongitude) / 2;
        const staticData = IS_RENDER_RUNTIME
            ? await getStaticStopsLiteData()
            : await getStaticStopsIndexData();
        const stops = Array.from(staticData.stopsById.values())
            .filter((stop) => (IS_RENDER_RUNTIME || stop.lines.size > 0) &&
            stop.latitude >= minLatitude &&
            stop.latitude <= maxLatitude &&
            stop.longitude >= minLongitude &&
            stop.longitude <= maxLongitude)
            .map((stop) => ({
            stop,
            distanceMeters: metersBetween(centerLatitude, centerLongitude, stop.latitude, stop.longitude),
        }))
            .sort((left, right) => left.distanceMeters - right.distanceMeters)
            .slice(0, limit)
            .map((candidate) => stopToApiRecord(candidate.stop, candidate.distanceMeters));
        const payload = {
            fetchedAt: new Date().toISOString(),
            bounds: {
                north,
                south,
                east,
                west,
            },
            stops,
        };
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/arrivals', async (request, response, next) => {
    try {
        const stopCode = String(request.query.stopCode ?? '').trim();
        if (!stopCode) {
            response.status(400).json({ error: 'stopCode is required.' });
            return;
        }
        const cachedPayload = getTimedCachedResponse(arrivalsResponseCache, stopCode);
        if (cachedPayload) {
            response.setHeader('Cache-Control', 'no-store');
            response.json(cachedPayload);
            return;
        }
        if (IS_RENDER_RUNTIME) {
            const staticStopsData = await getStaticStopsLiteData();
            const stop = staticStopsData.stopsByCode.get(stopCode);
            if (!stop) {
                response.status(404).json({ error: 'Fermata non trovata.' });
                return;
            }
            const payload = await fetchOfficialStopArrivals(stopCode, stop);
            setTimedCachedResponse(arrivalsResponseCache, stopCode, payload, ARRIVALS_RESPONSE_CACHE_TTL_MS);
            response.setHeader('Cache-Control', 'no-store');
            response.json(payload);
            return;
        }
        const staticData = await getStaticArrivalsData();
        const stop = staticData.stopsByCode.get(stopCode);
        if (!stop) {
            response.status(404).json({ error: 'Fermata non trovata.' });
            return;
        }
        const [{ snapshot, stale: realtimeStale, warnings: realtimeWarnings }, { snapshot: vehiclePositionSnapshot, stale: vehiclePositionStale, warnings: vehiclePositionWarnings, },] = await Promise.all([getRealtimeSnapshot(), getVehiclePositionSnapshot()]);
        const nowMs = Date.now();
        const schedules = staticData.stopSchedulesByStopId.get(stop.stopId) ?? [];
        const relatedStops = getRelatedStopsFromArrivalsData(stop, staticData);
        const candidateServiceDates = getCandidateServiceDates(nowMs);
        const arrivalsByTripInstance = new Map();
        for (const schedule of schedules) {
            const realtimeTrip = snapshot.tripUpdatesByTripId.get(schedule.tripId);
            const serviceDates = realtimeTrip?.startDate
                ? [realtimeTrip.startDate, ...candidateServiceDates.filter((date) => date !== realtimeTrip.startDate)]
                : candidateServiceDates;
            for (const serviceDate of serviceDates) {
                const activeRealtimeTrip = realtimeTrip?.startDate === serviceDate ? realtimeTrip : undefined;
                const vehiclePosition = activeRealtimeTrip
                    ? vehiclePositionSnapshot.positionsByTripId.get(schedule.tripId) ??
                        (activeRealtimeTrip.vehicleId
                            ? vehiclePositionSnapshot.positionsByVehicleId.get(activeRealtimeTrip.vehicleId) ?? null
                            : null)
                    : null;
                const arrival = buildArrivalRecord(schedule, stop.stopId, staticData, nowMs, serviceDate, activeRealtimeTrip, vehiclePosition);
                if (!arrival) {
                    continue;
                }
                const tripInstanceKey = `${schedule.tripId}:${serviceDate}`;
                const currentArrival = arrivalsByTripInstance.get(tripInstanceKey);
                if (!currentArrival ||
                    (!currentArrival.realtime && arrival.realtime) ||
                    new Date(arrival.predictedArrival).getTime() <
                        new Date(currentArrival.predictedArrival).getTime()) {
                    arrivalsByTripInstance.set(tripInstanceKey, arrival);
                }
            }
        }
        const arrivals = Array.from(arrivalsByTripInstance.values())
            .sort((left, right) => new Date(left.predictedArrival).getTime() -
            new Date(right.predictedArrival).getTime())
            .slice(0, 18);
        const payload = {
            fetchedAt: new Date().toISOString(),
            feedTimestamp: snapshot.feedTimestamp,
            stale: realtimeStale || vehiclePositionStale,
            warnings: [...realtimeWarnings, ...vehiclePositionWarnings],
            stop: stopToApiRecord(stop),
            relatedStops,
            arrivals,
        };
        setTimedCachedResponse(arrivalsResponseCache, stopCode, payload, ARRIVALS_RESPONSE_CACHE_TTL_MS);
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/vehicles', async (request, response, next) => {
    try {
        const rawLine = String(request.query.line ?? '').trim();
        if (!rawLine) {
            response.status(400).json({ error: 'line is required.' });
            return;
        }
        const normalizedLine = rawLine.toUpperCase();
        const cachedPayload = getTimedCachedResponse(vehiclesResponseCache, normalizedLine);
        if (cachedPayload) {
            response.setHeader('Cache-Control', 'no-store');
            response.json(cachedPayload);
            return;
        }
        const staticData = await getStaticRoutesTripsData();
        const { snapshot, stale, warnings } = await getVehiclePositionSnapshot();
        const vehiclesByKey = new Map();
        for (const [tripId, position] of snapshot.positionsByTripId) {
            const tripRecord = staticData.tripsById.get(tripId);
            if (!tripRecord) {
                continue;
            }
            const routeRecord = staticData.routesById.get(tripRecord.routeId);
            if (!routeRecord) {
                continue;
            }
            const { mode, label } = resolveRouteMode(routeRecord.routeTypeRaw);
            if (!SUPPORTED_SURFACE_MODES.has(mode)) {
                continue;
            }
            if (routeRecord.routeShortName.toUpperCase() !== normalizedLine) {
                continue;
            }
            const vehicleKey = position.vehicleId ?? tripId;
            if (vehiclesByKey.has(vehicleKey)) {
                continue;
            }
            vehiclesByKey.set(vehicleKey, {
                tripId,
                vehicleId: position.vehicleId,
                vehicleLabel: position.vehicleLabel,
                lineCode: routeRecord.routeShortName,
                routeId: routeRecord.routeId,
                routeName: routeRecord.routeLongName,
                headsign: tripRecord.headsign,
                mode,
                modeLabel: label,
                routeColor: routeRecord.routeColor,
                routeTextColor: routeRecord.routeTextColor,
                latitude: position.latitude,
                longitude: position.longitude,
                bearing: position.bearing,
                speedMetersPerSecond: position.speedMetersPerSecond,
                timestamp: position.timestamp,
            });
        }
        const vehicles = Array.from(vehiclesByKey.values()).sort((left, right) => {
            const lineCodeComparison = compareLineCodes(left.lineCode, right.lineCode);
            if (lineCodeComparison !== 0) {
                return lineCodeComparison;
            }
            return (left.vehicleLabel ?? left.tripId).localeCompare(right.vehicleLabel ?? right.tripId, 'it');
        });
        const payload = {
            fetchedAt: new Date().toISOString(),
            feedTimestamp: snapshot.feedTimestamp,
            stale,
            warnings,
            line: rawLine,
            vehicles,
        };
        setTimedCachedResponse(vehiclesResponseCache, normalizedLine, payload, VEHICLES_RESPONSE_CACHE_TTL_MS);
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
app.get('/api/line-paths', async (request, response, next) => {
    try {
        const rawLine = String(request.query.line ?? '').trim();
        if (!rawLine) {
            response.status(400).json({ error: 'line is required.' });
            return;
        }
        const normalizedLine = rawLine.toUpperCase();
        const cachedPayload = getTimedCachedResponse(linePathsResponseCache, normalizedLine);
        if (cachedPayload) {
            response.setHeader('Cache-Control', 'no-store');
            response.json(cachedPayload);
            return;
        }
        if (IS_RENDER_RUNTIME) {
            const payload = await getRenderLinePathsData(normalizedLine);
            setTimedCachedResponse(linePathsResponseCache, normalizedLine, payload, LINE_PATHS_RESPONSE_CACHE_TTL_MS);
            response.setHeader('Cache-Control', 'no-store');
            response.json(payload);
            return;
        }
        const staticData = await getLinePathsStaticData(normalizedLine);
        const payload = {
            fetchedAt: new Date().toISOString(),
            line: rawLine,
            paths: buildLinePaths(normalizedLine, staticData),
        };
        setTimedCachedResponse(linePathsResponseCache, normalizedLine, payload, LINE_PATHS_RESPONSE_CACHE_TTL_MS);
        response.setHeader('Cache-Control', 'no-store');
        response.json(payload);
    }
    catch (error) {
        next(error);
    }
});
async function configureFrontend() {
    if (isDevelopment) {
        const { createServer } = await import('vite');
        const vite = await createServer({
            root: projectRootDir,
            server: {
                middlewareMode: true,
            },
            appType: 'custom',
        });
        app.use(vite.middlewares);
        app.get(/^(?!\/api).*/, createDevelopmentAppHandler(vite));
        return;
    }
    if (existsSync(staticDistDir)) {
        app.use(express.static(staticDistDir));
        app.get(/^(?!\/api).*/, (_request, response) => {
            response.sendFile(path.join(staticDistDir, 'index.html'));
        });
    }
}
function createDevelopmentAppHandler(vite) {
    return async (request, response, next) => {
        try {
            const template = await readFile(sourceIndexHtmlPath, 'utf8');
            const html = await vite.transformIndexHtml(request.originalUrl, template);
            response
                .status(200)
                .setHeader('Content-Type', 'text/html')
                .send(html);
        }
        catch (error) {
            vite.ssrFixStacktrace(error);
            next(error);
        }
    };
}
async function startServer() {
    await configureFrontend();
    app.use((error, _request, response, next) => {
        void next;
        const message = error instanceof Error ? error.message : 'Unexpected server error';
        response.status(500).json({ error: message });
    });
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Transit server listening on http://0.0.0.0:${PORT}`);
    });
}
void startServer();
//# sourceMappingURL=index.js.map