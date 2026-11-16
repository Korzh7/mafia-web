import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../wwwroot/js/voice.js', import.meta.url), 'utf8');
function stream(id) {
  const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ deviceId: id }) };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function harness(saved = null) {
  const storage = new Map(saved ? [['mafia_microphone_device', saved]] : []);
  const elements = new Map(['micDeviceSelect', 'micDeviceStatus', 'btnEchoTest'].map(id => [id, { value: '', disabled: false, textContent: '', appendChild() {}, innerHTML: '' }]));
  const h = { devices: [], calls: [], next: [], timers: new Map() };
  let timerId = 0;
  const context = {
    console, Map, Set, Uint8Array,
    setInterval(fn) { h.timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { h.timers.delete(id); },
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    navigator: { mediaDevices: { enumerateDevices: async () => h.devices, addEventListener(_, cb) { h.devicechange = cb; }, async getUserMedia(c) { h.calls.push(structuredClone(c)); const result = h.next.shift(); if (result instanceof Error) throw result; return await (result || stream('default-id')); } } },
    document: { getElementById: id => elements.get(id), createElement: () => ({}), querySelector: () => null },
    window: { addEventListener() {}, currentGameState: null, myUserId: 'me', AudioContext: class { state = 'running'; destination = {}; createMediaStreamSource() { const s = { connect() {}, disconnect() { s.disconnected = true; } }; h.sources.push(s); return s; } createAnalyser() { return { frequencyBinCount: 4 }; } } }
  };
  h.sources = [];
  vm.runInNewContext(source, context);
  return Object.assign(h, { engine: context.window.mafiaVoice, window: context.window, elements, storage });
}
const device = id => ({ kind: 'audioinput', deviceId: id, label: id });
const tick = () => new Promise(resolve => queueMicrotask(resolve));

test('enumerate before permission preserves saved preference; startup exact then missing fallback', async () => {
  const h = harness('missing'); await tick();
  expect(h.engine.selectedDeviceId).toBe('missing');
  expect(h.storage.get('mafia_microphone_device')).toBe('missing');
  h.next.push(Object.assign(new Error('missing'), { name: 'NotFoundError' }));
  expect(await h.engine.enableMicrophone()).toBe(true);
  expect(h.calls[0].audio.deviceId).toEqual({ exact: 'missing' });
  expect(h.calls[1].audio.deviceId).toBeUndefined();
  expect(h.storage.has('mafia_microphone_device')).toBe(false);
});

test('default is a preference, ensure does not recapture; explicit default switches and stops old tracks', async () => {
  const h = harness(); h.devices = [device('a')];
  await h.engine.selectMicrophone('a'); const old = h.engine.localStream;
  await h.engine.enableMicrophone(); expect(h.calls).toHaveLength(1);
  await h.engine.selectMicrophone('');
  expect(h.calls).toHaveLength(2); expect(h.calls[1].audio.deviceId).toBeUndefined();
  expect(h.engine.selectedDeviceId).toBeNull(); expect(old.track.stopped).toBe(true);
  expect(h.engine.localStream.track.enabled).toBe(true);
});

test('capture serialized, ensure shares pending request and busy controls reset', async () => {
  const h = harness(); let release;
  h.next.push(new Promise(r => { release = r; }));
  const first = h.engine.enableMicrophone(); const ensure = h.engine.enableMicrophone();
  const second = h.engine.selectMicrophone('b');
  expect(h.calls).toHaveLength(1); expect(h.elements.get('micDeviceSelect').disabled).toBe(true);
  expect(h.elements.get('btnEchoTest').disabled).toBe(true);
  release(stream('a')); await Promise.all([first, ensure, second]);
  expect(h.calls).toHaveLength(2); expect(h.engine.selectedDeviceId).toBe('b');
  expect(h.elements.get('btnEchoTest').disabled).toBe(false);
});

test('track disabled before attachment, phase and user mute preserved', async () => {
  const h = harness(); await h.engine.enableMicrophone();
  const sender = { track: h.engine.localStream.track, async replaceTrack(t) { if (t) expect(t.enabled).toBe(false); this.track = t; } };
  h.engine.peers.set('other', { sender });
  h.window.currentGameState = { phase: 4, slots: [{ userId: 'me', isAlive: true, roleCode: 'civilian' }] };
  await h.engine.selectMicrophone('night'); expect(h.engine.localStream.track.enabled).toBe(false); expect(sender.track).toBeNull();
  h.window.currentGameState = null; h.engine.userMutedMic = true;
  await h.engine.selectMicrophone('muted'); expect(h.engine.localStream.track.enabled).toBe(false);
});

test('rollback restores exact null and non-null sender tracks and leaves old stream alive', async () => {
  const h = harness('old'); await h.engine.enableMicrophone(); const old = h.engine.localStream;
  const a = { track: old.track, async replaceTrack(t) { this.track = t; } };
  const b = { track: null, async replaceTrack(t) { this.track = t; } };
  const c = { track: old.track, async replaceTrack() { throw new Error('sender fail'); } };
  h.engine.peers.set('a', { sender: a }); h.engine.peers.set('b', { sender: b }); h.engine.peers.set('c', { sender: c });
  const replacement = stream('new'); h.next.push(replacement);
  expect(await h.engine.selectMicrophone('new')).toBe(false);
  expect(a.track).toBe(old.track); expect(b.track).toBeNull(); expect(old.track.stopped).toBe(false);
  expect(replacement.track.stopped).toBe(true); expect(h.engine.localStream).toBe(old);
  expect(h.elements.get('micDeviceSelect').value).toBe('old');
  expect(h.elements.get('micDeviceStatus').textContent).toContain('Ошибка');
});

test('capture denied leaves old stream and selection untouched, without fallback', async () => {
  const h = harness(); await h.engine.selectMicrophone('old'); const old = h.engine.localStream;
  h.next.push(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  expect(await h.engine.selectMicrophone('bad')).toBe(false);
  expect(h.engine.localStream).toBe(old); expect(old.track.stopped).toBe(false);
  expect(h.storage.get('mafia_microphone_device')).toBe('old'); expect(h.calls).toHaveLength(2);
});

test('devicechange captures default when active device disappears after permission', async () => {
  const h = harness(); h.next.push(stream('usb')); h.devices = [device('usb')];
  await h.engine.selectMicrophone('usb'); const old = h.engine.localStream;
  h.devices = [device('default-id')]; await h.devicechange();
  expect(h.calls).toHaveLength(2); expect(h.calls[1].audio.deviceId).toBeUndefined();
  expect(old.track.stopped).toBe(true); expect(h.engine.selectedDeviceId).toBeNull();
});

test('echo stop clears source/timer and resets button, successful switch also cleans up', async () => {
  const h = harness(); await h.engine.enableMicrophone(); h.engine.startEchoTest();
  const source = h.engine.echoSource; const timer = h.engine.echoTimer;
  expect(source).toBeTruthy(); expect(h.timers.has(timer)).toBe(true);
  h.engine.stopEchoTest(); expect(source.disconnected).toBe(true); expect(h.timers.has(timer)).toBe(false);
  expect(h.elements.get('btnEchoTest').textContent).toBe('🎧 Тест микрофона');
  h.engine.startEchoTest(); const nextSource = h.engine.echoSource;
  await h.engine.selectMicrophone('next'); expect(nextSource.disconnected).toBe(true); expect(h.engine.echoTimer).toBeNull();
});

test('startup Overconstrained falls back, explicit missing selection does not', async () => {
  const h = harness('gone');
  h.next.push(Object.assign(new Error('constraints'), { name: 'OverconstrainedError' }));
  expect(await h.engine.enableMicrophone()).toBe(true);
  expect(h.calls).toHaveLength(2);
  const old = h.engine.localStream;
  h.next.push(Object.assign(new Error('gone'), { name: 'NotFoundError' }));
  expect(await h.engine.selectMicrophone('gone')).toBe(false);
  expect(h.calls).toHaveLength(3); expect(h.engine.localStream).toBe(old);
});

test('successful replacement stops every track of old stream', async () => {
  const h = harness(); const old = stream('old');
  const extra = { stopped: false, stop() { this.stopped = true; } };
  old.getTracks = () => [old.track, extra]; h.next.push(old);
  await h.engine.enableMicrophone(); await h.engine.selectMicrophone('new');
  expect(old.track.stopped).toBe(true); expect(extra.stopped).toBe(true);
});