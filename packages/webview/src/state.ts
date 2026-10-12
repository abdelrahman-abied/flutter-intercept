/**
 * Pure UI state: one reducer, no DOM, no postMessage. Everything here is unit-tested.
 * Side effects (posting ViewMsg to the host) live in the components / app shell.
 *
 * QUALITY-1 Q6: the code lives in ./state/*; this barrel keeps every import site (components, tests) unchanged.
 */
export * from './state/core';
export * from './state/reducer';
export * from './state/hostMsg';
export * from './state/filtering';
export * from './state/drafts';
export * from './state/composer';
export * from './state/profile';
export * from './state/rules';
export * from './state/ruleForm';
