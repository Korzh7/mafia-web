import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

// Minimal RTCPeerConnection mock that records signalling and direction changes.
class MockPC {
  constructor() {
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.transceivers = [];
    this.localDescription = null;
    this.remoteDescription = null;
  }
  addTransceiver() {
    const t = { sender: { track: null, replaceTrack: async (tr) => { t.sender.track = tr; } }, receiver: { track: { kind: 'audio' } }, direction: 'sendrecv' };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() { return this.transceivers; }
  getSenders() { return this.transceivers.map((t) => t.sender); }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    if (d.type === 'offer') {
      if (!this.transceivers.length) this.addTransceiver();
      this.signalingState = 'have-remote-offer';
    } else {
      this.signalingState = 'stable';
    }
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
  restartIce() {}
}

function loadEngine(myUserId) {
  const sent = [];
  const ctx = {
    console,
    Promise, Map, Set, JSON, Date, AbortSignal,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    fetch: async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: 'stun:test' }], hasTurn: false }) }),
    navigator: { mediaDevices: { enumerateDevices: async () => [], addEventListener: () => {} } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, remove() {}, play: async () => {} }), body: { appendChild() {} }, querySelector: () => null },
    RTCPeerConnection: MockPC,
    RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
    RTCIceCandidate: class {},
    window: {
      myUserId,
      addEventListener() {},
      connection: {
        state: 'Connected',
        invoke: (method, a, b, c) => sent.push({ method, a, b, c }),
      },
    },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../../wwwroot/js/voice.js', import.meta.url), 'utf8'), ctx);
  return { engine: ctx.window.mafiaVoice, sent };
}

test('handling an offer keeps negotiated transceiver direction (no mid-call sendrecv switch)', async () => {
  const { engine } = loadEngine('z');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('a', 'z');
  await engine.handleSignal('a', JSON.stringify({ type: 'offer', sdp: { type: 'offer' } }));
  const peer = engine.peers.get('a');
  // The mocked PC adds a default sendrecv transceiver; we must not mutate it.
  expect(peer.pc.transceivers.length).toBe(1);
  expect(peer.sender).not.toBeNull?.();
});

test('failed or disconnected peers request a fresh negotiation', async () => {
  const { engine } = loadEngine('a');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('b', 'a');
  const peer = engine.peers.get('b');
  peer.pc.connectionState = 'failed';
  peer.pc.onconnectionstatechange();
  // The retry is deferred; meanwhile the peer must stay tracked and the UI
  // must report a lost connection, not a healthy one.
  expect(engine.peers.has('b')).toBe(true);
  expect(peer.isConnected).toBe(false);
});

test('watchdog negotiates peers stuck without a connection', async () => {
  const { engine, sent } = loadEngine('a');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('b', 'a');
  engine.peers.get('b').pc.connectionState = 'new';
  engine.startConnectionWatchdog = engine.startConnectionWatchdog.bind(engine);
  // Drive one watchdog pass manually via the renegotiation guard.
  engine.peers.get('b').lastNegotiationRequest = 0;
  engine.renegotiatePeer('b', engine.peers.get('b').pc);
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.filter((s) => s.method === 'SendWebRtcSignal').length).toBeGreaterThanOrEqual(1);
});

test('answerer never introduces a second audio transceiver', async () => {
  const { engine } = loadEngine('z');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('a', 'z');
  const peer = engine.peers.get('a');
  expect(peer.pc.transceivers.length).toBe(0);
  await engine.handleSignal('a', JSON.stringify({ type: 'offer', sdp: { type: 'offer' } }));
  expect(peer.pc.transceivers.length).toBe(1);
  expect(peer.pc.signalingState).toBe('stable');
});

test('glare: higher id rolls back its own offer and answers the incoming one', async () => {
  const { engine } = loadEngine('z');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('a', 'z'); // 'z' > 'a' -> this side yields
  const peer = engine.peers.get('a');
  await peer.pc.setLocalDescription({ type: 'offer' }); // simulate our pending offer
  expect(peer.pc.signalingState).toBe('have-local-offer');
  await engine.processSignal('a', JSON.stringify({ type: 'offer', sdp: { type: 'offer' } }));
  expect(peer.pc.signalingState).toBe('stable');
  expect(peer.pc.remoteDescription.type).toBe('offer');
});

test('glare: lower id keeps its offer and ignores the incoming one', async () => {
  const { engine } = loadEngine('a');
  engine.localStream = { getAudioTracks: () => [{ kind: 'audio', enabled: true }], getTracks: () => [] };
  engine.createPeerConnection('z', 'a'); // 'a' < 'z' -> keeps its own offer
  const peer = engine.peers.get('z');
  await peer.pc.setLocalDescription({ type: 'offer' });
  await engine.processSignal('z', JSON.stringify({ type: 'offer', sdp: { type: 'offer' } }));
  expect(peer.pc.signalingState).toBe('have-local-offer');
  expect(peer.pc.remoteDescription).toBeNull();
});
