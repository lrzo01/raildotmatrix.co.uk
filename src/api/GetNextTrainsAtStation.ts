import {
  loadTimetable,
  secondsSinceMidnight,
  Timetable,
  TimetableCall,
  TimetableService,
  calculateTrainLength,
  isPlatformShort,
} from './GetNextTrainsAtStationStaff'
import { getDisruption, formatReason, DisruptionResult } from './DisruptionSimulator'

export interface Association {
  type: string
  targetHeadcode?: string
  targetDiagram?: string
  forms?: string
}
export interface Location {
  locationName: string
  crs: string
  via?: string
}
export interface CallingPointLocation {
  locationName: string
  crs: string
  st: string
  et: string
  at?: string
  isCancelled?: boolean
  length?: number
  detachFront: boolean
  isRequestStop?: boolean
  platformIsShort?: boolean
  associations?: Association[]
}
export interface CallingPoints {
  assocIsCancelled: boolean
  serviceChangeRequired: boolean
  serviceType: number
  callingPoint: CallingPointLocation[]
}
export interface TrainService {
  destination: Location[]
  origin: Location[]
  currentDestinations: Location[] | null
  currentOrigin: Location[] | null
  delayReason?: string
  cancelReason?: string
  detachFront: boolean
  eta?: string
  etd?: string
  sta?: string
  std?: string
  filterLocationCancelled: boolean
  isCancelled: boolean
  isCircularRoute: boolean
  length?: number
  platformIsShort?: boolean
  operator: string
  operatorCode: string
  platform?: string
  previousCallingPoints: null | CallingPoints[]
  subsequentCallingPoints: null | CallingPoints[]
  serviceIdGuid: string
  serviceID: string
}
export interface ApiResponse {
  areServicesAvailable: boolean
  crs: string
  locationName: string
  platformAvailable: boolean
  trainServices: TrainService[]
}

interface IOptions {
  count?: number
  timeWindow?: number
  minOffset: number
  mustStopAt?: string | null
}

// "attach"/"divide"/"detach"/"join" represent a train splitting or joining
// with another; other activity types (e.g. reversals) exist in the data but
// aren't associations, and are left out here.
const ASSOCIATION_ACTIVITY_TYPES = new Set(['attach', 'divide', 'detach', 'join'])

function toAssociations(c: TimetableCall): Association[] {
  return (c.activities || [])
    .filter(a => ASSOCIATION_ACTIVITY_TYPES.has(a.type))
    .map(a => ({ type: a.type, targetHeadcode: a.targetHeadcode, targetDiagram: a.targetDiagram, forms: a.forms }))
}

// A call divides or attaches here if it carries one of those activities.
// NOTE: this only tells you *that* a split/join happens at this call, not
// which physical end of the train it happens at (the export's ActivityOut
// has a targetUnit index but no declared front/rear convention, so
// `detachFront` here is a best-effort "something detaches/attaches at this
// stop" flag rather than a verified front/rear indicator).
function hasDetachOrAttach(c: TimetableCall): boolean {
  return (c.activities || []).some(a => ASSOCIATION_ACTIVITY_TYPES.has(a.type))
}

function formatClock(seconds: number): string {
  const wrapped = ((seconds % 86400) + 86400) % 86400
  const hh = Math.floor(wrapped / 3600)
  const mm = Math.floor((wrapped % 3600) / 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function stationName(timetable: Timetable, crs: string | null): string {
  if (!crs) return ''
  return timetable.stations[crs]?.name ?? crs
}

// Like stationName(), but appends "(Request Stop)" when the call itself is
// flagged as a conditional/request stop (driven by the export's stop_pct).
function callDisplayName(timetable: Timetable, c: TimetableCall): string {
  return stationName(timetable, c.crs) 
}

function routeStationNames(timetable: Timetable, service: TimetableService): string[] {
  const names = service.calls
    .map(c => (c.crs ? stationName(timetable, c.crs) : null))
    .filter((n): n is string => !!n)
  return Array.from(new Set(names))
}

function toLocation(timetable: Timetable, c: TimetableCall): Location {
  return { locationName: callDisplayName(timetable, c), crs: c.crs ?? '' }
}

function toCallingPointLocation(
  timetable: Timetable,
  c: TimetableCall,
  delayMinutes: number,
  isCancelled: boolean,
  trainLength: number,
): CallingPointLocation {
  return {
    locationName: callDisplayName(timetable, c),
    crs: c.crs ?? '',
    st: formatClock(c.departure),
    et: isCancelled ? 'Cancelled' : (delayMinutes > 0 ? formatClock(c.departure + delayMinutes * 60) : 'On time'),
    isCancelled,
    detachFront: hasDetachOrAttach(c),
    isRequestStop: c.isRequestStop ?? false,
    platformIsShort: isPlatformShort(timetable, c.crs, trainLength),
    associations: toAssociations(c),
  }
}

function buildTrainService(
  timetable: Timetable,
  service: TimetableService,
  callIndex: number,
  now: Date,
  disruption: DisruptionResult,
): TrainService {
  const calls = service.calls
  const thisCall = calls[callIndex]
  const firstCall = calls.find(c => !c.pass) || calls[0]
  const finalCall = calls.reduceRight((acc, c) => acc || (!c.pass ? c : null), null as TimetableCall | null) || calls[calls.length - 1]

  const serviceID = `${service.diagram}_${service.headcode}_${service.departs_seconds}`
  const { isCancelled, delayMinutes } = disruption
  const trainLength = calculateTrainLength(service.diagram, service.consist)

  const nowSecs = secondsSinceMidnight(now)
  const adjustedArrival = thisCall.arrival + (delayMinutes * 60)
  const adjustedDeparture = thisCall.departure + (delayMinutes * 60)

  let publicEtd = 'On time'
  let publicEta = 'On time'

  if (isCancelled) {
    publicEtd = 'Cancelled'
    publicEta = 'Cancelled'
  } else {
    if (nowSecs >= adjustedDeparture + 30) {
      publicEtd = 'Departed'
    } else if (nowSecs >= adjustedArrival && nowSecs < adjustedDeparture) {
      publicEtd = 'Arrived'
    } else if (delayMinutes > 0) {
      publicEtd = formatClock(adjustedDeparture)
    }

    if (nowSecs >= adjustedArrival) {
      publicEta = 'Arrived'
    } else if (delayMinutes > 0) {
      publicEta = formatClock(adjustedArrival)
    }
  }

  const previousCalls = calls.slice(0, callIndex).filter(c => !c.pass)
  const subsequentCalls = calls.slice(callIndex + 1).filter(c => !c.pass)

  const previousCallingPoints: CallingPoints[] | null = previousCalls.length
    ? [
        {
          assocIsCancelled: isCancelled,
          serviceChangeRequired: false,
          serviceType: 0,
          callingPoint: previousCalls.map(c => toCallingPointLocation(timetable, c, delayMinutes, isCancelled, trainLength)),
        },
      ]
    : null

  let subsequentCallingPoints: CallingPoints[] | null = subsequentCalls.length
    ? [
        {
          assocIsCancelled: isCancelled,
          serviceChangeRequired: false,
          serviceType: 0,
          callingPoint: subsequentCalls.map(c => toCallingPointLocation(timetable, c, delayMinutes, isCancelled, trainLength)),
        },
      ]
    : null

  // If the only subsequent stop is the station the train is already currently at 
  // (caused by a collapsed ECS reversal path), clear it out so it displays as "... only".
  if (
    subsequentCallingPoints &&
    subsequentCallingPoints[0].callingPoint.length === 1 &&
    subsequentCallingPoints[0].callingPoint[0].crs === thisCall.crs
  ) {
    subsequentCallingPoints = null
  }

  const destination = [toLocation(timetable, finalCall)]
  const origin = [toLocation(timetable, firstCall)]

  return {
    destination,
    origin,
    currentDestinations: destination,
    currentOrigin: origin,
    delayReason: formatReason(disruption.delayReason, false),
    cancelReason: formatReason(disruption.cancelReason, true),
    detachFront: hasDetachOrAttach(thisCall),
    std: formatClock(thisCall.departure),
    etd: publicEtd,
    sta: callIndex > 0 ? formatClock(thisCall.arrival) : undefined,
    eta: callIndex > 0 ? publicEta : undefined,
    filterLocationCancelled: isCancelled,
    isCancelled,
    isCircularRoute: false,
    length: trainLength,
    platformIsShort: isPlatformShort(timetable, thisCall.crs, 1),
    operator: service.operator ?? 'Unknown Operator',
    operatorCode: (service.diagram || '').substring(0, 2).toUpperCase(),
    platform: thisCall.platform ?? undefined,
    previousCallingPoints,
    subsequentCallingPoints,
    serviceIdGuid: serviceID,
    serviceID,
  }
}

export default async function GetNextTrainsAtStation(
  station: string,
  options: IOptions = { count: 3, timeWindow: 120, minOffset: 0, mustStopAt: null },
  _abortController?: AbortController,
): Promise<ApiResponse | null | { error: true }> {
  if (options.minOffset < -239) {
    console.error('Time offset cannot be more than 239 minutes in the past.')
    return null
  }
  if (options.minOffset > 119) {
    console.error('Time offset cannot be more than 119 minutes in the future.')
    return null
  }

  let timetable: Timetable
  try {
    timetable = await loadTimetable()
  } catch (e) {
    console.error(e)
    return { error: true }
  }

  const now = new Date()
  const targetSeconds = secondsSinceMidnight(now) + (options.minOffset || 0) * 60
  const windowEndSeconds = targetSeconds + (options.timeWindow || 120) * 60
  const stationCrs = station.toUpperCase()
  const mustStopAt = options.mustStopAt?.toUpperCase() || null

  type Candidate = { service: TimetableService; callIndex: number; disruption: DisruptionResult }
  const candidates: Candidate[] = []

  for (const service of timetable.services) {
    if (service.error) continue

    const callIndex = service.calls.findIndex(
      c => c.crs?.toUpperCase() === stationCrs && !c.pass && c.platform === '1'
    )
    if (callIndex === -1) continue

    if (stationCrs !== 'KBY') {
      const passesKby = service.calls.some(c => c.crs?.toUpperCase() === 'KBY' && c.pass === true)
      if (passesKby) continue

      const finalStoppingCall = service.calls.reduceRight(
        (acc, c) => acc || (!c.pass ? c : null),
        null as TimetableCall | null
      )
      if (finalStoppingCall?.crs?.toUpperCase() === 'KBY') continue
    }

    const call = service.calls[callIndex]
    const serviceID = `${service.diagram}_${service.headcode}_${service.departs_seconds}`
    const disruption = getDisruption(serviceID, routeStationNames(timetable, service))

    // Evaluate the window threshold against the adjusted, live (delayed) departure.
    const effectiveDeparture = call.departure + disruption.delayMinutes * 60
    if (effectiveDeparture < targetSeconds || call.departure > windowEndSeconds) continue

    if (mustStopAt) {
      const stopsThere = service.calls.some(c => c.crs?.toUpperCase() === mustStopAt && !c.pass)
      if (!stopsThere) continue
    }

    candidates.push({ service, callIndex, disruption })
  }

  candidates.sort((a, b) => a.service.calls[a.callIndex].departure - b.service.calls[b.callIndex].departure)

  const chosen = candidates.slice(0, options.count || 5)
  const trainServices = chosen.map(({ service, callIndex, disruption }) =>
    buildTrainService(timetable, service, callIndex, now, disruption)
  )

  return {
    areServicesAvailable: trainServices.length > 0,
    crs: stationCrs,
    locationName: stationName(timetable, stationCrs),
    platformAvailable: trainServices.some(s => !!s.platform),
    trainServices,
  }
}