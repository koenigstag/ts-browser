import greet, {counter, bumpCounter} from './child.ts';

const initial = counter;
bumpCounter();
// only correct if the import is a genuine live binding, not a one-time
// snapshot destructured at import time - this is the core RFC motivation
const afterBump = counter;

export const result = {
    greetOutput: greet('World'),
    initial,
    afterBump,
};
