import { describe, expect, it } from 'vitest';
import { classifyDevice, kindFromId, parseFlutterDevices, pickDevice, proxyRouteFor } from '../src/devices';

const MACHINE = `Waiting for devices...
[
  {"name":"sdk gphone64 arm64","id":"emulator-5554","isSupported":true,"targetPlatform":"android-arm64","emulator":true},
  {"name":"Pixel 8","id":"PIXEL0001","isSupported":true,"targetPlatform":"android-arm64","emulator":false},
  {"name":"iPhone 17","id":"11111111-2222-3333-4444-555555555555","targetPlatform":"ios","emulator":true},
  {"name":"My iPhone","id":"00008110-000A0B0C0D0E0F10","targetPlatform":"ios","emulator":false},
  {"name":"macOS","id":"macos","targetPlatform":"darwin","emulator":false},
  {"name":"Chrome","id":"chrome","targetPlatform":"web-javascript","emulator":false}
]`;

describe('devices', () => {
  const devices = parseFlutterDevices(MACHINE);

  it('parses flutter devices --machine after log lines', () => {
    expect(devices.map((d) => d.id)).toEqual(['emulator-5554', 'PIXEL0001', '11111111-2222-3333-4444-555555555555', '00008110-000A0B0C0D0E0F10', 'macos', 'chrome']);
    expect(parseFlutterDevices('no json here')).toEqual([]);
    expect(parseFlutterDevices('[{"name":"x"}, 3, {"id":"ok"}]')).toEqual([{ id: 'ok' }]);
  });

  it('classifies devices', () => {
    expect(devices.map(classifyDevice)).toEqual(['android-emulator', 'android-physical', 'ios-simulator', 'ios-physical', 'desktop', 'web']);
    // other Android emulators (not emulator-*) get adb reverse like physical devices
    expect(classifyDevice({ id: 'localhost:5555', targetPlatform: 'android-x64', emulator: true })).toBe('android-physical');
    expect(classifyDevice({ id: 'linux', targetPlatform: 'linux-x64' })).toBe('desktop');
    expect(classifyDevice({ id: 'x', targetPlatform: 'fuchsia' })).toBe('unknown');
    expect(kindFromId('windows')).toBe('desktop');
    expect(kindFromId('emulator-5556')).toBe('android-emulator');
    expect(kindFromId('web-server')).toBe('web');
    expect(kindFromId('PIXEL0001')).toBeUndefined();
  });

  it('maps each device kind to the proxy host (CONTRACTS §2)', () => {
    expect(proxyRouteFor('android-emulator', 'emulator-5554')).toEqual({ ok: true, host: '10.0.2.2', adbReverse: false });
    expect(proxyRouteFor('android-physical', 'PIXEL0001')).toEqual({ ok: true, host: 'localhost', adbReverse: true });
    expect(proxyRouteFor('ios-simulator', 'sim')).toEqual({ ok: true, host: 'localhost', adbReverse: false });
    expect(proxyRouteFor('desktop', 'macos')).toEqual({ ok: true, host: 'localhost', adbReverse: false });
    // physical iPhones use the LAN listener (CONTRACTS §14.1): the host is the LAN address, found at run time
    expect(proxyRouteFor('ios-physical', 'phone')).toEqual({ ok: true, host: '', adbReverse: false, lan: true });
    expect(proxyRouteFor('web', 'chrome').ok).toBe(false);
    expect(proxyRouteFor('unknown', 'x').ok).toBe(false);
  });

  it('picks the requested device, by id or name', () => {
    expect(pickDevice('PIXEL0001', devices)).toEqual({ id: 'PIXEL0001', kind: 'android-physical', name: 'Pixel 8' });
    expect(pickDevice('iphone 17', devices).kind).toBe('ios-simulator');
    expect(pickDevice('macos', undefined)).toEqual({ id: 'macos', kind: 'desktop' });
    expect(() => pickDevice('nope', devices)).toThrow(/device nope not found\. Connected: emulator-5554/);
  });

  it('picks the only non-web device, else asks for --device', () => {
    expect(pickDevice(undefined, [{ id: 'chrome', targetPlatform: 'web-javascript' }, { id: 'macos', targetPlatform: 'darwin' }]).id).toBe('macos');
    expect(() => pickDevice(undefined, devices)).toThrow(/several devices are connected: pass --device/);
    expect(() => pickDevice(undefined, [])).toThrow(/no device found/);
  });
});
