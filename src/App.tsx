import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { MapView } from './components/MapView'
import type {
  AddressSearchResponse,
  ArrivalRecord,
  FocusLocation,
  LinePathRecord,
  LinePathsResponse,
  LineVehicleRecord,
  LineVehiclesResponse,
  NearbyStopsResponse,
  StopArrivalsResponse,
  StopRecord,
  StopServiceRecord,
} from './types'
import './App.css'

const POLL_INTERVAL_MS = 30_000
const DEFAULT_STOPS_RADIUS_METERS = 1400
const DEFAULT_STOPS_LIMIT = 20
const RECENT_SELECTIONS_STORAGE_KEY = 'gtt-to:recent-selections'
const MAX_RECENT_SELECTIONS = 3
const SIMULATION_STOP_CODE = '240'
const SIMULATION_LINE_CODE = '4'
const SIMULATION_UPDATE_INTERVAL_MS = 1_000

type EntryMode = 'location' | 'stop' | 'address' | 'simulation' | null

interface LineChoice {
  service: StopServiceRecord
  nextArrivalMinutes: number | null
  nextArrivalLabel: string
}

interface DirectionChoice {
  key: string
  label: string
}

interface StopSummaryLine {
  key: string
  lineCode: string
  destination: string
  directionKey: string
  times: string[]
}

interface WaitCardSummary {
  primary: ArrivalRecord | null
  next: string[]
}

interface RecentSelection {
  stopCode: string
  stopName: string
  lineCode: string
  latitude: number
  longitude: number
  savedAt: string
}

interface SimulationSeed {
  stop: StopRecord
  paths: LinePathRecord[]
}

function formatTime(value: string | null): string {
  if (!value) {
    return 'n/d'
  }

  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
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

function formatUpdatedAgo(value: string | null | undefined, nowMs: number): string {
  if (!value) {
    return 'aggiornamento n/d'
  }

  const diffInSeconds = Math.max(0, Math.round((nowMs - new Date(value).getTime()) / 1000))

  if (diffInSeconds < 60) {
    return `${diffInSeconds}s fa`
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60)
  return `${diffInMinutes} min fa`
}

function formatDistance(value?: number): string {
  if (typeof value !== 'number') {
    return 'distanza n/d'
  }

  if (value < 1000) {
    return `${Math.round(value)} m`
  }

  return `${(value / 1000).toFixed(1)} km`
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
    ? formatDestinationPlace(normalizedValue)
    : 'Destinazione non disponibile'
}

function normalizeDirectionKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function calculateBearing(
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number },
): number {
  return ((Math.atan2(end.longitude - start.longitude, end.latitude - start.latitude) * 180) / Math.PI + 360) % 360
}

function calculateSegmentDistanceMeters(
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number },
): number {
  const earthRadiusMeters = 6_371_000
  const toRadians = (value: number) => (value * Math.PI) / 180
  const deltaLatitude = toRadians(end.latitude - start.latitude)
  const deltaLongitude = toRadians(end.longitude - start.longitude)
  const startLatitude = toRadians(start.latitude)
  const endLatitude = toRadians(end.latitude)
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2)

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function interpolatePathPosition(path: LinePathRecord, progress: number): {
  latitude: number
  longitude: number
  bearing: number
} | null {
  if (path.points.length < 2) {
    return null
  }

  const normalizedProgress = Math.max(0, Math.min(0.999, progress))
  const segments: Array<{
    start: LinePathRecord['points'][number]
    end: LinePathRecord['points'][number]
    startDistance: number
    endDistance: number
  }> = []
  let totalDistance = 0

  for (let index = 1; index < path.points.length; index += 1) {
    const start = path.points[index - 1]
    const end = path.points[index]

    if (!start || !end) {
      continue
    }

    const segmentDistance = calculateSegmentDistanceMeters(start, end)
    if (segmentDistance <= 0) {
      continue
    }

    segments.push({
      start,
      end,
      startDistance: totalDistance,
      endDistance: totalDistance + segmentDistance,
    })
    totalDistance += segmentDistance
  }

  if (segments.length === 0 || totalDistance <= 0) {
    return null
  }

  const targetDistance = normalizedProgress * totalDistance
  const segment =
    segments.find((currentSegment) => targetDistance <= currentSegment.endDistance) ??
    segments[segments.length - 1]

  if (!segment) {
    return null
  }

  const segmentSpan = segment.endDistance - segment.startDistance
  const ratio =
    segmentSpan <= 0 ? 0 : (targetDistance - segment.startDistance) / segmentSpan

  return {
    latitude: segment.start.latitude + (segment.end.latitude - segment.start.latitude) * ratio,
    longitude: segment.start.longitude + (segment.end.longitude - segment.start.longitude) * ratio,
    bearing: calculateBearing(segment.start, segment.end),
  }
}

function buildSimulatedArrivals(
  stop: StopRecord,
  paths: LinePathRecord[],
  now: Date,
): ArrivalRecord[] {
  const directionPaths = paths.slice(0, 2)

  return directionPaths
    .flatMap((path, pathIndex) => {
      const headsign = path.headsign ?? `Direzione ${pathIndex + 1}`
      const minuteOffsets = pathIndex === 0 ? [5, 11, 15] : [7, 12, 14]

      return minuteOffsets.map((minutesUntil, arrivalIndex) => {
        const predictedDate = new Date(now.getTime() + minutesUntil * 60_000)
        const position = interpolatePathPosition(
          path,
          Math.max(0.05, 0.82 - arrivalIndex * 0.18 - pathIndex * 0.04),
        )

        return {
          tripId: `sim-arrival:${path.pathId}:${arrivalIndex}`,
          lineCode: SIMULATION_LINE_CODE,
          routeId: `${SIMULATION_LINE_CODE}:${path.directionId ?? pathIndex}`,
          routeName: `Linea ${SIMULATION_LINE_CODE}`,
          headsign,
          mode: 'tram',
          modeLabel: 'Tram',
          routeColor: path.routeColor ?? '#ffd900',
          routeTextColor: path.routeTextColor ?? '#16385e',
          scheduledArrival: predictedDate.toISOString(),
          predictedArrival: predictedDate.toISOString(),
          delaySeconds: 0,
          minutesUntil,
          vehicleId: `sim-vehicle:${path.pathId}:${arrivalIndex}`,
          vehicleLabel: `${SIMULATION_LINE_CODE}${pathIndex + 1}${arrivalIndex + 1}`,
          vehiclePosition: position
            ? {
                latitude: position.latitude,
                longitude: position.longitude,
                bearing: position.bearing,
                speedMetersPerSecond: 7,
                timestamp: now.toISOString(),
              }
            : null,
          realtime: true,
        }
      })
    })
    .sort((left, right) => left.minutesUntil - right.minutesUntil)
}

function buildSimulatedVehicles(paths: LinePathRecord[], now: Date): LineVehicleRecord[] {
  const directionPaths = paths.slice(0, 2)
  const phaseSeconds = now.getTime() / 1000

  return directionPaths.flatMap((path, pathIndex) => {
    const headsign = path.headsign ?? `Direzione ${pathIndex + 1}`
    const vehicleOffsets = pathIndex === 0 ? [0.18, 0.62] : [0.32, 0.78]

    return vehicleOffsets.flatMap((offset, vehicleIndex) => {
      const progress = (offset + phaseSeconds * 0.0013 + pathIndex * 0.08) % 1
      const position = interpolatePathPosition(path, progress)

      if (!position) {
        return []
      }

      return {
        tripId: `sim-trip:${path.pathId}:${vehicleIndex}`,
        vehicleId: `sim-vehicle:${path.pathId}:${vehicleIndex}`,
        vehicleLabel: `${SIMULATION_LINE_CODE}${pathIndex + 1}${vehicleIndex + 1}`,
        lineCode: SIMULATION_LINE_CODE,
        routeId: `${SIMULATION_LINE_CODE}:${path.directionId ?? pathIndex}`,
        routeName: `Linea ${SIMULATION_LINE_CODE}`,
        headsign,
        mode: 'tram',
        modeLabel: 'Tram',
        routeColor: path.routeColor ?? '#ffd900',
        routeTextColor: path.routeTextColor ?? '#16385e',
        latitude: position.latitude,
        longitude: position.longitude,
        bearing: position.bearing,
        speedMetersPerSecond: 7 + vehicleIndex,
        timestamp: now.toISOString(),
      }
    })
  })
}

function readRecentSelections(): RecentSelection[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const rawValue = window.localStorage.getItem(RECENT_SELECTIONS_STORAGE_KEY)
    if (!rawValue) {
      return []
    }

    const parsedValue = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsedValue)) {
      return []
    }

    return parsedValue
      .filter((item): item is RecentSelection => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof item.stopCode === 'string' &&
          typeof item.stopName === 'string' &&
          typeof item.lineCode === 'string' &&
          typeof item.latitude === 'number' &&
          typeof item.longitude === 'number' &&
          typeof item.savedAt === 'string'
        )
      })
      .slice(0, MAX_RECENT_SELECTIONS)
  } catch {
    return []
  }
}

function writeRecentSelections(selections: RecentSelection[]): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    RECENT_SELECTIONS_STORAGE_KEY,
    JSON.stringify(selections.slice(0, MAX_RECENT_SELECTIONS)),
  )
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

function buildLineChoices(
  services: StopServiceRecord[],
  arrivals: ArrivalRecord[],
): LineChoice[] {
  return buildSelectableStopServices(services)
    .map((service) => {
      const nextArrival = arrivals
        .filter((arrival) => arrival.lineCode === service.lineCode)
        .sort((left, right) => left.minutesUntil - right.minutesUntil)[0] ?? null

      return {
        service,
        nextArrivalMinutes: nextArrival?.minutesUntil ?? null,
        nextArrivalLabel: nextArrival
          ? formatMinutesUntil(nextArrival.minutesUntil)
          : 'nessun passaggio vicino',
      }
    })
    .sort((left, right) => {
      if (left.nextArrivalMinutes === null && right.nextArrivalMinutes === null) {
        return left.service.lineCode.localeCompare(right.service.lineCode, 'it', {
          numeric: true,
        })
      }

      if (left.nextArrivalMinutes === null) {
        return 1
      }

      if (right.nextArrivalMinutes === null) {
        return -1
      }

      if (left.nextArrivalMinutes !== right.nextArrivalMinutes) {
        return left.nextArrivalMinutes - right.nextArrivalMinutes
      }

      return left.service.lineCode.localeCompare(right.service.lineCode, 'it', {
        numeric: true,
      })
    })
}

function App() {
  const [entryMode, setEntryMode] = useState<EntryMode>(null)
  const [addressInput, setAddressInput] = useState('')
  const [stopCodeInput, setStopCodeInput] = useState('')
  const [focusLocation, setFocusLocation] = useState<FocusLocation | null>(null)
  const [nearbyStops, setNearbyStops] = useState<StopRecord[]>([])
  const [selectedStopCode, setSelectedStopCode] = useState<string | null>(null)
  const [selectedStopResponse, setSelectedStopResponse] =
    useState<StopArrivalsResponse | null>(null)
  const [selectedLine, setSelectedLine] = useState<string | null>(null)
  const [selectedDirectionKey, setSelectedDirectionKey] = useState<string | null>(null)
  const [vehiclesResponse, setVehiclesResponse] = useState<LineVehiclesResponse | null>(null)
  const [linePathsResponse, setLinePathsResponse] = useState<LinePathsResponse | null>(null)
  const [recentSelections, setRecentSelections] = useState<RecentSelection[]>([])
  const [simulationMode, setSimulationMode] = useState(false)
  const [simulationSeed, setSimulationSeed] = useState<SimulationSeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingLocation, setLoadingLocation] = useState(false)
  const [searchingAddress, setSearchingAddress] = useState(false)
  const [searchingStopCode, setSearchingStopCode] = useState(false)
  const [loadingStopArrivals, setLoadingStopArrivals] = useState(false)
  const [loadingVehicles, setLoadingVehicles] = useState(false)
  const [refreshingVehicles, setRefreshingVehicles] = useState(false)
  const [recenterFocusRequest, setRecenterFocusRequest] = useState(0)
  const [nowTickMs, setNowTickMs] = useState(() => Date.now())
  // Wait-first UI: keep the map optional until the user needs spatial context.
  const [isMapVisible, setIsMapVisible] = useState(false)

  const loadNearbyStops = useCallback(async (location: FocusLocation, signal?: AbortSignal) => {
    try {
      setError(null)

      const apiResponse = await fetch(
        `/api/stops/nearby?lat=${location.latitude}&lon=${location.longitude}&radius=${DEFAULT_STOPS_RADIUS_METERS}&limit=${DEFAULT_STOPS_LIMIT}`,
        { signal },
      )

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? `API responded with ${apiResponse.status}`)
      }

      const payload = (await apiResponse.json()) as NearbyStopsResponse

      startTransition(() => {
        setFocusLocation(location)
        setNearbyStops(payload.stops)
        setSelectedStopCode(null)
        setSelectedStopResponse(null)
        setSelectedLine(null)
        setSelectedDirectionKey(null)
        setVehiclesResponse(null)
        setLinePathsResponse(null)
      })

      return payload
    } catch (fetchError) {
      if ((fetchError as Error).name === 'AbortError') {
        return null
      }

      setError(
        fetchError instanceof Error
          ? fetchError.message
          : 'Impossibile caricare le fermate vicine.',
      )

      return null
    }
  }, [])

  const loadStopArrivals = useCallback(async (stopCode: string, signal?: AbortSignal) => {
    try {
      setError(null)
      setSelectedStopCode(stopCode)
      setLoadingStopArrivals(true)

      const apiResponse = await fetch(
        `/api/arrivals?stopCode=${encodeURIComponent(stopCode)}`,
        { signal },
      )

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? `API responded with ${apiResponse.status}`)
      }

      const payload = (await apiResponse.json()) as StopArrivalsResponse
      startTransition(() => {
        setSelectedStopResponse(payload)
      })

      return payload
    } catch (fetchError) {
      if ((fetchError as Error).name === 'AbortError') {
        return null
      }

      setError(
        fetchError instanceof Error
          ? fetchError.message
          : 'Impossibile caricare gli arrivi della fermata.',
      )

      return null
    } finally {
      setLoadingStopArrivals(false)
    }
  }, [])

  const loadVehicles = useCallback(async (
    line: string,
    options?: {
      signal?: AbortSignal
      refresh?: boolean
    },
  ) => {
    const normalizedLine = line.trim().toUpperCase()
    if (!normalizedLine) {
      return null
    }

    try {
      setError(null)
      if (options?.refresh) {
        setRefreshingVehicles(true)
      } else {
        setLoadingVehicles(true)
      }

      const apiResponse = await fetch(
        `/api/vehicles?line=${encodeURIComponent(normalizedLine)}`,
        { signal: options?.signal },
      )

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? `API responded with ${apiResponse.status}`)
      }

      const payload = (await apiResponse.json()) as LineVehiclesResponse
      startTransition(() => {
        setVehiclesResponse(payload)
      })

      return payload
    } catch (fetchError) {
      if ((fetchError as Error).name === 'AbortError') {
        return null
      }

      setError(
        fetchError instanceof Error
          ? fetchError.message
          : 'Impossibile caricare i mezzi della linea.',
      )

      return null
    } finally {
      setLoadingVehicles(false)
      setRefreshingVehicles(false)
    }
  }, [])

  const loadLinePaths = useCallback(async (line: string, signal?: AbortSignal) => {
    const normalizedLine = line.trim().toUpperCase()
    if (!normalizedLine) {
      setLinePathsResponse(null)
      return null
    }

    try {
      const apiResponse = await fetch(
        `/api/line-paths?line=${encodeURIComponent(normalizedLine)}`,
        { signal },
      )

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? `API responded with ${apiResponse.status}`)
      }

      const payload = (await apiResponse.json()) as LinePathsResponse
      startTransition(() => {
        setLinePathsResponse(payload)
      })

      return payload
    } catch (fetchError) {
      if ((fetchError as Error).name === 'AbortError') {
        return null
      }

      setLinePathsResponse(null)
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : 'Impossibile caricare il percorso della linea.',
      )

      return null
    }
  }, [])

  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocalizzazione non disponibile su questo browser.')
      return
    }

    setEntryMode('location')
    setLoadingLocation(true)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location: FocusLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          label: 'La tua posizione',
          kind: 'user',
        }

        setRecenterFocusRequest((value) => value + 1)
        void loadNearbyStops(location).finally(() => {
          setLoadingLocation(false)
        })
      },
      (geoError) => {
        setLoadingLocation(false)
        setError(`Geolocalizzazione non riuscita: ${geoError.message}`)
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 60_000,
      },
    )
  }, [loadNearbyStops])

  const handleAddressSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      const normalizedAddress = addressInput.trim()
      if (!normalizedAddress) {
        setError('Inserisci un indirizzo.')
        return
      }

      try {
        setEntryMode('address')
        setSearchingAddress(true)
        setError(null)

        const apiResponse = await fetch(
          `/api/geocode?address=${encodeURIComponent(normalizedAddress)}`,
        )

        if (!apiResponse.ok) {
          const payload = (await apiResponse.json().catch(() => null)) as
            | { error?: string }
            | null
          throw new Error(payload?.error ?? `API responded with ${apiResponse.status}`)
        }

        const payload = (await apiResponse.json()) as AddressSearchResponse
        const location: FocusLocation = {
          latitude: payload.latitude,
          longitude: payload.longitude,
          label: payload.displayName,
          kind: 'address',
        }

        await loadNearbyStops(location)
      } catch (fetchError) {
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : 'Impossibile geocodificare l’indirizzo.',
        )
      } finally {
        setSearchingAddress(false)
      }
    },
    [addressInput, loadNearbyStops],
  )

  const handleStopCodeSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      const normalizedStopCode = stopCodeInput.trim()
      if (!normalizedStopCode) {
        setError('Inserisci il numero fermata.')
        return
      }

      try {
        setEntryMode('stop')
        setSearchingStopCode(true)
        const payload = await loadStopArrivals(normalizedStopCode)

        if (!payload) {
          return
        }

        startTransition(() => {
          setNearbyStops([payload.stop])
          setFocusLocation({
            latitude: payload.stop.latitude,
            longitude: payload.stop.longitude,
            label: `${payload.stop.stopName} · fermata ${payload.stop.stopCode}`,
            kind: 'address',
          })
          setRecenterFocusRequest((value) => value + 1)
        })
      } finally {
        setSearchingStopCode(false)
      }
    },
    [loadStopArrivals, stopCodeInput],
  )

  const handleStopSelect = useCallback(
    (stopCode: string) => {
      void loadStopArrivals(stopCode)
    },
    [loadStopArrivals],
  )

  const handleLineSelect = useCallback(
    (lineCode: string) => {
      if (selectedLine === lineCode) {
        setSelectedLine(null)
        setSelectedDirectionKey(null)
        return
      }

      setSelectedLine(lineCode)
      setSelectedDirectionKey(null)
    },
    [selectedLine],
  )

  const handleLineDirectionSelect = useCallback(
    (lineCode: string, directionKey: string) => {
      if (selectedLine === lineCode && selectedDirectionKey === directionKey) {
        setSelectedLine(null)
        setSelectedDirectionKey(null)
        return
      }

      setSelectedLine(lineCode)
      setSelectedDirectionKey(directionKey)
    },
    [selectedDirectionKey, selectedLine],
  )

  const handleRecentSelection = useCallback(
    async (selection: RecentSelection) => {
      try {
        setError(null)
        setEntryMode('stop')
        setSelectedLine(selection.lineCode)
        setSelectedDirectionKey(null)
        setRecenterFocusRequest((value) => value + 1)

        const payload = await loadStopArrivals(selection.stopCode)
        if (!payload) {
          return
        }

        startTransition(() => {
          setNearbyStops([payload.stop])
          setFocusLocation({
            latitude: payload.stop.latitude,
            longitude: payload.stop.longitude,
            label: `${payload.stop.stopName} · fermata ${payload.stop.stopCode}`,
            kind: 'address',
          })
        })
      } catch {
        setError('Impossibile ripristinare la selezione recente.')
      }
    },
    [loadStopArrivals],
  )

  const handleResetFlow = useCallback(() => {
    setSimulationMode(false)
    setSimulationSeed(null)
    setEntryMode(null)
    setAddressInput('')
    setStopCodeInput('')
    setFocusLocation(null)
    setNearbyStops([])
    setSelectedStopCode(null)
    setSelectedStopResponse(null)
    setSelectedLine(null)
    setSelectedDirectionKey(null)
    setVehiclesResponse(null)
    setLinePathsResponse(null)
    setError(null)
    setRecenterFocusRequest(0)
  }, [])

  const handleStartSimulation = useCallback(async () => {
    try {
      setError(null)
      setSimulationMode(false)
      setSimulationSeed(null)
      setEntryMode('simulation')
      setSelectedLine(SIMULATION_LINE_CODE)
      setSelectedDirectionKey(null)

      const [stopResponse, linePaths] = await Promise.all([
        loadStopArrivals(SIMULATION_STOP_CODE),
        loadLinePaths(SIMULATION_LINE_CODE),
      ])

      if (!stopResponse || !linePaths) {
        return
      }

      startTransition(() => {
        setSimulationMode(true)
        setSimulationSeed({
          stop: stopResponse.stop,
          paths: linePaths.paths.filter((path) => path.lineCode === SIMULATION_LINE_CODE),
        })
        setNearbyStops([stopResponse.stop])
        setFocusLocation({
          latitude: stopResponse.stop.latitude,
          longitude: stopResponse.stop.longitude,
          label: 'Utente in simulazione alla fermata 240',
          kind: 'user',
        })
        setSelectedStopCode(stopResponse.stop.stopCode)
        setRecenterFocusRequest((value) => value + 1)
      })
    } catch {
      setError('Impossibile avviare la simulazione.')
    }
  }, [loadLinePaths, loadStopArrivals])

  useEffect(() => {
    setRecentSelections(readRecentSelections())
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTickMs(Date.now())
    }, 1_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (!simulationMode || !simulationSeed) {
      return
    }

    const updateSimulation = () => {
      const now = new Date()
      const simulatedArrivals = buildSimulatedArrivals(
        simulationSeed.stop,
        simulationSeed.paths,
        now,
      )
      const simulatedVehicles = buildSimulatedVehicles(simulationSeed.paths, now)

      startTransition(() => {
        setSelectedStopResponse({
          fetchedAt: now.toISOString(),
          feedTimestamp: now.toISOString(),
          stale: false,
          warnings: ['Simulazione attiva: dati live generati localmente.'],
          stop: simulationSeed.stop,
          relatedStops: [],
          arrivals: simulatedArrivals,
        })
        setVehiclesResponse({
          fetchedAt: now.toISOString(),
          feedTimestamp: now.toISOString(),
          stale: false,
          warnings: ['Simulazione attiva: mezzi in movimento generati localmente.'],
          line: SIMULATION_LINE_CODE,
          vehicles: simulatedVehicles,
        })
        setLinePathsResponse({
          fetchedAt: now.toISOString(),
          line: SIMULATION_LINE_CODE,
          paths: simulationSeed.paths,
        })
      })
    }

    updateSimulation()
    const intervalId = window.setInterval(updateSimulation, SIMULATION_UPDATE_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [simulationMode, simulationSeed])

  useEffect(() => {
    if (simulationMode) {
      return
    }

    const intervalId = window.setInterval(() => {
      if (selectedLine) {
        void loadVehicles(selectedLine, { refresh: true })
      }
    }, POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadVehicles, selectedLine, simulationMode])

  useEffect(() => {
    if (simulationMode) {
      return
    }

    if (!selectedStopCode) {
      return
    }

    const intervalId = window.setInterval(() => {
      void loadStopArrivals(selectedStopCode)
    }, POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadStopArrivals, selectedStopCode])

  const selectedStop = useMemo(() => {
    if (selectedStopResponse) {
      return selectedStopResponse.stop
    }

    if (!selectedStopCode) {
      return null
    }

    return nearbyStops.find((stop) => stop.stopCode === selectedStopCode) ?? null
  }, [nearbyStops, selectedStopCode, selectedStopResponse])

  const selectedStopArrivals = useMemo(
    () => selectedStopResponse?.arrivals.slice(0, 8) ?? [],
    [selectedStopResponse],
  )

  const stopWideArrivals = useMemo(
    () => selectedStopResponse?.arrivals.slice(0, 12) ?? [],
    [selectedStopResponse],
  )

  const lineChoices = useMemo(
    () => buildLineChoices(selectedStop?.services ?? [], selectedStopArrivals),
    [selectedStop, selectedStopArrivals],
  )

  const activeLineChoice = useMemo(
    () => lineChoices.find((choice) => choice.service.lineCode === selectedLine) ?? null,
    [lineChoices, selectedLine],
  )

  const upcomingStopLines = useMemo(() => {
    const seenLines = new Set<string>()

    return stopWideArrivals.filter((arrival) => {
      if (seenLines.has(arrival.lineCode)) {
        return false
      }

      seenLines.add(arrival.lineCode)
      return true
    }).slice(0, 6)
  }, [stopWideArrivals])

  const stopSummaryLines = useMemo<StopSummaryLine[]>(() => {
    const summaries = new Map<string, StopSummaryLine>()

    stopWideArrivals.forEach((arrival) => {
      const destination = formatDestinationLabel(arrival.headsign ?? arrival.routeName)
      const directionKey = normalizeDirectionKey(arrival.headsign ?? arrival.routeName)
      const key = `${arrival.lineCode}:${directionKey}`
      const timeLabel = formatTime(arrival.predictedArrival)
      const existingSummary = summaries.get(key)

      if (existingSummary) {
        if (!existingSummary.times.includes(timeLabel) && existingSummary.times.length < 3) {
          existingSummary.times.push(timeLabel)
        }
        return
      }

      summaries.set(key, {
        key,
        lineCode: arrival.lineCode,
        destination,
        directionKey,
        times: [timeLabel],
      })
    })

    return Array.from(summaries.values()).slice(0, 6)
  }, [stopWideArrivals])

  useEffect(() => {
    if (simulationMode) {
      return
    }

    if (selectedLine) {
      const abortController = new AbortController()
      void loadVehicles(selectedLine, { signal: abortController.signal })
      void loadLinePaths(selectedLine, abortController.signal)

      return () => {
        abortController.abort()
      }
    }

    setVehiclesResponse(null)
    setLinePathsResponse(null)
  }, [loadLinePaths, loadVehicles, selectedLine, simulationMode])

  const selectedLineArrivals = useMemo(() => {
    if (!selectedLine) {
      return []
    }

    const filteredArrivals = selectedStopArrivals.filter(
      (arrival) => arrival.lineCode === selectedLine,
    )

    if (!selectedDirectionKey) {
      return filteredArrivals.slice(0, 4)
    }

    const directionFilteredArrivals = filteredArrivals.filter(
      (arrival) =>
        normalizeDirectionKey(arrival.headsign ?? arrival.routeName) === selectedDirectionKey,
    )

    return (directionFilteredArrivals.length > 0 ? directionFilteredArrivals : filteredArrivals)
      .slice(0, 4)
  }, [selectedDirectionKey, selectedLine, selectedStopArrivals])

  const directionChoices = useMemo<DirectionChoice[]>(() => {
    if (!selectedLine) {
      return []
    }

    const byKey = new Map<string, DirectionChoice>()

    ;(linePathsResponse?.paths ?? [])
      .filter((path) => path.lineCode === selectedLine)
      .forEach((path) => {
        const label = formatDestinationLabel(path.headsign ?? selectedLine)
        const key = normalizeDirectionKey(path.headsign ?? selectedLine)
        if (!byKey.has(key)) {
          byKey.set(key, { key, label })
        }
      })

    selectedStopArrivals
      .filter((arrival) => arrival.lineCode === selectedLine)
      .forEach((arrival) => {
        const label = formatDestinationLabel(arrival.headsign ?? arrival.routeName)
        const key = normalizeDirectionKey(arrival.headsign ?? arrival.routeName)
        if (!byKey.has(key)) {
          byKey.set(key, { key, label })
        }
      })

    return Array.from(byKey.values())
  }, [linePathsResponse?.paths, selectedLine, selectedStopArrivals])

  useEffect(() => {
    if (directionChoices.length === 0) {
      setSelectedDirectionKey(null)
      return
    }

    if (
      selectedDirectionKey &&
      directionChoices.some((choice) => choice.key === selectedDirectionKey)
    ) {
      return
    }

    setSelectedDirectionKey(directionChoices[0]?.key ?? null)
  }, [directionChoices, selectedDirectionKey])

  const visibleVehicles = useMemo(() => {
    const vehicles = vehiclesResponse?.vehicles ?? []
    if (!selectedDirectionKey) {
      return vehicles
    }

    const directionFilteredVehicles = vehicles.filter(
      (vehicle) =>
        normalizeDirectionKey(vehicle.headsign ?? vehicle.routeName) === selectedDirectionKey,
    )

    return directionFilteredVehicles.length > 0 ? directionFilteredVehicles : vehicles
  }, [selectedDirectionKey, vehiclesResponse])

  const visibleLinePaths = useMemo(() => {
    const paths = linePathsResponse?.paths ?? []
    if (!selectedDirectionKey) {
      return paths
    }

    const directionFilteredPaths = paths.filter(
      (path) => normalizeDirectionKey(path.headsign ?? path.lineCode) === selectedDirectionKey,
    )

    return directionFilteredPaths.length > 0 ? directionFilteredPaths : paths
  }, [linePathsResponse, selectedDirectionKey])

  const activeDirectionChoice = useMemo(
    () => directionChoices.find((choice) => choice.key === selectedDirectionKey) ?? null,
    [directionChoices, selectedDirectionKey],
  )

  const directionActivity = useMemo(
    () =>
      directionChoices.map((choice) => {
        const arrivalsCount = selectedStopArrivals.filter(
          (arrival) =>
            arrival.lineCode === selectedLine &&
            normalizeDirectionKey(arrival.headsign ?? arrival.routeName) === choice.key,
        ).length
        const vehiclesCount = (vehiclesResponse?.vehicles ?? []).filter(
          (vehicle) =>
            normalizeDirectionKey(vehicle.headsign ?? vehicle.routeName) === choice.key,
        ).length

        return {
          ...choice,
          arrivalsCount,
          vehiclesCount,
        }
      }).filter((choice) => choice.arrivalsCount > 0 || choice.vehiclesCount > 0),
    [directionChoices, selectedLine, selectedStopArrivals, vehiclesResponse?.vehicles],
  )

  const lastUpdatedLabel = useMemo(
    () =>
      formatUpdatedAgo(
        selectedStopResponse?.feedTimestamp ?? selectedStopResponse?.fetchedAt ?? null,
        nowTickMs,
      ),
    [nowTickMs, selectedStopResponse?.feedTimestamp, selectedStopResponse?.fetchedAt],
  )

  useEffect(() => {
    if (!selectedStop || !selectedLine) {
      return
    }

    const nextEntry: RecentSelection = {
      stopCode: selectedStop.stopCode,
      stopName: selectedStop.stopName,
      lineCode: selectedLine,
      latitude: selectedStop.latitude,
      longitude: selectedStop.longitude,
      savedAt: new Date().toISOString(),
    }

    setRecentSelections((currentSelections) => {
      const dedupedSelections = currentSelections.filter(
        (item) =>
          !(item.stopCode === nextEntry.stopCode && item.lineCode === nextEntry.lineCode),
      )
      const nextSelections = [nextEntry, ...dedupedSelections].slice(0, MAX_RECENT_SELECTIONS)
      writeRecentSelections(nextSelections)
      return nextSelections
    })
  }, [selectedLine, selectedStop])

  useEffect(() => {
    setIsMapVisible(false)
  }, [selectedStopCode, selectedLine])

  const waitCardSummary = useMemo<WaitCardSummary>(() => {
    if (selectedLineArrivals.length === 0) {
      return {
        primary: null,
        next: [],
      }
    }

    return {
      primary: selectedLineArrivals[0] ?? null,
      next: selectedLineArrivals.slice(1, 3).map((arrival) => formatMinutesUntil(arrival.minutesUntil)),
    }
  }, [selectedLineArrivals])

  const summaryMessage = useMemo(() => {
    if (simulationMode) {
      return 'Simulazione attiva: fermata 240, linea 4, due direzioni e mezzi in movimento.'
    }

    if (!entryMode) {
      return 'Scegli come partire: posizione, numero fermata o indirizzo.'
    }

    if (!selectedStop) {
      if (entryMode === 'stop') {
        return 'Inserisci una palina GTT per andare subito alla fermata.'
      }

      return 'Scegli una fermata vicina per vedere i mezzi utili in attesa.'
    }

    if (!selectedLine) {
      return `Fermata ${selectedStop.stopCode} selezionata. Ora scegli una linea utile.`
    }

    if (loadingVehicles) {
      return `Caricamento mezzi live della linea ${selectedLine}...`
    }

    return `${visibleVehicles.length} mezzi live trovati per la linea ${selectedLine}.`
  }, [entryMode, loadingVehicles, selectedLine, selectedStop, simulationMode, visibleVehicles.length])

  return (
    <div className="app-shell simplified-shell">
      <section className="mobile-layout">
        <header className="mobile-card hero-mobile-card">
          <div className="hero-copy compact-hero-copy">
            <h1>GTT Radar</h1>
          </div>

          <div className="summary-strip">
            <span className="mode-badge">{summaryMessage}</span>
            {selectedStop ? (
              <span className="mode-badge">Fermata {selectedStop.stopCode}</span>
            ) : null}
            {selectedLine ? <span className="mode-badge">Linea {selectedLine}</span> : null}
            {simulationMode ? <span className="mode-badge">Demo attiva</span> : null}
          </div>

          <div className="entry-grid">
            {recentSelections.length > 0 ? (
              <div className="entry-form-card recent-selection-card">
                <strong>Riprendi da una selezione recente</strong>
                <span>Fino a 3 combinazioni salvate in cache sul dispositivo.</span>
                <div className="recent-selection-grid">
                  {recentSelections.map((selection) => (
                    <button
                      key={`${selection.stopCode}:${selection.lineCode}`}
                      className="line-choice-button recent-selection-button"
                      type="button"
                      onClick={() => void handleRecentSelection(selection)}
                    >
                      <strong>Linea {selection.lineCode}</strong>
                      <span>{selection.stopName}</span>
                      <span>Fermata {selection.stopCode}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <button
              className={`entry-button${entryMode === 'location' ? ' is-active' : ''}`}
              type="button"
              onClick={handleUseMyLocation}
              disabled={loadingLocation}
            >
              <strong>{loadingLocation ? 'Localizzo...' : 'Usa la mia posizione'}</strong>
              <span>Ti mostra sulla mappa e carica le fermate vicine.</span>
            </button>

            <button
              className={`entry-button${entryMode === 'simulation' ? ' is-active' : ''}`}
              type="button"
              onClick={() => {
                void handleStartSimulation()
              }}
            >
              <strong>Modalita simulazione</strong>
              <span>Utente alla fermata 240 con linea 4 e mezzi simulati in movimento.</span>
            </button>

            <form
              className={`entry-form-card${entryMode === 'stop' ? ' is-active' : ''}`}
              onSubmit={handleStopCodeSubmit}
            >
              <label className="search-field">
                <span>Numero fermata</span>
                <input
                  type="search"
                  inputMode="numeric"
                  value={stopCodeInput}
                  placeholder="Es. 1234"
                  onChange={(event) => setStopCodeInput(event.target.value)}
                />
              </label>

              <button className="secondary-button" type="submit" disabled={searchingStopCode}>
                {searchingStopCode ? 'Cerco...' : 'Vai alla fermata'}
              </button>
            </form>

            <form
              className={`entry-form-card${entryMode === 'address' ? ' is-active' : ''}`}
              onSubmit={handleAddressSubmit}
            >
              <label className="search-field">
                <span>Indirizzo</span>
                <input
                  type="search"
                  value={addressInput}
                  placeholder="Es. Via Po 17"
                  onChange={(event) => setAddressInput(event.target.value)}
                />
              </label>

              <button className="secondary-button" type="submit" disabled={searchingAddress}>
                {searchingAddress ? 'Cerco...' : 'Trova fermate vicine'}
              </button>
            </form>
          </div>

          <div className="flow-actions">
            <button className="ghost-button" type="button" onClick={handleResetFlow}>
              Riparti da zero
            </button>
            {focusLocation?.kind === 'user' ? (
              <button
                className="ghost-button"
                type="button"
                onClick={() => setRecenterFocusRequest((value) => value + 1)}
              >
                Torna alla mia posizione
              </button>
            ) : null}
          </div>

          {error ? <p className="error-box">{error}</p> : null}
        </header>

        <section className="mobile-card mobile-map-card">
          <div className="map-panel-header compact-map-header">
            <div>
              <p className="map-label">Mappa attesa</p>
              <h2>
                {selectedLine
                  ? `Linea ${selectedLine} verso la fermata`
                  : selectedStop
                    ? `Fermata ${selectedStop.stopCode}`
                    : 'Scegli come vuoi partire'}
              </h2>
            </div>
            {selectedStop ? (
              <span className="live-update-badge">
                <span className="live-update-dot" aria-hidden="true"></span>
                LIVE
              </span>
            ) : null}
          </div>

          {selectedStop ? (
            <div className="stop-summary-card">
              <p className="stop-summary-title">
                Fermata: <strong>{selectedStop.stopCode}</strong> -{' '}
                <strong>{selectedStop.stopName}</strong>
              </p>
              {stopSummaryLines.length > 0 ? (
                <div className="stop-summary-list">
                  {stopSummaryLines.map((summary) => (
                    <button
                      key={summary.key}
                      className={`stop-summary-item${
                        selectedLine === summary.lineCode &&
                        selectedDirectionKey === summary.directionKey
                          ? ' is-active'
                          : ''
                      }`}
                      type="button"
                      onClick={() =>
                        handleLineDirectionSelect(summary.lineCode, summary.directionKey)
                      }
                    >
                      <div className="stop-summary-line">
                        <strong>Linea {summary.lineCode}</strong>
                        <span>{summary.destination}</span>
                      </div>
                      <p className="stop-summary-times">
                        Orario: {summary.times.join(' ')}
                      </p>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {selectedStop && upcomingStopLines.length > 0 ? (
            <div className="map-line-strip">
              {upcomingStopLines.map((arrival) => (
                <button
                  key={`${arrival.lineCode}:${arrival.tripId}`}
                  className={`vehicle-line-pill map-line-pill-button${
                    selectedLine === arrival.lineCode ? ' is-active' : ''
                  }`}
                  type="button"
                  onClick={() => handleLineSelect(arrival.lineCode)}
                >
                  {arrival.lineCode}
                </button>
              ))}
            </div>
          ) : null}

          {selectedStop ? (
            <div className="map-wait-panel">
              {!selectedLine ? (
                <div className="map-detail-section">
                  <div className="section-head">
                    <p className="eyebrow">Scegli linea e direzione</p>
                  </div>
                  {stopSummaryLines.length > 0 ? (
                    <div className="wait-choice-list">
                      {stopSummaryLines.map((summary) => (
                        <button
                          key={summary.key}
                          className="wait-choice-card"
                          type="button"
                          onClick={() =>
                            handleLineDirectionSelect(summary.lineCode, summary.directionKey)
                          }
                        >
                          <div className="wait-choice-head">
                            <strong>Linea {summary.lineCode}</strong>
                            <span>{summary.destination}</span>
                          </div>
                          <p className="wait-choice-meta">
                            {summary.times[0] ? formatMinutesUntil(
                              stopWideArrivals.find((arrival) => arrival.lineCode === summary.lineCode && normalizeDirectionKey(arrival.headsign ?? arrival.routeName) === summary.directionKey)?.minutesUntil ?? 0,
                            ) : 'n/d'}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state">Nessun passaggio disponibile per questa fermata.</p>
                  )}
                </div>
              ) : null}

              {selectedLine ? (
                <div className="wait-primary-card">
                  <p className="eyebrow">Attesa</p>
                  <div className="wait-primary-head">
                    <div>
                      <strong>Linea {selectedLine}</strong>
                      <span>
                        {activeDirectionChoice?.label ?? 'Direzione non disponibile'}
                      </span>
                    </div>
                    <span className="wait-primary-minutes">
                      {waitCardSummary.primary
                        ? formatMinutesUntil(waitCardSummary.primary.minutesUntil)
                        : 'n/d'}
                    </span>
                  </div>
                  <p className="wait-primary-followups">
                    {waitCardSummary.next.length > 0
                      ? `Poi ${waitCardSummary.next.join(' · ')}`
                      : 'Nessun altro passaggio imminente'}
                  </p>
                </div>
              ) : null}

              {selectedLine ? (
                <div className="wait-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSelectedLine(null)
                      setSelectedDirectionKey(null)
                    }}
                  >
                    Cambia linea
                  </button>
                  {directionActivity.length > 1 ? (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setSelectedLine(null)}
                    >
                      Cambia direzione
                    </button>
                  ) : null}
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSelectedStopCode(null)
                      setSelectedStopResponse(null)
                      setSelectedLine(null)
                      setSelectedDirectionKey(null)
                    }}
                  >
                    Cambia fermata
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setIsMapVisible((value) => !value)}
                  >
                    {isMapVisible ? 'Nascondi mappa' : 'Mostra mappa'}
                  </button>
                </div>
              ) : null}

              {selectedLine && directionActivity.length > 1 ? (
                <div className="map-detail-section">
                  <p className="eyebrow">Direzione selezionata</p>
                  <div className="line-choice-grid direction-switch-grid">
                    {directionActivity.map((choice) => (
                      <button
                        key={choice.key}
                        className={`line-choice-button${
                          selectedDirectionKey === choice.key ? ' is-active' : ''
                        }`}
                        type="button"
                        onClick={() => setSelectedDirectionKey(choice.key)}
                      >
                        <strong>Direzione</strong>
                        <span>{choice.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedLine && directionActivity.length > 0 ? (
                <div className="map-detail-section">
                  <p className="eyebrow">Direzioni attive adesso</p>
                  <div className="direction-activity-list">
                    {directionActivity.map((choice) => (
                      <button
                        key={choice.key}
                        className={`direction-activity-card${
                          selectedDirectionKey === choice.key ? ' is-active' : ''
                        }`}
                        type="button"
                        onClick={() => setSelectedDirectionKey(choice.key)}
                      >
                        <strong>{choice.label}</strong>
                        <span>
                          {choice.arrivalsCount} arrivi · {choice.vehiclesCount} mezzi live
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedLine && isMapVisible ? (
                <div className="map-frame mobile-map-frame">
                  <MapView
                    lineLabel={selectedLine}
                    vehicleMarkers={visibleVehicles}
                    linePaths={visibleLinePaths}
                    focusLocation={focusLocation}
                    nearbyStops={nearbyStops}
                    showStops={nearbyStops.length > 0}
                    selectedStopCode={selectedStopCode}
                    selectedStop={selectedStop}
                    activeLine={selectedLine}
                    selectedStopArrivals={selectedStopArrivals}
                    loadingStopArrivals={loadingStopArrivals}
                    recenterFocusRequest={recenterFocusRequest}
                    onSelectStop={handleStopSelect}
                    onSelectLine={handleLineSelect}
                  />
                </div>
              ) : null}

              {selectedLine ? (
                <div className="map-detail-section">
                  <div className="section-head">
                    <p className="eyebrow">Altre linee in fermata</p>
                  </div>
                  <div className="map-line-strip">
                    {upcomingStopLines
                      .filter((arrival) => arrival.lineCode !== selectedLine)
                      .map((arrival) => (
                        <button
                          key={`other:${arrival.lineCode}:${arrival.tripId}`}
                          className="vehicle-line-pill map-line-pill-button"
                          type="button"
                          onClick={() => handleLineSelect(arrival.lineCode)}
                        >
                          {arrival.lineCode}
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}

              {selectedLine ? (
                <div className="map-detail-section">
                  <div className="section-head">
                    <p className="eyebrow">Arrivi in ordine di attesa</p>
                  </div>
                  {selectedLineArrivals.length > 0 ? (
                    <ul className="arrival-list mobile-arrival-list">
                      {selectedLineArrivals.map((arrival) => (
                        <li key={`${arrival.tripId}:${arrival.predictedArrival}`}>
                          <article className="arrival-row mobile-arrival-row">
                            <span
                              className="vehicle-line-pill"
                              style={{
                                backgroundColor: arrival.routeColor ?? undefined,
                                color: arrival.routeTextColor ?? undefined,
                              }}
                            >
                              {arrival.lineCode}
                            </span>

                            <span className="vehicle-row-copy">
                              <strong>
                                {formatDestinationLabel(arrival.headsign ?? arrival.routeName)}
                              </strong>
                              <span>{formatTime(arrival.predictedArrival)}</span>
                            </span>

                            <span className="arrival-meta">
                              <strong>{formatMinutesUntil(arrival.minutesUntil)}</strong>
                            </span>
                          </article>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="empty-state">
                      Nessun arrivo imminente disponibile per la linea selezionata.
                    </p>
                  )}
                </div>
              ) : null}

            </div>
          ) : null}
        </section>

      </section>
    </div>
  )
}

export default App
