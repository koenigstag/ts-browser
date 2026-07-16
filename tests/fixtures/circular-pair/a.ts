import {bGreet} from './b.ts';
import {sharedValue} from './shared.ts';

export const sharedFromA = sharedValue;
export const aGreet = () => 'A says: ' + bGreet();
