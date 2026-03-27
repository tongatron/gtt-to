import { useEffect, useMemo, useRef } from 'react'
import { divIcon, latLng, latLngBounds, type DivIcon } from 'leaflet'
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet'
import type {
  ArrivalRecord,
  FocusLocation,
  LinePathRecord,
  LineVehicleRecord,
  StopRecord,
  StopServiceRecord,
  VehicleMode,
} from '../types'

const TURIN_CENTER: [number, number] = [45.0703, 7.6869]
const DEFAULT_ZOOM = 13
const FIT_PADDING: [number, number] = [44, 44]
const FOCUS_EMOJIS: Record<FocusLocation['kind'], string> = {
  user: '🧍',
  address: '📍',
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeBearing(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return ((value % 360) + 360) % 360
}

function formatPopupTime(value: string | null): string {
  if (!value) {
    return 'Aggiornamento non disponibile'
  }

  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatPopupSpeed(value: number | null): string {
  if (typeof value !== 'number') {
    return 'Velocita non disponibile'
  }

  return `${Math.round(value * 3.6)} km/h`
}

function formatPopupBearing(value: number | null): string {
  const bearing = normalizeBearing(value)
  if (bearing === null) {
    return 'Direzione non disponibile'
  }

  return `Direzione ${Math.round(bearing)}°`
}

function formatDistance(value?: number): string | null {
  if (typeof value !== 'number') {
    return null
  }

  if (value < 1000) {
    return `${Math.round(value)} m`
  }

  return `${(value / 1000).toFixed(1)} km`
}

function formatMinutesUntil(value: number): string {
  if (value <= 0) {
    return 'in arrivo'
  }

  if (value === 1) {
    return '1 min'
  }

  return `${value} min`
}

function formatDestinationPlace(value: string): string {
  const normalizedValue = value.replace(/\s+/g, ' ').trim()
  const commaParts = normalizedValue.split(/\s*,\s*/).filter(Boolean)
  const hyphenParts = normalizedValue.split(/\s+-\s+/).filter(Boolean)
  let destinationValue =
    (commaParts.length > 1 ? commaParts.at(-1) : null) ??
    (hyphenParts.length > 1 ? hyphenParts.at(-1) : null) ??
    normalizedValue

  destinationValue = destinationValue
    .replace(/^\d+\s*[A-Z0-9/.-]*\s*/i, '')
    .trim()

  if (!destinationValue) {
    destinationValue = normalizedValue
  }

  return destinationValue
    .split(/(\s+|\/|-)/)
    .map((chunk) => {
      if (chunk.trim().length === 0 || chunk === '/' || chunk === '-') {
        return chunk
      }

      if (/^[IVXLCDM]+$/i.test(chunk) || /\d/.test(chunk)) {
        return chunk.toUpperCase()
      }

      return `${chunk.charAt(0).toUpperCase()}${chunk.slice(1).toLowerCase()}`
    })
    .join('')
}

function formatDestinationLabel(value: string | null | undefined): string {
  const normalizedValue = value?.trim()
  return normalizedValue
    ? `Destinazione ${formatDestinationPlace(normalizedValue)}`
    : 'Destinazione non disponibile'
}

function buildStopServicesSummary(stop: StopRecord): string {
  const lines = Array.from(new Set(stop.services.map((service) => service.lineCode)))
  if (lines.length === 0) {
    return 'Linee non disponibili'
  }

  return lines.slice(0, 10).join(', ')
}

function buildSelectableStopServices(services: StopServiceRecord[]): StopServiceRecord[] {
  const byLineCode = new Map<string, StopServiceRecord>()

  services.forEach((service) => {
    if (!byLineCode.has(service.lineCode)) {
      byLineCode.set(service.lineCode, service)
    }
  })

  return Array.from(byLineCode.values()).sort((left, right) =>
    left.lineCode.localeCompare(right.lineCode, 'it', { numeric: true }),
  )
}

function adjustHexColor(hexColor: string, amount: number): string {
  const normalized = hexColor.replace('#', '')
  if (normalized.length !== 6) {
    return hexColor
  }

  const adjustChannel = (startIndex: number) => {
    const value = Number.parseInt(normalized.slice(startIndex, startIndex + 2), 16)
    const adjusted = Math.max(0, Math.min(255, value + amount))
    return adjusted.toString(16).padStart(2, '0')
  }

  return `#${adjustChannel(0)}${adjustChannel(2)}${adjustChannel(4)}`
}

function getDirectionAccent(
  routeColor: string | null,
  directionId: number | null | undefined,
): string {
  const baseColor = routeColor ?? '#0057b8'
  if (directionId === 1) {
    return adjustHexColor(baseColor, -42)
  }

  return adjustHexColor(baseColor, 8)
}

function normalizeDirectionLabel(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function resolveVehicleDirectionId(
  vehicle: LineVehicleRecord,
  paths: LinePathRecord[],
): number | null {
  const normalizedHeadsign = normalizeDirectionLabel(vehicle.headsign ?? vehicle.routeName)
  const matchingPath = paths.find(
    (path) => normalizeDirectionLabel(path.headsign) === normalizedHeadsign,
  )

  return matchingPath?.directionId ?? null
}

function getVehicleModeIcon(mode: VehicleMode): string {
  switch (mode) {
    case 'tram':
      return '🚋'
    case 'metro':
      return 'Ⓜ'
    case 'rail':
      return '🚆'
    case 'trolleybus':
      return '⚡'
    case 'bus':
      return '🚌'
    default:
      return '🚍'
  }
}

function createVehicleIcon(vehicle: LineVehicleRecord, accentColor?: string): DivIcon {
  const backgroundColor = accentColor ?? vehicle.routeColor ?? '#0057b8'
  const textColor = vehicle.routeTextColor ?? '#ffffff'
  const bearing = normalizeBearing(vehicle.bearing)
  const markerClasses = ['vehicle-marker-wrap']
  const modeIcon = getVehicleModeIcon(vehicle.mode)

  if (bearing !== null) {
    markerClasses.push('has-bearing')
  } else {
    markerClasses.push('is-static')
  }

  return divIcon({
    className: 'vehicle-marker-shell',
    iconSize: [54, 62],
    iconAnchor: [27, 31],
    popupAnchor: [0, -26],
    html: `
      <div
        class="${markerClasses.join(' ')}"
        style="--marker-accent:${escapeHtml(backgroundColor)};--bearing:${bearing ?? 0}deg;"
      >
        <span class="vehicle-direction-anchor" aria-hidden="true">
          <span class="vehicle-direction-arrow"></span>
        </span>
        <div
          class="vehicle-marker"
          style="color:${escapeHtml(backgroundColor)}"
        >
          <span class="vehicle-mode-glyph" aria-hidden="true">${escapeHtml(modeIcon)}</span>
        </div>
        <span class="vehicle-line-badge">${escapeHtml(vehicle.lineCode)}</span>
      </div>
    `,
  })
}

function createStopIcon(stopCode: string, isSelected: boolean): DivIcon {
  const classNames = ['stop-marker']

  if (isSelected) {
    classNames.push('is-selected')
  }

  return divIcon({
    className: 'stop-marker-shell',
    iconSize: [70, 34],
    iconAnchor: [35, 17],
    popupAnchor: [0, -10],
    html: `
      <div class="${classNames.join(' ')}">
        <span class="stop-marker-emoji" aria-hidden="true">🚏</span>
        <span>${escapeHtml(stopCode)}</span>
      </div>
    `,
  })
}

function createFocusIcon(kind: FocusLocation['kind']): DivIcon {
  const emoji = FOCUS_EMOJIS[kind]
  const label = kind === 'user' ? 'Posizione utente' : 'Indirizzo'

  return divIcon({
    className: 'focus-marker-shell',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -16],
    html: `
      <div class="focus-marker focus-marker-${kind}" aria-label="${label}">
        <span aria-hidden="true">${emoji}</span>
      </div>
    `,
  })
}

function createCombinedStopFocusIcon(
  stopCode: string,
  kind: FocusLocation['kind'],
  isSelected: boolean,
): DivIcon {
  const emoji = FOCUS_EMOJIS[kind]
  const stopClasses = ['stop-marker']

  if (isSelected) {
    stopClasses.push('is-selected')
  }

  return divIcon({
    className: 'combined-marker-shell',
    iconSize: [84, 52],
    iconAnchor: [42, 26],
    popupAnchor: [0, -16],
    html: `
      <div class="combined-stop-focus-marker">
        <div class="${stopClasses.join(' ')}">
          <span class="stop-marker-emoji" aria-hidden="true">🚏</span>
          <span>${escapeHtml(stopCode)}</span>
        </div>
        <div class="focus-marker focus-marker-${kind} combined-focus-badge" aria-hidden="true">
          <span>${emoji}</span>
        </div>
      </div>
    `,
  })
}

function createRouteArrowIcon(color: string, bearing: number): DivIcon {
  return divIcon({
    className: 'route-arrow-shell',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `
      <div
        class="route-arrow-marker"
        style="--route-color:${escapeHtml(color)};--route-bearing:${bearing}deg;"
      >
        <span class="route-arrow-glyph" aria-hidden="true"></span>
      </div>
    `,
  })
}

interface FitPoint {
  key: string
  latitude: number
  longitude: number
}

interface RouteArrowMarker {
  key: string
  latitude: number
  longitude: number
  bearing: number
  color: string
}

function calculatePathBearing(
  start: LinePathRecord['points'][number],
  end: LinePathRecord['points'][number],
): number {
  return ((Math.atan2(end.longitude - start.longitude, end.latitude - start.latitude) * 180) / Math.PI + 360) % 360
}

function interpolatePathPoint(
  start: LinePathRecord['points'][number],
  end: LinePathRecord['points'][number],
  ratio: number,
): { latitude: number; longitude: number } {
  return {
    latitude: start.latitude + (end.latitude - start.latitude) * ratio,
    longitude: start.longitude + (end.longitude - start.longitude) * ratio,
  }
}

function buildRouteArrowMarkers(path: LinePathRecord): RouteArrowMarker[] {
  const segments: Array<{
    start: LinePathRecord['points'][number]
    end: LinePathRecord['points'][number]
    length: number
  }> = []
  let totalLength = 0

  for (let index = 1; index < path.points.length; index += 1) {
    const start = path.points[index - 1]
    const end = path.points[index]
    if (!start || !end) {
      continue
    }

    const length = latLng(start.latitude, start.longitude).distanceTo(
      latLng(end.latitude, end.longitude),
    )

    if (length < 12) {
      continue
    }

    segments.push({ start, end, length })
    totalLength += length
  }

  if (segments.length === 0 || totalLength < 180) {
    return []
  }

  const fractions =
    totalLength < 1200 ? [0.5] : totalLength < 2800 ? [0.34, 0.68] : [0.24, 0.5, 0.76]
  const markers: RouteArrowMarker[] = []

  fractions.forEach((fraction, index) => {
    const targetLength = totalLength * fraction
    let walkedLength = 0

    for (const segment of segments) {
      const segmentEnd = walkedLength + segment.length
      if (segmentEnd < targetLength) {
        walkedLength = segmentEnd
        continue
      }

      const ratio = Math.min(
        1,
        Math.max(0, (targetLength - walkedLength) / segment.length),
      )
      const point = interpolatePathPoint(segment.start, segment.end, ratio)

      markers.push({
        key: `${path.pathId}:arrow:${index}`,
        latitude: point.latitude,
        longitude: point.longitude,
        bearing: calculatePathBearing(segment.start, segment.end),
        color: path.routeColor ?? '#17345e',
      })
      break
    }
  })

  return markers
}

function FitMapToFeatures({
  points,
}: {
  points: FitPoint[]
}) {
  const map = useMap()
  const lastBoundsKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (points.length === 0) {
      lastBoundsKeyRef.current = null
      map.setView(TURIN_CENTER, DEFAULT_ZOOM)
      return
    }

    const boundsKey = points
      .map((point) => `${point.key}:${point.latitude.toFixed(4)}:${point.longitude.toFixed(4)}`)
      .sort()
      .join('|')

    if (boundsKey === lastBoundsKeyRef.current) {
      return
    }

    lastBoundsKeyRef.current = boundsKey

    if (points.length === 1) {
      const [point] = points
      map.flyTo([point.latitude, point.longitude], 15, { duration: 0.65 })
      return
    }

    const bounds = latLngBounds(
      points.map((point) => [point.latitude, point.longitude] as [number, number]),
    )

    map.fitBounds(bounds, {
      padding: FIT_PADDING,
      maxZoom: 16,
      animate: true,
      duration: 0.65,
    })
  }, [map, points])

  return null
}

function RecenterToFocusLocation({
  focusLocation,
  requestVersion,
}: {
  focusLocation: FocusLocation | null
  requestVersion: number
}) {
  const map = useMap()
  const lastRequestRef = useRef(0)

  useEffect(() => {
    if (!focusLocation || requestVersion === 0 || requestVersion === lastRequestRef.current) {
      return
    }

    lastRequestRef.current = requestVersion
    map.flyTo([focusLocation.latitude, focusLocation.longitude], 15, {
      duration: 0.6,
    })
  }, [focusLocation, map, requestVersion])

  return null
}

interface StopPopupContentProps {
  stop: StopRecord
  isSelected: boolean
  activeLine: string | null
  selectedStopArrivals: ArrivalRecord[]
  loadingStopArrivals: boolean
  onSelectLine: (lineCode: string) => void
  onSelectStop: (stopCode: string) => void
}

function StopPopupContent({
  stop,
  activeLine,
  onSelectLine,
  onSelectStop,
}: StopPopupContentProps) {
  const distanceLabel = formatDistance(stop.distanceMeters)
  const selectableServices = buildSelectableStopServices(stop.services).filter((service) =>
    activeLine ? service.lineCode === activeLine : true,
  )
  const visibleLinesLabel = activeLine
    ? activeLine
    : buildStopServicesSummary(stop)

  return (
    <div className="popup-content">
      <strong>🚏 {stop.stopName}</strong>
      <span>Palina {stop.stopCode}</span>
      {distanceLabel ? <span>Distanza {distanceLabel}</span> : null}
      <span>Linea: {visibleLinesLabel}</span>

      {selectableServices.length > 0 ? (
        <div className="popup-line-grid">
          {selectableServices.map((service) => (
            <button
              key={`${stop.stopCode}:${service.lineCode}`}
              className={`popup-line-button${
                activeLine === service.lineCode ? ' is-active' : ''
              }`}
              type="button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelectStop(stop.stopCode)
                onSelectLine(service.lineCode)
              }}
            >
              {service.lineCode}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface MapViewProps {
  lineLabel: string | null
  vehicleMarkers: LineVehicleRecord[]
  linePaths: LinePathRecord[]
  focusLocation: FocusLocation | null
  nearbyStops: StopRecord[]
  showStops: boolean
  selectedStopCode: string | null
  selectedStop: StopRecord | null
  activeLine: string | null
  selectedStopArrivals: ArrivalRecord[]
  loadingStopArrivals: boolean
  recenterFocusRequest: number
  onSelectStop: (stopCode: string) => void
  onSelectLine: (lineCode: string) => void
}

export function MapView({
  lineLabel,
  vehicleMarkers,
  linePaths,
  focusLocation,
  nearbyStops,
  showStops,
  selectedStopCode,
  selectedStop,
  activeLine,
  selectedStopArrivals,
  loadingStopArrivals,
  recenterFocusRequest,
  onSelectStop,
  onSelectLine,
}: MapViewProps) {
  const combinedFocusStop = useMemo(() => {
    if (!focusLocation || !selectedStop) {
      return null
    }

    const distanceMeters = latLng(focusLocation.latitude, focusLocation.longitude).distanceTo(
      latLng(selectedStop.latitude, selectedStop.longitude),
    )

    if (distanceMeters > 22) {
      return null
    }

    return {
      latitude: selectedStop.latitude,
      longitude: selectedStop.longitude,
      focusLocation,
      stop: selectedStop,
    }
  }, [focusLocation, selectedStop])

  const sortedVehicles = useMemo(() => {
    return [...vehicleMarkers]
      .map((vehicle) => ({
        vehicle,
        directionId: resolveVehicleDirectionId(vehicle, linePaths),
      }))
      .sort((left, right) => {
        return (left.vehicle.vehicleLabel ?? left.vehicle.tripId).localeCompare(
          right.vehicle.vehicleLabel ?? right.vehicle.tripId,
          'it',
        )
      })
      .map(({ directionId, vehicle }) => ({
        ...vehicle,
        markerAccentColor: getDirectionAccent(vehicle.routeColor, directionId),
      }))
  }, [linePaths, vehicleMarkers])

  const renderedLinePaths = useMemo(
    () =>
      linePaths
        .map((path) => ({
          path,
          accentColor: getDirectionAccent(path.routeColor, path.directionId),
          positions: path.points.map(
            (point) => [point.latitude, point.longitude] as [number, number],
          ),
          arrows: buildRouteArrowMarkers({
            ...path,
            routeColor: getDirectionAccent(path.routeColor, path.directionId),
          }),
        }))
        .filter((path) => path.positions.length >= 2),
    [linePaths],
  )

  const visibleStops = useMemo(() => {
    if (activeLine && selectedStop) {
      return [selectedStop]
    }

    const selectedStops = selectedStop ? [selectedStop] : []

    if (showStops) {
      const allStops = [...nearbyStops, ...selectedStops]
      const seenStopCodes = new Set<string>()

      return allStops.filter((stop) => {
        if (seenStopCodes.has(stop.stopCode)) {
          return false
        }

        seenStopCodes.add(stop.stopCode)
        return true
      })
    }

    if (!selectedStop) {
      return []
    }

    return [selectedStop]
  }, [activeLine, nearbyStops, selectedStop, showStops])

  const fitPoints = useMemo<FitPoint[]>(() => {
    const points: FitPoint[] = []

    if (activeLine && selectedStop) {
      return [
        {
          key: `selected-stop:${selectedStop.stopCode}`,
          latitude: selectedStop.latitude,
          longitude: selectedStop.longitude,
        },
      ]
    }

    if (focusLocation && selectedStop) {
      return [
        {
          key: `focus:${focusLocation.kind}`,
          latitude: focusLocation.latitude,
          longitude: focusLocation.longitude,
        },
        {
          key: `selected-stop:${selectedStop.stopCode}`,
          latitude: selectedStop.latitude,
          longitude: selectedStop.longitude,
        },
      ]
    }

    if (focusLocation) {
      return [
        {
          key: `focus:${focusLocation.kind}`,
          latitude: focusLocation.latitude,
          longitude: focusLocation.longitude,
        },
      ]
    }

    if (selectedStop) {
      return [
        {
          key: `selected-stop:${selectedStop.stopCode}`,
          latitude: selectedStop.latitude,
          longitude: selectedStop.longitude,
        },
      ]
    }

    renderedLinePaths.forEach(({ path }) => {
      if (path.points.length === 0) {
        return
      }

      let minLatitude = path.points[0]!.latitude
      let maxLatitude = path.points[0]!.latitude
      let minLongitude = path.points[0]!.longitude
      let maxLongitude = path.points[0]!.longitude

      path.points.forEach((point) => {
        minLatitude = Math.min(minLatitude, point.latitude)
        maxLatitude = Math.max(maxLatitude, point.latitude)
        minLongitude = Math.min(minLongitude, point.longitude)
        maxLongitude = Math.max(maxLongitude, point.longitude)
      })

      points.push(
        {
          key: `${path.pathId}:nw`,
          latitude: maxLatitude,
          longitude: minLongitude,
        },
        {
          key: `${path.pathId}:se`,
          latitude: minLatitude,
          longitude: maxLongitude,
        },
      )
    })

    points.push(
      ...sortedVehicles.map((vehicle) => ({
        key: `vehicle:${vehicle.vehicleId ?? vehicle.tripId}`,
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
      })),
    )

    return points
  }, [activeLine, focusLocation, renderedLinePaths, selectedStop, sortedVehicles])

  return (
    <MapContainer
      center={TURIN_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom
      className="transit-map"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
      />

      <FitMapToFeatures points={fitPoints} />
      <RecenterToFocusLocation
        focusLocation={focusLocation?.kind === 'user' ? focusLocation : null}
        requestVersion={recenterFocusRequest}
      />

      {renderedLinePaths.map(({ path, positions, accentColor }) => (
        <Polyline
          key={path.pathId}
          positions={positions}
          pathOptions={{
            color: accentColor,
            weight: path.directionId === 1 ? 4 : 6,
            opacity: path.directionId === 1 ? 0.5 : 0.72,
            dashArray: path.directionId === 1 ? '10 9' : undefined,
          }}
        />
      ))}

      {renderedLinePaths.flatMap(({ arrows }) =>
        arrows.map((arrow) => (
          <Marker
            key={arrow.key}
            position={[arrow.latitude, arrow.longitude]}
            icon={createRouteArrowIcon(arrow.color, arrow.bearing)}
            zIndexOffset={360}
            interactive={false}
          />
        )),
      )}

      {focusLocation && !combinedFocusStop ? (
        <Marker
          position={[focusLocation.latitude, focusLocation.longitude]}
          icon={createFocusIcon(focusLocation.kind)}
          zIndexOffset={760}
        >
          <Popup>
            <div className="popup-content">
              <strong>
                {focusLocation.kind === 'user' ? '🧍 La tua posizione' : '📍 Indirizzo cercato'}
              </strong>
              <span>{focusLocation.label}</span>
            </div>
          </Popup>
        </Marker>
      ) : null}

      {combinedFocusStop ? (
        <Marker
          position={[combinedFocusStop.latitude, combinedFocusStop.longitude]}
          icon={createCombinedStopFocusIcon(
            combinedFocusStop.stop.stopCode,
            combinedFocusStop.focusLocation.kind,
            true,
          )}
          zIndexOffset={780}
        >
          <Popup>
            <div className="popup-content">
              <strong>🚏 {combinedFocusStop.stop.stopName}</strong>
              <span>Palina {combinedFocusStop.stop.stopCode}</span>
              <span>
                {combinedFocusStop.focusLocation.kind === 'user'
                  ? '🧍 La tua posizione coincide con la fermata'
                  : '📍 Punto cercato vicino alla fermata'}
              </span>
              <span>{combinedFocusStop.focusLocation.label}</span>
            </div>
          </Popup>
        </Marker>
      ) : null}

      {visibleStops.map((stop) => {
        const isSelected = stop.stopCode === selectedStopCode
        const shouldHideAsCombined =
          combinedFocusStop !== null && stop.stopCode === combinedFocusStop.stop.stopCode

        if (shouldHideAsCombined) {
          return null
        }

        return (
          <Marker
            key={stop.stopCode}
            position={[stop.latitude, stop.longitude]}
            icon={createStopIcon(stop.stopCode, isSelected)}
            zIndexOffset={isSelected ? 520 : 320}
            eventHandlers={{
              click: () => {
                onSelectStop(stop.stopCode)
              },
            }}
          >
            <Popup>
              <StopPopupContent
                stop={stop}
                isSelected={isSelected}
                activeLine={activeLine}
                selectedStopArrivals={isSelected ? selectedStopArrivals : []}
                loadingStopArrivals={isSelected && loadingStopArrivals}
                onSelectLine={onSelectLine}
                onSelectStop={onSelectStop}
              />
            </Popup>
          </Marker>
        )
      })}

      {sortedVehicles.map((vehicle) => (
        <Marker
          key={vehicle.vehicleId ?? vehicle.tripId}
          position={[vehicle.latitude, vehicle.longitude]}
          icon={createVehicleIcon(vehicle, vehicle.markerAccentColor)}
          zIndexOffset={700}
        >
          <Popup>
            <div className="popup-content">
              <strong>{vehicle.modeLabel} {vehicle.lineCode}</strong>
              <span>{formatDestinationLabel(vehicle.headsign ?? vehicle.routeName)}</span>
              <span>
                {vehicle.vehicleLabel ? `Mezzo ${vehicle.vehicleLabel}` : 'Veicolo GTT'}
              </span>
              <span>{formatPopupSpeed(vehicle.speedMetersPerSecond)}</span>
              <span>{formatPopupBearing(vehicle.bearing)}</span>
              <span>{formatPopupTime(vehicle.timestamp)}</span>
              {lineLabel ? <span>Linea richiesta: {lineLabel}</span> : null}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}
