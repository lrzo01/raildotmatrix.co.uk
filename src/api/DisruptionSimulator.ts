import LatenessCodes from './LatenessCodes.json'
import CancellationCodes from './CancellationCodes.json'

const LATENESS_CODES = Object.keys(LatenessCodes)
const CANCELLATION_CODES = Object.keys(CancellationCodes)

export interface ReasonCode {
	value: number
	stationName: string | null
}

export interface DisruptionResult {
	isCancelled: boolean
	cancelReason: ReasonCode | null
	delayMinutes: number
	delayReason: ReasonCode | null
}

export function cyrb128(str: string): number {
	let h = 2166136261
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0) / 4294967296
}

function seededRandom(seed: string, salt: string): number {
	return cyrb128(`${seed}::${salt}`)
}

function pickReasonCode(codes: string[], seed: string, salt: string): number {
	const idx = Math.min(Math.floor(seededRandom(seed, salt) * codes.length), codes.length - 1)
	return parseInt(codes[idx], 10)
}

function pickStationName(names: string[], seed: string, salt: string): string | null {
	if (!names.length) return null
	const idx = Math.min(Math.floor(seededRandom(seed, salt) * names.length), names.length - 1)
	return names[idx]
}

// DisruptionSimulator.ts

// Persistent cache to prevent flickering of delay/cancellation states
const disruptionCache = new Map<string, DisruptionResult>();

/**
 * Computes a stable, pseudo-random disruption reason.
 * Implements hysteresis: changes are only accepted if they are significant 
 * (>= 1 minute) or if the state transitions from On-Time to Late.
 */
export function getDisruption(
  serviceId: string, 
  apiDelayMinutes: number = 0, 
  isApiCancelled: boolean = false,
  nearStationNames: string[] = []
): DisruptionResult {
  
  const cached = disruptionCache.get(serviceId);
  const roundedDelay = Math.round(apiDelayMinutes);

  // --- Hysteresis Logic ---
  // If we have a cached state, only update if the change is significant (>= 1 min)
  // or if the cancellation status has changed.
  if (cached) {
    const isSignificantChange = Math.abs(roundedDelay - cached.delayMinutes) >= 1;
    const isStatusChange = cached.isCancelled !== isApiCancelled;
    
    if (!isSignificantChange && !isStatusChange) {
      return cached;
    }
  }

  // --- Logic for new or significant state changes ---
  let result: DisruptionResult;

  if (isApiCancelled) {
    result = {
      isCancelled: true,
      cancelReason: {
        value: pickReasonCode(CANCELLATION_CODES, serviceId, 'cancel-reason'),
        stationName: pickStationName(nearStationNames, serviceId, 'cancel-station'),
      },
      delayMinutes: 0,
      delayReason: null,
    };
  } else if (roundedDelay > 0) {
    result = {
      isCancelled: false,
      cancelReason: null,
      delayMinutes: roundedDelay,
      delayReason: {
        value: pickReasonCode(LATENESS_CODES, serviceId, 'delay-reason'),
        stationName: pickStationName(nearStationNames, serviceId, 'delay-station'),
      },
    };
  } else {
    result = { 
      isCancelled: false, 
      cancelReason: null, 
      delayMinutes: 0, 
      delayReason: null 
    };
  }

  // Update the cache and return
  disruptionCache.set(serviceId, result);
  return result;
}

/** Formats a ReasonCode into the plain-string form the customer-facing board uses. */
export function formatReason(reason: ReasonCode | null, isCancellation: boolean): string | undefined {
	if (!reason) return undefined
	const table = (isCancellation ? CancellationCodes : LatenessCodes) as Record<string, string | undefined>
	let text = table[reason.value.toString()]
	if (!text) return undefined
	if (reason.stationName) text += ` near ${reason.stationName}`
	return text + '.'
}