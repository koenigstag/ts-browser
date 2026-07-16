import {aGreet, sharedFromA} from './a.ts';
import {bCallsA} from './b.ts';

export const result = {
    aGreetOutput: aGreet(),
    bCallsAOutput: bCallsA(),
    sharedFromA,
};
