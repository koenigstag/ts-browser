export let counter = 1;
export const bumpCounter = () => { counter++; };
export default function greet(name: string) {
    return 'Hello, ' + name;
}
