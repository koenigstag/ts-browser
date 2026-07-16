export const loadLazyRoute = async () => {
    const mod = await import('./lazyRoute.ts');
    return mod.lazyValue;
};
