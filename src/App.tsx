import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
type InstallPromptKind = 'chromium' | 'ios' | 'macos-safari'

type EntryMode = 'location' | 'stop' | 'address' | null

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
  minutes: number[]
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

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[]
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
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

function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches
  )
}

function detectInstallPromptKind(): InstallPromptKind | null {
  if (typeof window === 'undefined') {
    return null
  }

  const standalone = isStandaloneDisplayMode() || (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (standalone) {
    return null
  }

  const userAgent = navigator.userAgent
  const isIOS =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isSafari = /Safari/i.test(userAgent) && !/Chrome|CriOS|Edg|OPR|Firefox|FxiOS|SamsungBrowser/i.test(userAgent)
  const isMac = /Mac/i.test(navigator.platform) && navigator.maxTouchPoints < 2

  if (isIOS && isSafari) {
    return 'ios'
  }

  if (isMac && isSafari) {
    return 'macos-safari'
  }

  return null
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
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null)
  const [installPromptKind, setInstallPromptKind] = useState<InstallPromptKind | null>(null)
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingLocation, setLoadingLocation] = useState(false)
  const [searchingAddress, setSearchingAddress] = useState(false)
  const [searchingStopCode, setSearchingStopCode] = useState(false)
  const [showAddressSearch, setShowAddressSearch] = useState(false)
  const [loadingStopArrivals, setLoadingStopArrivals] = useState(false)
  const [loadingVehicles, setLoadingVehicles] = useState(false)
  const [refreshingVehicles, setRefreshingVehicles] = useState(false)
  const [recenterFocusRequest, setRecenterFocusRequest] = useState(0)
  const [nowTickMs, setNowTickMs] = useState(() => Date.now())
  const waitSectionRef = useRef<HTMLElement | null>(null)
  const lastScrolledWaitKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const refreshInstallPrompt = () => {
      if (deferredInstallPrompt) {
        setInstallPromptKind(isStandaloneDisplayMode() ? null : 'chromium')
        return
      }

      setInstallPromptKind(detectInstallPromptKind())
    }

    refreshInstallPrompt()

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent)
      setInstallPromptKind(isStandaloneDisplayMode() ? null : 'chromium')
      setInstallPromptDismissed(false)
    }

    const handleInstalled = () => {
      setDeferredInstallPrompt(null)
      setInstallPromptKind(null)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [deferredInstallPrompt])

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

    const requestPosition = (options: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, options)
      })

    const requestWatchedPosition = (options: PositionOptions, timeoutMs: number) =>
      new Promise<GeolocationPosition>((resolve, reject) => {
        let settled = false
        const timeoutId = window.setTimeout(() => {
          if (settled) {
            return
          }

          settled = true
          navigator.geolocation.clearWatch(watchId)
          reject(
            new DOMException(
              'Tempo scaduto durante la geolocalizzazione.',
              'TimeoutError',
            ),
          )
        }, timeoutMs)

        const watchId = navigator.geolocation.watchPosition(
          (position) => {
            if (settled) {
              return
            }

            settled = true
            window.clearTimeout(timeoutId)
            navigator.geolocation.clearWatch(watchId)
            resolve(position)
          },
          (error) => {
            if (settled) {
              return
            }

            settled = true
            window.clearTimeout(timeoutId)
            navigator.geolocation.clearWatch(watchId)
            reject(error)
          },
          options,
        )
      })

    void (async () => {
      try {
        setError(null)

        let position: GeolocationPosition

        try {
          position = await requestPosition({
            enableHighAccuracy: false,
            timeout: 8_000,
            maximumAge: 10 * 60_000,
          })
        } catch (geoError) {
          const geolocationError = geoError as GeolocationPositionError | DOMException
          const isRetryable =
            geolocationError instanceof DOMException ||
            geolocationError.code === geolocationError.TIMEOUT ||
            geolocationError.code === geolocationError.POSITION_UNAVAILABLE

          if (!isRetryable) {
            throw geolocationError
          }

          try {
            position = await requestPosition({
              enableHighAccuracy: false,
              timeout: 15_000,
              maximumAge: 0,
            })
          } catch (fallbackError) {
            const nextError = fallbackError as GeolocationPositionError | DOMException
            const canUseWatchFallback =
              nextError instanceof DOMException ||
              nextError.code === nextError.TIMEOUT ||
              nextError.code === nextError.POSITION_UNAVAILABLE

            if (!canUseWatchFallback) {
              throw nextError
            }

            position = await requestWatchedPosition(
              {
                enableHighAccuracy: false,
                maximumAge: 0,
              },
              20_000,
            )
          }
        }

        const location: FocusLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          label: 'La tua posizione',
          kind: 'user',
        }

        setRecenterFocusRequest((value) => value + 1)
        await loadNearbyStops(location)
      } catch (geoError) {
        const geolocationError = geoError as GeolocationPositionError | DOMException
        const errorMessage =
          geolocationError instanceof DOMException
            ? 'Nessuna posizione disponibile dal browser. Su Mac controlla anche i servizi di localizzazione di sistema e riprova.'
            : geolocationError.code === geolocationError.PERMISSION_DENIED
              ? 'Permesso negato dal browser o da macOS.'
              : `Geolocalizzazione non riuscita: ${geolocationError.message}`

        setError(errorMessage)
      } finally {
        setLoadingLocation(false)
      }
    })()
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
        setSelectedLine(null)
        setSelectedDirectionKey(null)
        setVehiclesResponse(null)
        setLinePathsResponse(null)
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
      setSelectedLine(null)
      setSelectedDirectionKey(null)
      setVehiclesResponse(null)
      setLinePathsResponse(null)
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
    const intervalId = window.setInterval(() => {
      if (selectedLine) {
        void loadVehicles(selectedLine, { refresh: true })
      }
    }, POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadVehicles, selectedLine])

  useEffect(() => {
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
      const existingSummary = summaries.get(key)

      if (existingSummary) {
        if (
          !existingSummary.minutes.includes(arrival.minutesUntil) &&
          existingSummary.minutes.length < 3
        ) {
          existingSummary.minutes.push(arrival.minutesUntil)
        }
        return
      }

      summaries.set(key, {
        key,
        lineCode: arrival.lineCode,
        destination,
        directionKey,
        minutes: [arrival.minutesUntil],
      })
    })

    return Array.from(summaries.values()).slice(0, 6)
  }, [stopWideArrivals])

  useEffect(() => {
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
  }, [loadLinePaths, loadVehicles, selectedLine])

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

  const extraLiveVehiclesCount = useMemo(() => {
    if (!selectedLine) {
      return 0
    }

    return Math.max(0, visibleVehicles.length - selectedLineArrivals.length)
  }, [selectedLine, selectedLineArrivals.length, visibleVehicles.length])

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
    if (!selectedStopCode) {
      return
    }

    const nextWaitKey = `${selectedStopCode}:${selectedLine ?? ''}`
    if (lastScrolledWaitKeyRef.current === nextWaitKey) {
      return
    }

    lastScrolledWaitKeyRef.current = nextWaitKey
    const frameId = window.requestAnimationFrame(() => {
      waitSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [selectedLine, selectedStopCode])

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

  const shouldShowMapSection = Boolean(
    !selectedStop &&
      nearbyStops.length > 0 &&
      (focusLocation?.kind === 'address' || focusLocation?.kind === 'user'),
  )

  const canShowInstallPrompt = Boolean(installPromptKind && !installPromptDismissed)

  const handleInstallApp = useCallback(async () => {
    if (!deferredInstallPrompt) {
      return
    }

    try {
      await deferredInstallPrompt.prompt()
      const choice = await deferredInstallPrompt.userChoice
      if (choice.outcome === 'dismissed') {
        setInstallPromptDismissed(true)
      }
    } finally {
      setDeferredInstallPrompt(null)
      if (!isStandaloneDisplayMode()) {
        setInstallPromptKind(detectInstallPromptKind())
      }
    }
  }, [deferredInstallPrompt])

  return (
    <div className="app-shell simplified-shell">
      <section className="mobile-layout">
        <header className="mobile-card hero-mobile-card">
          <div className="home-topbar">
            <div className="hero-copy compact-hero-copy">
              <h1>GTT Radar</h1>
            </div>
          </div>

          {canShowInstallPrompt ? (
            <div className="install-prompt-banner" role="status">
              <div className="install-prompt-copy">
                <strong>Installa GTT Radar</strong>
                <span>
                  {installPromptKind === 'chromium'
                    ? 'Aggiungi l’app alla schermata home o al desktop per aprirla più velocemente.'
                    : installPromptKind === 'ios'
                      ? 'Su iPhone o iPad apri Safari, tocca Condividi e scegli Aggiungi a Home.'
                      : 'Su Safari per Mac usa File e poi Aggiungi al Dock per installare la web app.'}
                </span>
              </div>
              <div className="install-prompt-actions">
                {installPromptKind === 'chromium' ? (
                  <button
                    className="secondary-button install-prompt-button"
                    type="button"
                    onClick={() => void handleInstallApp()}
                  >
                    Installa app
                  </button>
                ) : null}
                <button
                  className="ghost-button install-prompt-dismiss"
                  type="button"
                  onClick={() => setInstallPromptDismissed(true)}
                  aria-label="Chiudi suggerimento installazione"
                >
                  ✕
                </button>
              </div>
            </div>
          ) : null}

          <div className="entry-grid">
            {recentSelections.length > 0 ? (
              <div className="recent-selection-card compact-recent-card">
                <div className="compact-recent-row">
                  <strong>Recenti</strong>
                  <div className="compact-recent-list">
                    {recentSelections.map((selection) => (
                      <button
                        key={`${selection.stopCode}:${selection.lineCode}`}
                        className="recent-selection-button compact-recent-button"
                        type="button"
                        onClick={() => void handleRecentSelection(selection)}
                      >
                        <span>Fermata {selection.stopCode}</span>
                        <span>&middot;</span>
                        <span>Linea {selection.lineCode}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            <form
              className={`entry-form-card compact-entry-form primary-stop-form${entryMode === 'stop' ? ' is-active' : ''}`}
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

              <button
                className="secondary-button primary-stop-submit"
                type="submit"
                disabled={searchingStopCode}
              >
                {searchingStopCode ? 'Cerco...' : 'Vai alla fermata'}
              </button>
            </form>

            <div className="secondary-entry-row">
              <button
                className={`entry-button location-entry-button${entryMode === 'location' ? ' is-active' : ''}`}
                type="button"
                onClick={handleUseMyLocation}
                disabled={loadingLocation}
                aria-label={loadingLocation ? 'Localizzo' : 'Usa la mia posizione'}
                title={loadingLocation ? 'Localizzo...' : 'Usa la mia posizione'}
              >
                <span className="location-entry-icon" aria-hidden="true">
                  ◎
                </span>
                <strong>{loadingLocation ? 'Localizzo…' : 'Localizzazione'}</strong>
              </button>

              {showAddressSearch ? (
                <form
                  className={`entry-form-card compact-entry-form compact-address-form${entryMode === 'address' ? ' is-active' : ''}`}
                  onSubmit={handleAddressSubmit}
                >
                  <label className="search-field">
                    <span>Cerca fermata</span>
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
              ) : (
                <button
                  className={`entry-button address-entry-button${entryMode === 'address' ? ' is-active' : ''}`}
                  type="button"
                  onClick={() => setShowAddressSearch(true)}
                >
                  <span className="address-entry-icon" aria-hidden="true">
                    ⌕
                  </span>
                  <strong>Cerca fermata</strong>
                </button>
              )}
            </div>
          </div>

          {error ? <p className="error-box">{error}</p> : null}
        </header>

        {selectedStop ? (
        <section ref={waitSectionRef} className="mobile-card mobile-map-card">
          <div className="map-panel-header compact-map-header">
            <div>
              <h2>{`Fermata: ${selectedStop.stopCode} - ${selectedStop.stopName}`}</h2>
            </div>
            <span className="live-update-badge">
              <span className="live-update-dot" aria-hidden="true"></span>
              LIVE
            </span>
          </div>

          <div className="stop-summary-card">
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
                      <div className="stop-summary-route">
                        <strong>Linea {summary.lineCode}</strong>
                        <span>&rarr; {summary.destination}</span>
                      </div>
                      <div className="stop-summary-upcoming">
                        <small>Attesa</small>
                        <div className="stop-summary-minute-list">
                          {summary.minutes.map((value) => (
                            <span key={`${summary.key}:${value}`}>{formatMinutesUntil(value)}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty-state">nessuna previsione live</p>
            )}

            {selectedLine && extraLiveVehiclesCount > 0 ? (
              <p className="extra-live-note">
                Altri {extraLiveVehiclesCount} mezzi live sulla mappa, senza previsione di arrivo
              </p>
            ) : null}
          </div>
        </section>
        ) : null}

        {shouldShowMapSection ? (
        <section ref={waitSectionRef} className="mobile-card mobile-map-card">
          <div className="map-panel-header compact-map-header">
            <div>
              <h2>
                {focusLocation?.kind === 'user'
                  ? 'Fermate vicine alla tua posizione'
                  : 'Fermate vicine all’indirizzo'}
              </h2>
            </div>
            {focusLocation?.kind === 'address' || focusLocation?.kind === 'user' ? (
              <span className="live-update-badge">
                <span className="live-update-dot" aria-hidden="true"></span>
                LIVE
              </span>
            ) : null}
          </div>

          {!selectedStop ? (
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
        </section>
        ) : null}

      </section>

      <a
        className="tongatron-link footer-tongatron-link"
        href="https://tongatron.github.io"
        target="_blank"
        rel="noreferrer"
        aria-label="Apri tongatron.github.io"
        title="Apri tongatron.github.io"
      >
        <span className="tongatron-wordmark">tongatron.github.io</span>
      </a>
    </div>
  )
}

export default App
