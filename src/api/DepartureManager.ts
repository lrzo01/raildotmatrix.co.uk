import { StaffServicesResponse } from '../../functions/api/getServices'
export type { StaffServicesResponse }
import { getDisruption, DisruptionResult } from './DisruptionSimulator'

const API_BASE = 'http://localhost:5050'

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
	arrival: string // "HH:MM:SS", may be empty
	departure: string // "HH:MM:SS", may be empty
	activities?: LiveActivity[]
	type: 'unsimulated' | 'simulated' | 'simulatedPathOnly'
}

export interface LiveDeparture {
	headcode: string
	diagram: string
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

const ASSOCIATION_ACTIVITY_TYPES = new Set(['attach', 'divide', 'detach', 'join'])

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------
export function parseClockToSeconds(s: string | undefined): number {
	if (!s) return -1
	const [h, m, sec] = s.split(':').map(n => parseInt(n, 10) || 0)
	return h * 3600 + m * 60 + sec
}

export function secondsToClockString(seconds: number): string {
	if (seconds < 0) return ""
	const h = Math.floor(seconds / 3600) % 24
	const m = Math.floor((seconds % 3600) / 60)
	const s = seconds % 60
	return [h, m, s].map(v => String(v).padStart(2, '0')).join(':')
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
	if (diag.startsWith('NT')) return 'Northern'
	if (diag.startsWith('TP')) return 'TransPennine Night Local'
	return explicitOperator ?? 'Unknown Operator'
}

export function calculateTrainLength(diagram: string, consist: string | null): number {
	const stock = (consist || '').toUpperCase()
	if (stock.includes('2X185')) return 6
	if (stock.includes('185')) return 3
	const diag = (diagram || '').toUpperCase()
	return 3
}

// FIX: Process and apply backend baked-in delays directly onto the string representations
export function applyDelayToTimetableCalls(departure: LiveDeparture): LiveDeparture {
	const delaySecs = (departure.delayMinutes || 0) * 60
	if (delaySecs <= 0) return departure

	departure.calls = departure.calls.map(call => {
		const nextCall = { ...call }
		if (nextCall.arrival) {
			const arrSecs = parseClockToSeconds(nextCall.arrival)
			if (arrSecs >= 0) {
				nextCall.arrival = secondsToClockString(arrSecs + delaySecs)
			}
		}
		if (nextCall.departure) {
			const depSecs = parseClockToSeconds(nextCall.departure)
			if (depSecs >= 0) {
				nextCall.departure = secondsToClockString(depSecs + delaySecs)
			}
		}
		return nextCall
	})

	return departure
}