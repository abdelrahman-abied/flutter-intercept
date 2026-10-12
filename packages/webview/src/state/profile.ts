/** Network profile and throttle fields (CONTRACTS §9.3, §14.4). Split out of ../state.ts (QUALITY-1 Q6). */
import { NETWORK_PRESETS, type NetworkPresetId, describeProfile, presetProfile } from '@flutter-intercept/proxy/network';
import type { NetworkProfile } from '../protocol';

// ---------------------------------------------------------------- network profile (CONTRACTS §9.3)

export type ProfileChoice = 'none' | 'offline' | NetworkPresetId | 'custom';

export const PROFILE_CHOICES: readonly { value: ProfileChoice; label: string }[] = [
  { value: 'none', label: 'No throttling' },
  { value: 'offline', label: 'Offline' },
  ...NETWORK_PRESETS.map((p) => ({ value: p.id as ProfileChoice, label: p.label })),
  { value: 'custom', label: 'Custom…' },
];

export function profileChoice(p: NetworkProfile | undefined): ProfileChoice {
  if (!p || p.kind === 'none') return 'none';
  if (p.kind === 'offline') return 'offline';
  if (p.preset && NETWORK_PRESETS.some((x) => x.id === p.preset)) return p.preset;
  return 'custom';
}

/** Profile for a non-custom choice. */
export function profileForChoice(c: Exclude<ProfileChoice, 'custom'>): NetworkProfile {
  if (c === 'none') return { kind: 'none' };
  if (c === 'offline') return { kind: 'offline' };
  return presetProfile(c);
}

export function isProfileActive(p: NetworkProfile | undefined): boolean {
  return !!p && p.kind !== 'none';
}

/** Short label: the preset's name, "Offline", or "+300 ms, 800 kbps down / 200 up, 5% fail" (CONTRACTS §14.4 upload). */
export function profileLabel(p: NetworkProfile | undefined): string {
  if (p?.kind === 'throttle' && !(p.preset && NETWORK_PRESETS.some((x) => x.id === p.preset))) return describeThrottle(p);
  return describeProfile(p ?? { kind: 'none' });
}

/** The numbers behind a profile, presets included: "+400 ms, 400 kbps down / 400 up" (for tooltips). */
export function profileDetails(p: NetworkProfile | undefined): string {
  if (p?.kind !== 'throttle') return profileLabel(p);
  return describeThrottle(p);
}

/** "+300 ms, 800 kbps", "+300 ms, 800 kbps down / 200 up, 5% fail", "200 kbps up". Mirrors the proxy's describeProfile. */
export function describeThrottle(v: { latencyMs?: number; kbps?: number; uploadKbps?: number; dropRate?: number }): string {
  const parts: string[] = [];
  if (v.latencyMs) parts.push(`+${v.latencyMs} ms`);
  if (v.kbps && v.uploadKbps) parts.push(`${v.kbps} kbps down / ${v.uploadKbps} up`);
  else if (v.kbps) parts.push(`${v.kbps} kbps`);
  else if (v.uploadKbps) parts.push(`${v.uploadKbps} kbps up`);
  if (v.dropRate) parts.push(`${Math.round(v.dropRate * 100)}% fail`);
  return parts.join(', ') || 'No throttling';
}

/** Rule / profile throttle form. `uploadKbps` (CONTRACTS §14.4) is optional: drafts saved before 0.8.0 lack it. */
export interface ThrottleFields { latencyMs: string; kbps: string; dropPct: string; uploadKbps?: string }
export interface ThrottleCheck {
  errors: Partial<Record<keyof ThrottleFields | 'all', string>>;
  value: { latencyMs?: number; kbps?: number; dropRate?: number; uploadKbps?: number };
}

export const isInt = (s: string) => /^\d+$/.test(s.trim());

/** Latency 0–60 000 ms, download / upload 1–1 000 000 kbps (empty = unlimited), failure 0–100 %. At least one set. */
export function checkThrottle(f: ThrottleFields): ThrottleCheck {
  const errors: ThrottleCheck['errors'] = {};
  const value: ThrottleCheck['value'] = {};
  const lat = f.latencyMs.trim();
  if (lat) {
    if (!isInt(lat) || +lat > 60_000) errors.latencyMs = '0–60000 ms';
    else if (+lat > 0) value.latencyMs = +lat;
  }
  const kbps = f.kbps.trim();
  if (kbps) {
    if (!isInt(kbps) || +kbps < 1 || +kbps > 1_000_000) errors.kbps = '1–1000000 kbps (empty = unlimited)';
    else value.kbps = +kbps;
  }
  const up = (f.uploadKbps ?? '').trim();
  if (up) {
    if (!isInt(up) || +up < 1 || +up > 1_000_000) errors.uploadKbps = 'Upload: 1–1000000 kbps (empty = unlimited)';
    else value.uploadKbps = +up;
  }
  const drop = f.dropPct.trim();
  if (drop) {
    const n = Number(drop);
    if (!/^\d+(\.\d+)?$/.test(drop) || n > 100) errors.dropPct = '0–100 %';
    else if (n > 0) value.dropRate = Math.round(n * 100) / 10_000;
  }
  if (!Object.keys(errors).length && !Object.keys(value).length) errors.all = 'Set a latency, a bandwidth limit (download or upload) or a failure rate.';
  return { errors, value };
}

export function throttleFieldsOf(v: { latencyMs?: number; kbps?: number; dropRate?: number; uploadKbps?: number } | undefined): ThrottleFields {
  return {
    latencyMs: v?.latencyMs ? String(v.latencyMs) : '',
    kbps: v?.kbps ? String(v.kbps) : '',
    dropPct: v?.dropRate ? String(Math.round(v.dropRate * 10_000) / 100) : '',
    ...(v?.uploadKbps ? { uploadKbps: String(v.uploadKbps) } : {}),
  };
}

export function customProfile(f: ThrottleFields): NetworkProfile | undefined {
  const c = checkThrottle(f);
  if (Object.keys(c.errors).length) return undefined;
  return { kind: 'throttle', ...c.value };
}
