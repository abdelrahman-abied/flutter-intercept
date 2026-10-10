// Network profiles (CONTRACTS §9.2). Pure and dependency-free: the webview imports this module
// (`@flutter-intercept/proxy/network`) so its picker can never disagree with the proxy.

/** Global, per proxy (= per app): applies to everything that would reach the network. */
export type NetworkProfile =
  | { kind: 'none' }
  | { kind: 'offline' }
  | { kind: 'throttle'; preset?: NetworkPresetId; latencyMs?: number; kbps?: number; dropRate?: number; uploadKbps?: number };

export type NetworkPresetId = 'slow-3g' | 'fast-3g' | 'flaky';

export interface NetworkPreset {
  id: NetworkPresetId;
  label: string;
  latencyMs: number;
  kbps?: number;
  dropRate?: number;
}

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
  { id: 'slow-3g', label: 'Slow 3G', latencyMs: 400, kbps: 400 },
  { id: 'fast-3g', label: 'Fast 3G', latencyMs: 150, kbps: 1600 },
  { id: 'flaky', label: 'Flaky (20% fail)', latencyMs: 200, dropRate: 0.2 },
];

export const NO_PROFILE: NetworkProfile = { kind: 'none' };

export function presetProfile(id: NetworkPresetId): NetworkProfile {
  const p = NETWORK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown network preset ${id}`);
  return {
    kind: 'throttle',
    preset: p.id,
    latencyMs: p.latencyMs,
    ...(p.kbps !== undefined ? { kbps: p.kbps } : {}),
    ...(p.dropRate !== undefined ? { dropRate: p.dropRate } : {}),
  };
}

/** Short label for status lines and `Exchange.simulated`, e.g. "Slow 3G", "Offline", "+300 ms, 800 kbps". */
export function describeProfile(p: NetworkProfile): string {
  if (p.kind === 'none') return 'No throttling';
  if (p.kind === 'offline') return 'Offline';
  const preset = p.preset && NETWORK_PRESETS.find((x) => x.id === p.preset);
  if (preset) return preset.label;
  const parts: string[] = [];
  if (p.latencyMs) parts.push(`+${p.latencyMs} ms`);
  if (p.kbps) parts.push(`${p.kbps} kbps`);
  if (p.dropRate) parts.push(`${Math.round(p.dropRate * 100)}% fail`);
  return parts.join(', ') || 'No throttling';
}
