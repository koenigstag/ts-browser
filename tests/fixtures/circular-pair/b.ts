import {aGreet} from './a.ts';
import {sharedValue} from './shared.ts';

export const sharedFromB = sharedValue;
export const bGreet = () => 'B says hi';
// deferred call (not evaluated at module top-level) - the standard way to
// safely consume a circular-dependency import, matching README's documented
// Proxy-fallback semantics for the specific edge that closes the cycle
export const bCallsA = () => aGreet();
