import { StaffServicesResponse, Association, AssociationCategory, AssociatedServiceDetail } from '../../functions/api/getServices'
export type { StaffServicesResponse }
import { getDisruption, DisruptionResult } from './DisruptionSimulator'
import timetableData from './timetable.json'

interface IOptions {
    count?: number
    timeWindow?: number
    minOffset: number
    mustStopAt?: string | null
    platform?: string | null
}

export interface LiveActivity {
    type: string
    targetHeadcode?: string
    targetUnit?: number
    targetDiagram?: string
    forms?: string
    consists?: string[]
}

export interface LiveCall {
    crs: string
    name: string
    platform?: string
    pass: boolean
    isRequestStop: boolean
    arrival: string
    departure: string
    activities?: LiveActivity[]
    type: 'unsimulated' | 'simulated' | 'simulatedPathOnly'
}

export interface LiveDeparture {
    headcode: string
    diagram: string
    operator: string
    entryTime: string
    consist: string | null
    state: string
    delayMinutes?: number
    callIndex: number
    calls: LiveCall[]
}

export interface DeparturesResponse {
    station: string
    platform: string
    generatedAt: number
    departures: LiveDeparture[]
}

export interface SimulatedStation {
    crs: string
    name: string
    platforms: string[]
}

type StaffTrainService = NonNullable<StaffServicesResponse['trainServices']>[number]

function mapActivityToCategory(type: string): AssociationCategory | null {
    switch (type) {
        case 'divide':
        case 'detach':
            return AssociationCategory.Divide
        case 'join':
        case 'attach':
            return AssociationCategory.Join
        default:
            return null
    }
}

const SIMULATED_STATION_CRS = new Set(['KBY', 'KMH'])

interface TimetableCallDef {
    type: 'unsimulated' | 'simulated' | 'simulatedPathOnly'
    crs?: string
    tiploc?: string
    arr?: string
    dep?: string
    plat?: string
    path?: string
    stop_pct?: number
    pass?: boolean
    activities?: LiveActivity[]
}

interface TimetableServiceDef {
    headcode: string
    diagram: string
    entry_time: string
    timing_load?: string
    do_not_advertise?: boolean
    allow_early?: boolean
    entry?: { type: string; section?: string }
    exit?: { type: string }
    timetable: TimetableCallDef[]
}

interface TimetableConsistDef {
    id: string
    description?: string
    units: string[]
    activities?: {
        attach?: { min?: number; max?: number }
        detach?: { min?: number; max?: number }
        reverse?: { min?: number; max?: number }
    }
}

interface AllocationEntry {
    consist?: string
    diagram?: string
    weight?: number
}

interface ScenarioDef {
    base_delay?: number
    delayed_pct?: number
    disruption_pct?: number
    set_swap_pct?: number
}

interface TimetableDiagramDef {
    id: string
    operator: string
    allocation?: AllocationEntry[]
    set_swap_pool?: AllocationEntry[]
    scenario?: ScenarioDef
    services: TimetableServiceDef[] | null
}

interface TiplocDef {
    id: string
    name: string
    type: 'station' | 'object'
    crs?: string
    object?: string
}

interface StationDef {
    crs: string
    name: string
    plat_length: number
}

interface TimetableFile {
    manifest: unknown
    tiplocs: TiplocDef[]
    stations: StationDef[]
    diagrams: TimetableDiagramDef[]
}

const data = timetableData as unknown as TimetableFile

const tiplocIndex = new Map<string, TiplocDef>()
for (const t of data.tiplocs) tiplocIndex.set(t.id, t)

const stationIndex = new Map<string, StationDef>()
for (const s of data.stations) stationIndex.set(s.crs.toUpperCase(), s)

interface FlatService {
    diagramId: string
    operator: string
    headcode: string
    entryTime: string
    timetable: TimetableCallDef[]
    allocation?: AllocationEntry[]
    setSwapPool?: AllocationEntry[]
    scenario?: ScenarioDef
}

const allServices: FlatService[] = []
for (const diagram of data.diagrams) {
    if (!diagram.services) continue
    for (const svc of diagram.services) {
        allServices.push({
            diagramId: diagram.id,
            operator: diagram.operator,
            headcode: svc.headcode,
            entryTime: svc.entry_time,
            timetable: svc.timetable,
            allocation: diagram.allocation,
            setSwapPool: diagram.set_swap_pool,
            scenario: diagram.scenario,
        })
    }
}

export function parseClockToSeconds(s: string | undefined): number {
    if (!s) return -1
    const [h, m, sec] = s.split(':').map(n => parseInt(n, 10) || 0)
    return h * 3600 + m * 60 + sec
}

export function secondsSinceMidnight(d: Date): number {
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

function secondsToDate(base: Date, seconds: number): Date {
    const out = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0)
    out.setSeconds(seconds)
    return out
}

export function inferOperator(diagram: string, explicitOperator: string | null): string {
    const diag = (diagram || '').toUpperCase()
    if (diag.startsWith('NT') || diag.startsWith('AB')) return explicitOperator ?? 'Northern'
    if (diag.startsWith('TP') || diag.startsWith('CN')) return explicitOperator ?? 'TransPennine Express'
    return explicitOperator ?? 'Unknown Operator'
}

const CONSIST_LENGTHS: Record<string, number> = {
    '142': 2,
    '150': 2,
    '153': 1,
    '155': 2,
    '156': 2,
    '158': 2,
    '185': 3,
    '220': 4,
    '221': 5,
}

function parseConsistLength(consist: string): number {
    const parts = consist
        .toUpperCase()
        .split(/[+&]/)
        .map(p => p.trim())
        .filter(Boolean)

    let total = 0

    for (const p of parts) {
        const multiMatch = p.match(/^(\d+)X(\d+)$/)
        if (multiMatch) {
            const count = parseInt(multiMatch[1], 10)
            const cls = multiMatch[2]
            total += (CONSIST_LENGTHS[cls] ?? 0) * count
            continue
        }

        total += CONSIST_LENGTHS[p] ?? 0
    }

    return total
}

export function calculateTrainLength(diagram: string, consist: string | null): number {
    if (!consist) return 2
    const len = parseConsistLength(consist)
    return len > 0 ? len : 2
}

const ASSUMED_VEHICLE_LENGTH_M = 23

export function isPlatformShort(crs: string, trainLengthVehicles: number): boolean | undefined {
    const station = stationIndex.get(crs.toUpperCase())
    if (!station) return undefined
    return trainLengthVehicles * ASSUMED_VEHICLE_LENGTH_M > station.plat_length
}

function isEcsHeadcode(headcode: string): boolean {
    return /^5/.test(headcode || '')
}

function toLocation(c: LiveCall) {
    return {
        isOperationalEndPoint: false,
        locationName: c.name + (c.isRequestStop ? ' (x)' : ''),
        crs: c.crs,
        tiploc: c.crs,
        via: undefined,
        futureChangeToSpecified: false,
    }
}

function resolveCallLocation(entry: TimetableCallDef): { crs: string; name: string } | null {
    if (entry.type === 'simulatedPathOnly') return null

    if (entry.crs) {
        const crs = entry.crs.toUpperCase()
        const st = stationIndex.get(crs)
        return { crs, name: st?.name ?? crs }
    }

    if (entry.tiploc) {
        const t = tiplocIndex.get(entry.tiploc)
        if (t?.type === 'station' && t.crs) {
            const crs = t.crs.toUpperCase()
            const st = stationIndex.get(crs)
            return { crs, name: st?.name ?? t.name }
        }
    }

    return null
}

function buildCallsForService(svc: FlatService): LiveCall[] {
    const calls: LiveCall[] = []
    for (const entry of svc.timetable) {
        const loc = resolveCallLocation(entry)
        if (!loc) continue
        calls.push({
            crs: loc.crs,
            name: loc.name,
            platform: entry.plat,
            pass: !!entry.pass,
            isRequestStop: entry.stop_pct !== undefined && entry.stop_pct < 100,
            arrival: entry.arr ?? '',
            departure: entry.dep ?? '',
            activities: entry.activities,
            type: entry.type,
        })
    }
    return calls
}

function callTimeSeconds(call: LiveCall): number {
    return parseClockToSeconds(call.departure || call.arrival)
}

function resolveAllocationConsist(
    svc: Pick<FlatService, 'allocation' | 'setSwapPool' | 'scenario'>,
): string | null {
    const pool = svc.allocation ?? []
    if (pool.length === 0) return null

    // Step 1: pick a random NON-diagram consist as the base
    const baseOptions = pool.filter(a => a.consist)
    let base: string | null = null

    if (baseOptions.length > 0) {
        const total = baseOptions.reduce((s, a) => s + (a.weight ?? 1), 0)
        let r = Math.random() * total
        for (const a of baseOptions) {
            r -= a.weight ?? 1
            if (r <= 0) {
                base = a.consist!
                break
            }
        }
    }

    // Step 2: append all diagram references
    const diagramParts: string[] = []
    for (const a of pool) {
        if (!a.diagram) continue
        const other = resolveDiagramConsist(a.diagram)
        if (other) diagramParts.push(other)
    }

    if (!base && diagramParts.length === 0) return null
    if (!base) return diagramParts.join('+')
    if (diagramParts.length === 0) return base

    return [base, ...diagramParts].join('+')
}

function resolveDiagramConsist(diagramId: string): string | null {
    const svc = allServices.find(s => s.diagramId === diagramId)
    if (!svc) return null

    return resolveAllocationConsist({
        allocation: svc.allocation,
        setSwapPool: svc.setSwapPool,
        scenario: svc.scenario,
    })
}


export async function getSimulatedStations(): Promise<SimulatedStation[]> {
    const platformsByCrs = new Map<string, Set<string>>()

    for (const svc of allServices) {
        for (const entry of svc.timetable) {
            if (!entry.plat) continue
            const loc = resolveCallLocation(entry)
            if (entry.pass) continue
            if (!loc) continue
            if (!platformsByCrs.has(loc.crs)) platformsByCrs.set(loc.crs, new Set())
            platformsByCrs.get(loc.crs)!.add(entry.plat)
        }
    }

    return data.stations
        .filter(s => platformsByCrs.has(s.crs.toUpperCase()))
        .map(s => ({
            crs: s.crs,
            name: s.name,
            platforms: Array.from(platformsByCrs.get(s.crs.toUpperCase()) ?? []).sort(),
        }))
}

export async function fetchDepartures(station: string, options: IOptions): Promise<DeparturesResponse> {
    const stationCrs = station.toUpperCase()
    const now = new Date()
    const nowSecs = secondsSinceMidnight(now) + (options.minOffset ?? 0) * 60
    const windowSecs = (options.timeWindow ?? 120) * 60
    const count = options.count ?? 10

    interface Candidate {
        service: FlatService
        calls: LiveCall[]
        callIndex: number
        absSecs: number
    }

    const candidates: Candidate[] = []

    for (const svc of allServices) {
        if (isEcsHeadcode(svc.headcode)) continue

        const calls = buildCallsForService(svc)

        const callIndex = calls.findIndex(
            c => c.crs === stationCrs && !c.pass && (!options.platform || c.platform === options.platform),
        )
        if (callIndex === -1) continue
        let absSecs = callTimeSeconds(calls[callIndex])
        if (absSecs < 0) continue
        while (absSecs < nowSecs - 60) absSecs += 86400
        if (absSecs < nowSecs || absSecs > nowSecs + windowSecs) continue

        candidates.push({ service: svc, calls, callIndex, absSecs })
    }

    candidates.sort((a, b) => a.absSecs - b.absSecs)
    const selected = candidates.slice(0, count)

    const departures: LiveDeparture[] = selected.map(({ service, calls, callIndex }) => ({
        headcode: service.headcode,
        diagram: service.diagramId,
        operator: service.operator,
        entryTime: service.entryTime,
        consist: resolveAllocationConsist(service),
        state: 'REGULAR',
        delayMinutes: 0,
        callIndex,
        calls,
    }))
    return {
        station: stationCrs,
        platform: options.platform ?? '',
        generatedAt: Date.now(),
        departures,
    }
}

async function fetchAssociatedService(
    targetHeadcode: string | undefined,
    targetDiagram: string | undefined,
    aroundSeconds: number,
): Promise<LiveDeparture | undefined> {
    if (!targetHeadcode && !targetDiagram) return undefined

    const matches = allServices.filter(
        s => (!targetHeadcode || s.headcode === targetHeadcode) && (!targetDiagram || s.diagramId === targetDiagram),
    )
    if (matches.length === 0) return undefined

    const svc = matches.reduce((best, cur) => {
        const bestDiff = Math.abs(parseClockToSeconds(best.entryTime) - aroundSeconds)
        const curDiff = Math.abs(parseClockToSeconds(cur.entryTime) - aroundSeconds)
        return curDiff < bestDiff ? cur : best
    })

    const calls = buildCallsForService(svc)

    return {
        headcode: svc.headcode,
        diagram: svc.diagramId,
        entryTime: svc.entryTime,
        consist: resolveAllocationConsist(svc),
        state: 'REGULAR',
        delayMinutes: 0,
        callIndex: 0,
        calls,
    }
}

export function ridFor(departure: LiveDeparture): string {
    return `${departure.diagram}_${departure.headcode}_${parseClockToSeconds(departure.entryTime)}`
}

export function routeStationNames(departure: LiveDeparture): string[] {
    return Array.from(new Set(departure.calls.filter(c => !c.pass).map(c => c.name)))
}

function buildAssociatedServiceDetail(departure: LiveDeparture, now: Date, disruption: DisruptionResult): AssociatedServiceDetail {
    const { isCancelled, delayMinutes } = disruption
    const trainLength = calculateTrainLength(departure.diagram, departure.consist)

    const locations = departure.calls.map(c => {
        const arr = parseClockToSeconds(c.arrival || c.departure)
        const dep = parseClockToSeconds(c.departure || c.arrival)
        return {
            locationName: c.name,
            tiploc: c.crs,
            crs: c.crs,
            isOperational: false,
            isPass: c.pass,
            isCancelled,
            platform: c.platform,
            platformIsHidden: false,
            serviceIsSuppressed: false,
            sta: secondsToDate(now, arr).toISOString(),
            staSpecified: true,
            ata: '',
            ataSpecified: false,
            eta: isCancelled ? '' : secondsToDate(now, arr + delayMinutes * 60).toISOString(),
            etaSpecified: !isCancelled,
            arrivalType: 0,
            arrivalTypeSpecified: true,
            arrivalSource: 'Darwin',
            arrivalSourceInstance: null,
            std: secondsToDate(now, dep).toISOString(),
            stdSpecified: true,
            atd: '',
            atdSpecified: false,
            etd: isCancelled ? '' : secondsToDate(now, dep + delayMinutes * 60).toISOString(),
            etdSpecified: !isCancelled,
            departureType: 0,
            departureTypeSpecified: true,
            departureSource: 'Darwin',
            departureSourceInstance: null,
            lateness: null,
            associations: null,
            adhocAlerts: null,
            activities: undefined,
            length: trainLength,
            falseDest: null,
        }
    })

    const cancelReason =
        isCancelled && disruption.cancelReason
            ? { tiploc: '', near: false, value: disruption.cancelReason.value, stationName: disruption.cancelReason.stationName ?? null }
            : null
    const delayReason =
        delayMinutes > 0 && disruption.delayReason
            ? { tiploc: '', near: false, value: disruption.delayReason.value, stationName: disruption.delayReason.stationName ?? null }
            : null

    return {
        cancelReason,
        delayReason,
        isCharter: false,
        isPassengerService: true,
        category: 'OO',
        sta: locations[0]?.sta ?? '',
        staSpecified: true,
        ata: '',
        ataSpecified: false,
        eta: locations[0]?.eta ?? '',
        etaSpecified: !isCancelled,
        std: locations[0]?.std ?? '',
        stdSpecified: true,
        atd: '',
        atdSpecified: false,
        etd: locations[0]?.etd ?? '',
        etdSpecified: !isCancelled,
        rid: ridFor(departure),
        uid: departure.headcode,
        locations: locations as any,
        trainid: departure.headcode,
    }
}

async function toAssociations(c: LiveCall, now: Date, resolveAssociations: boolean): Promise<Association[]> {
    const callSeconds = callTimeSeconds(c)
    const results: Association[] = []

    for (const a of c.activities || []) {
        const category = mapActivityToCategory(a.type)
        if (category === null) continue

        const targetHeadcode = a.targetHeadcode ?? a.forms
        const targetDeparture = await fetchAssociatedService(targetHeadcode, a.targetDiagram, callSeconds)
        if (!targetDeparture) continue

        const isTargetEcs = isEcsHeadcode(targetDeparture.headcode)

        // If the target portion is ECS, we change its display destinations to show "Terminates Here"
        // so that the UI can form the split layout without reading empty passenger stops.
        const targetFirst = targetDeparture.calls.find(cc => !cc.pass) || targetDeparture.calls[0]
        const targetLast = isTargetEcs 
            ? { name: 'Terminates Here', crs: c.crs } 
            : ([...targetDeparture.calls].reverse().find(cc => !cc.pass) || targetDeparture.calls[targetDeparture.calls.length - 1])

        const disruption = getDisruption(
            ridFor(targetDeparture),
            targetDeparture.delayMinutes ?? 0,
            targetDeparture.state === 'CANCELLED',
            routeStationNames(targetDeparture),
        )

        let serviceDetail = (category === AssociationCategory.Divide && resolveAssociations
            ? buildAssociatedServiceDetail(targetDeparture, now, disruption)
            : undefined) as any

        // Override the inner locations if it's an ECS move so the sub-banner doesn't look broken
        if (isTargetEcs && serviceDetail) {
            serviceDetail.isPassengerService = false
        }

        results.push({
            category,
            rid: ridFor(targetDeparture),
            uid: targetDeparture.headcode,
            trainid: targetDeparture.headcode,
            sdd: '',
            origin: targetFirst.name,
            originCRS: targetFirst.crs,
            originTiploc: targetFirst.crs,
            destination:
                category === AssociationCategory.Divide
                    ? `${targetFirst.name} & ${targetLast.name}`
                    : targetLast.name,
            destCRS: targetLast.crs,
            destTiploc: targetLast.crs,
            isCancelled: disruption.isCancelled,
            service: serviceDetail,
        })
    }

    return results
}

async function buildTrainService(
    departure: LiveDeparture,
    now: Date,
    disruption: DisruptionResult,
    resolveAssociations: boolean = true,
): Promise<StaffTrainService> {
    const calls = departure.calls
    const callIndex = departure.callIndex
    const thisCall = calls[callIndex]
    const rid = ridFor(departure)
    const { isCancelled, delayMinutes } = disruption

    const cancelReason = isCancelled && disruption.cancelReason
        ? { value: disruption.cancelReason.value, stationName: disruption.cancelReason.stationName ?? undefined }
        : undefined
    const delayReason = delayMinutes > 0 && disruption.delayReason
        ? { value: disruption.delayReason.value, stationName: disruption.delayReason.stationName ?? undefined }
        : undefined

    const nowSecs = secondsSinceMidnight(now)

    const arrivalSecs = parseClockToSeconds(thisCall.arrival || thisCall.departure)
    const departureSecs = parseClockToSeconds(thisCall.departure || thisCall.arrival)
    const adjustedArrival = arrivalSecs + delayMinutes * 60
    const adjustedDeparture = departureSecs + delayMinutes * 60

    let etd: Date | undefined = secondsToDate(now, adjustedDeparture)
    let eta: Date | undefined = secondsToDate(now, adjustedArrival)
    let atd: Date | undefined
    let ata: Date | undefined
    let atdSpecified = false
    let ataSpecified = false

    if (!isCancelled) {
        if (nowSecs >= adjustedDeparture + 30) {
            atd = secondsToDate(now, adjustedDeparture)
            atdSpecified = true
            etd = undefined
        } else if (nowSecs >= adjustedArrival && nowSecs < adjustedDeparture) {
            ata = secondsToDate(now, adjustedArrival)
            ataSpecified = true
            eta = undefined
        }
    }

    const operatorName = departure.operator
    const trainLength = calculateTrainLength(departure.diagram, departure.consist)
    const platformIsShortHere = thisCall.crs ? isPlatformShort(thisCall.crs, trainLength) : undefined

    const originCalls = calls.slice(0, callIndex).filter(c => !c.pass)
    const subsequentCalls = calls.slice(callIndex + 1).filter(c => !c.pass)

    const firstStoppingCall = calls.find(c => !c.pass) || calls[0]
    let lastStoppingCall = [...calls].reverse().find(c => !c.pass) || calls[calls.length - 1]

    if (lastStoppingCall?.crs === thisCall.crs) {
        lastStoppingCall = thisCall
    }

    const std = secondsToDate(now, departureSecs)
    const sta = secondsToDate(now, arrivalSecs)

    const buildLocation = async (c: LiveCall) => {
        const cArr = parseClockToSeconds(c.arrival || c.departure)
        const cDep = parseClockToSeconds(c.departure || c.arrival)
        return {
            crs: c.crs,
            tiploc: c.crs,
            locationName: c.name + (c.isRequestStop ? ' (x)' : ''),
            isCancelled,
            isOperational: false,
            isPass: c.pass,
            isRequestStop: c.isRequestStop,
            associations: await toAssociations(c, now, resolveAssociations),
            stdSpecified: true,
            std: secondsToDate(now, cDep),
            etdSpecified: !isCancelled,
            etd: isCancelled ? undefined : secondsToDate(now, cDep + delayMinutes * 60),
            staSpecified: true,
            sta: secondsToDate(now, cArr),
            etaSpecified: !isCancelled,
            eta: isCancelled ? undefined : secondsToDate(now, cArr + delayMinutes * 60),
            platformIsShort: isPlatformShort(c.crs, trainLength),
        }
    }

    let [subsequentLocations, previousLocations] = await Promise.all([
        Promise.all(subsequentCalls.map(buildLocation)),
        Promise.all(originCalls.map(buildLocation)),
    ])

    if (
        subsequentLocations.length === 1 && 
        subsequentLocations[0].crs === thisCall.crs
    ) {
        subsequentLocations = []
    }

    return {
        destination: [toLocation(lastStoppingCall)],
        currentDestinations: [toLocation(lastStoppingCall)],
        origin: [toLocation(firstStoppingCall)],
        currentOrigins: [toLocation(firstStoppingCall)],
        isCancelled,
        cancelReason,
        delayReason,
        isPassengerService: true,
        isOperationalCall: false,
        filterLocationCancelled: isCancelled,
        isCircularRoute: false,
        stdSpecified: true,
        std,
        etdSpecified: !isCancelled && atd === undefined,
        etd: isCancelled ? undefined : etd,
        atdSpecified,
        atd,
        staSpecified: callIndex > 0,
        sta: callIndex > 0 ? sta : undefined,
        etaSpecified: callIndex > 0 && !isCancelled && ata === undefined,
        eta: isCancelled ? undefined : callIndex > 0 ? eta : undefined,
        ataSpecified,
        ata,
        length: trainLength,
        platformIsShort: platformIsShortHere,
        operator: operatorName,
        operatorCode: (departure.diagram || '').substring(0, 2).toUpperCase(),
        platform: thisCall.platform || undefined,
        rid,
        serviceID: rid,
        subsequentLocations,
        previousLocations,
    } as any
}

export default async function GetNextTrainsAtStationStaff(
    station: string,
    options: IOptions = { count: 3, timeWindow: 9000, minOffset: 0, mustStopAt: null, platform: null },
    _abortController?: AbortController,
): Promise<StaffServicesResponse | null | { error: true }> {

    const stationCrs = station.toUpperCase()

    let apiResponse: DeparturesResponse
    try {
        apiResponse = await fetchDepartures(stationCrs, options)
    } catch (e) {
        console.error(e)
        return { error: true }
    }

    const now = new Date()
    let departures = apiResponse.departures

    departures = departures.filter(d => {
        const lastStoppingCall = [...d.calls].reverse().find(c => !c.pass) || d.calls[d.calls.length - 1]
        return lastStoppingCall?.crs?.toUpperCase() !== stationCrs
    })

    if (options.mustStopAt) {
        const mustStopAt = options.mustStopAt.toUpperCase()
        departures = departures.filter(d => d.calls.some(c => c.crs === mustStopAt && !c.pass))
    }

    const trainServices: StaffTrainService[] = []
    for (const departure of departures) {
        const isCancelled = departure.state === 'CANCELLED'
        const disruption = getDisruption(
            ridFor(departure),
            departure.delayMinutes ?? 0,
            isCancelled,
            routeStationNames(departure)
        )
        trainServices.push(await buildTrainService(departure, now, disruption))
    }

    return {
        areServicesAvailable: trainServices.length > 0,
        crs: stationCrs,
        locationName: apiResponse.departures[0]?.calls.find(c => c.crs === stationCrs)?.name ?? stationCrs,
        platformAvailable: trainServices.some(s => !!s.platform),
        trainServices,
    } as any
}