// Профессиональный WebRTC модуль голосовой связи:
// - Автоматический запуск микрофона при входе на сайт и по кнопке
// - Локальный эхо-тест для мгновенной проверки своего микрофона в наушниках
// - Гарантированное снятие блокировки звука на iOS Safari, Android и Desktop
// - 100% звукоизоляция ночной мафии (sender.replaceTrack(null) + remoteTrack.enabled = false + muted)
// - Жесткое глушение мертвых игроков на передаче и приеме
// - Честные кнопки микрофона и звука (не сбрасываются серверными таймерами)
// - Надежные глобальные STUN серверы Google, Cloudflare, Twilio

class MafiaVoiceEngine {
  constructor() {
    this.localStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.isMicEnabled = false;
    this.isEchoTesting = false;
    this.captureInFlight = null;
    this.selectedDeviceId = null;
    this.deviceStorageKey = 'mafia_microphone_device';
    this.analysisTimer = null;
    this.analysisSource = null;
    this.echoTimer = null;
    this.echoSource = null;

    // Пользовательские переключатели (персистентные, не сбрасываются игрой!)
    this.userMutedMic = false;   // Пользователь сам нажал "Заглушить микрофон"
    this.userMutedSound = false; // Пользователь сам нажал "Заглушить весь звук"

    // userId -> { pc, transceiver, sender, audioEl, candidateQueue, remoteTrack, remoteStream, isConnected }
    this.peers = new Map();

    // Множество активных говорящих для сохранения подсветки при ререндере
    this.activeSpeakers = new Set();

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ];

    this.lastSpeakingState = false;
    this.configurationReady = Promise.resolve();
    this.setupGlobalUnlockListeners();
    this.initDeviceSelection();
  }

  loadConfiguration() {
    this.configurationReady = fetch('/api/voice-config', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      .then(response => {
        if (!response.ok) throw new Error(`Voice config: ${response.status}`);
        return response.json();
      })
      .then(config => {
        if (config.iceServers?.length) this.iceServers = config.iceServers;
        if (!config.hasTurn) console.warn('[WebRTC] TURN is not configured: some networks cannot connect.');
      })
      .catch(error => console.warn('[WebRTC] Using default STUN configuration:', error));
    this.startConnectionWatchdog();
    return this.configurationReady;
  }

  // Регистрация постоянных слушателей пользовательских жестов для снятия блокировки звука в iOS/Android
  setupGlobalUnlockListeners() {
    const unlockHandler = () => {
      this.unlockAllAudio();
    };

    ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockHandler, { passive: true });
    });
  }

  // Ensure capture for existing callers; explicit selection always requests a switch.
  async enableMicrophone() {
    if (this.captureInFlight) return this.captureInFlight;
    if (this.isMicEnabled && this.localStream) return true;
    return this.queueMicrophoneCapture(this.selectedDeviceId, true);
  }

  async selectMicrophone(id) {
    return this.queueMicrophoneCapture(id || null, false);
  }

  queueMicrophoneCapture(deviceId, allowFallback) {
    const previous = this.captureInFlight;
    const operation = (async () => {
      if (previous) await previous;
      return this._captureMicrophone(deviceId, allowFallback);
    })();
    this.captureInFlight = operation;
    this.updateDeviceControls();
    return operation.finally(() => {
      if (this.captureInFlight === operation) this.captureInFlight = null;
      this.updateDeviceControls();
    });
  }

  async _captureMicrophone(deviceId, allowFallback) {
    let stream;
    try {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (deviceId) audio.deviceId = { exact: deviceId };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (error) {
        if (!allowFallback || !deviceId || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        deviceId = null;
        delete audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      }
      this.hasMicrophonePermission = true;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('Микрофон не найден');
      track.enabled = false; // Never transmit before phase/mute rules are applied.
      const changed = [];
      try {
        for (const peer of this.peers.values()) {
          const sender = peer.sender || peer.pc?.getSenders?.().find(s => s.track?.kind === 'audio');
          if (!sender) continue;
          const previousTrack = sender.track;
          await sender.replaceTrack(track);
          changed.push({ sender, previousTrack });
        }
      } catch (error) {
        for (const { sender, previousTrack } of changed.reverse()) {
          try { await sender.replaceTrack(previousTrack); } catch (rollbackError) {
            console.warn('[WebRTC] Microphone rollback failed:', rollbackError);
          }
        }
        throw error;
      }
      const oldStream = this.localStream;
      this.stopAudioAnalysis();
      this.stopEchoTest();
      this.localStream = stream;
      this.isMicEnabled = true;
      this.selectedDeviceId = deviceId || null; // Preference, not the resolved default device ID.
      this.persistSelectedDevice();
      this.applyPhaseVoiceRules(window.currentGameState);
      this.setupAudioAnalysis();
      oldStream?.getTracks().forEach(oldTrack => oldTrack.stop());
      this.setDeviceStatus('');
      this.updateNavbarButtons();
      await this.refreshAudioDevices(false);
      return true;
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      this.setDeviceStatus('Ошибка выбора микрофона. Предыдущий выбор сохранён.');
      const select = document.getElementById('micDeviceSelect');
      if (select) select.value = this.selectedDeviceId || '';
      this.updateNavbarButtons();
      return false;
    }
  }

  initDeviceSelection() {
    try { this.selectedDeviceId = localStorage.getItem(this.deviceStorageKey) || null; } catch (_) {}
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    devices.addEventListener?.('devicechange', () => this.refreshAudioDevices(true));
    this.refreshAudioDevices(false);
  }

  persistSelectedDevice() {
    try {
      if (this.selectedDeviceId) localStorage.setItem(this.deviceStorageKey, this.selectedDeviceId);
      else localStorage.removeItem(this.deviceStorageKey);
    } catch (_) {}
  }

  setDeviceStatus(text) {
    const status = document.getElementById('micDeviceStatus');
    if (status) status.textContent = text || '';
  }

  updateDeviceControls() {
    const select = document.getElementById('micDeviceSelect');
    const echo = document.getElementById('btnEchoTest');
    if (select) select.disabled = !!this.captureInFlight;
    if (echo) echo.disabled = !!this.captureInFlight;
  }

  async refreshAudioDevices(handleRemoval = true) {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      const select = document.getElementById('micDeviceSelect');
      if (select) {
        select.innerHTML = '<option value="">Системный микрофон</option>';
        devices.forEach((device, index) => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Микрофон ${index + 1}`;
          select.appendChild(option);
        });
        if (this.selectedDeviceId && !devices.some(d => d.deviceId === this.selectedDeviceId)) {
          const option = document.createElement('option');
          option.value = this.selectedDeviceId;
          option.textContent = 'Сохранённый микрофон';
          select.appendChild(option);
        }
        select.value = this.selectedDeviceId || '';
      }
      this.updateDeviceControls();
      if (!handleRemoval || !this.hasMicrophonePermission || !this.localStream || this.captureInFlight) return;
      const activeId = this.localStream.getAudioTracks()[0]?.getSettings?.().deviceId;
      if (activeId && !devices.some(d => d.deviceId === activeId)) {
        await this.selectMicrophone(null);
      }
    } catch (error) {
      console.warn('[WebRTC] Cannot enumerate microphones:', error);
    }
  }
  // Локальный эхо-тест: воспроизводит свой микрофон в свои наушники на 5 секунд
  startEchoTest() {
    if (!this.localStream) {
      this.enableMicrophone().then(ok => {
        if (ok) this.startEchoTest();
      });
      return;
    }

    if (this.isEchoTesting || this.captureInFlight) return;
    this.isEchoTesting = true;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const micSource = this.audioContext.createMediaStreamSource(this.localStream);
      this.echoSource = micSource;
      micSource.connect(this.audioContext.destination);

      const btnEcho = document.getElementById('btnEchoTest');
      let countdown = 5;
      if (btnEcho) btnEcho.textContent = `🎧 Говорите... ${countdown}с`;

      this.echoTimer = setInterval(() => {
        countdown--;
        if (countdown > 0 && btnEcho) {
          btnEcho.textContent = `🎧 Говорите... ${countdown}с`;
        } else {
          this.stopEchoTest();
        }
      }, 1000);
    } catch (e) {
      console.warn("[WebRTC] Ошибка запуска эхо-теста:", e);
      this.stopEchoTest();
    }
  }

  // Переключение своего микрофона (Мут / Размут)
  toggleMic() {
    if (!this.isMicEnabled) {
      this.enableMicrophone();
      return;
    }

    this.userMutedMic = !this.userMutedMic;
    console.log("[WebRTC] Пользовательский мут микрофона:", this.userMutedMic);

    if (window.currentGameState) {
      this.applyPhaseVoiceRules(window.currentGameState);
    } else {
      const myTrack = this.localStream ? this.localStream.getAudioTracks()[0] : null;
      if (myTrack) myTrack.enabled = !this.userMutedMic;
    }

    this.updateNavbarButtons();
    return !this.userMutedMic;
  }

  // Переключение звука стола (Слышать / Не слышать никого)
  toggleSound() {
    this.userMutedSound = !this.userMutedSound;
    console.log("[WebRTC] Пользовательский мут звука стола:", this.userMutedSound);

    if (window.currentGameState) {
      this.applyPhaseVoiceRules(window.currentGameState);
    } else {
      this.peers.forEach(peer => {
        if (peer.audioEl) {
          peer.audioEl.muted = this.userMutedSound;
          peer.audioEl.volume = this.userMutedSound ? 0.0 : 1.0;
        }
      });
    }

    if (window.mafiaAudio) {
      window.mafiaAudio.muted = this.userMutedSound;
    }

    this.updateNavbarButtons();
    return !this.userMutedSound;
  }

  updateNavbarButtons() {
    const btnMic = document.getElementById('btnToggleMic');
    if (btnMic) {
      if (!this.isMicEnabled) {
        btnMic.textContent = '🎙️ Разрешить микрофон';
        btnMic.className = 'btn btn-gold';
      } else if (this.userMutedMic) {
        btnMic.textContent = '🔇 Микрофон: ВЫКЛ';
        btnMic.className = 'btn btn-danger';
      } else {
        btnMic.textContent = '🎙️ Микрофон: ВКЛ';
        btnMic.className = 'btn btn-success';
      }
      btnMic.style.width = 'auto';
    }

    const btnSound = document.getElementById('btnToggleMute');
    if (btnSound) {
      if (this.userMutedSound) {
        btnSound.textContent = '🔇 Звук: ВЫКЛ';
        btnSound.className = 'btn btn-danger';
      } else {
        btnSound.textContent = '🔊 Звук: ВКЛ';
        btnSound.className = 'btn';
      }
      btnSound.style.width = 'auto';
    }
  }

  // Разблокировка Web Audio и всех аудио-элементов при любом тапе на экран
  unlockAllAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
    } catch (e) {}

    // Разблокируем воспроизведение звука пиров при первом жесте
    this.peers.forEach(peer => {
      if (peer.audioEl) {
        if (peer.remoteStream && peer.audioEl.srcObject !== peer.remoteStream) {
          peer.audioEl.srcObject = peer.remoteStream;
        }
        if (peer.audioEl.paused) {
          peer.audioEl.play().catch(() => {});
        }
      }
    });

    if (window.mafiaAudio) {
      window.mafiaAudio.init();
    }
  }

  // Анализ громкости для подсветки активного говорящего
  setupAudioAnalysis() {
    if (!this.localStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analysisSource = source;
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.analysisTimer = setInterval(() => {
        const state = window.currentGameState;
        const mySlot = state?.slots?.find(s => s.userId === window.myUserId);
        const isMeAlive = mySlot ? mySlot.isAlive : true;

        if (!this.isMicEnabled || !this.localStream || this.userMutedMic || !isMeAlive) {
          if (this.lastSpeakingState) {
            this.lastSpeakingState = false;
            if (window.connection && (window.connection.state === "Connected" || window.connection.state === 1)) {
              window.connection.invoke("SendVoiceActivity", window.myUserId, false);
            }
            this.highlightSpeaker(window.myUserId, false);
          }
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isSpeaking = avg > 10; // чувствительный порог для мобильных микрофонов

        if (isSpeaking !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeaking;
          if (window.connection && (window.connection.state === "Connected" || window.connection.state === 1)) {
            window.connection.invoke("SendVoiceActivity", window.myUserId, isSpeaking);
          }
          this.highlightSpeaker(window.myUserId, isSpeaking);
        }
      }, 100);
    } catch (e) {
      console.warn("[WebRTC] Анализ громкости не поддерживается:", e);
    }
  }

  stopAudioAnalysis() {
    if (this.analysisTimer !== null) clearInterval(this.analysisTimer);
    this.analysisTimer = null;
    try { this.analysisSource?.disconnect(); } catch (_) {}
    this.analysisSource = null;
    this.analyser = null;
  }

  stopEchoTest() {
    if (this.echoTimer !== null) clearInterval(this.echoTimer);
    this.echoTimer = null;
    try { this.echoSource?.disconnect(); } catch (_) {}
    this.echoSource = null;
    this.isEchoTesting = false;
    const button = document.getElementById('btnEchoTest');
    if (button) button.textContent = '🎧 Тест микрофона';
  }
  resetPeers() {
    this.peers.forEach(peer => {
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
      peer.audioEl.remove();
    });
    this.peers.clear();
  }

  // Синхронизация пиров за столом
  syncPeers(slots, myUserId) {
    slots.forEach(slot => {
      if (!slot.isOccupied || !slot.userId || slot.userId === myUserId) return;

      const peerUserId = slot.userId;
      if (!this.peers.has(peerUserId)) {
        this.createPeerConnection(peerUserId, myUserId);
      }
    });

    for (const [peerId, peer] of this.peers.entries()) {
      const exists = slots.some(s => s.userId === peerId && s.isOccupied);
      if (!exists) {
        console.log("[WebRTC] Закрытие соединения с вышедшим игроком:", peerId);
        if (peer.pc) peer.pc.close();
        if (peer.audioEl) peer.audioEl.remove();
        this.peers.delete(peerId);
      }
    }
  }

  createPeerConnection(peerUserId, myUserId) {
    console.log("[WebRTC] Создание PeerConnection для:", peerUserId);
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2
    });

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.preload = 'auto';
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    audioEl.setAttribute('data-peer-user-id', peerUserId);
    // Для совместимости с iOS Safari не используем display: none
    audioEl.style.position = 'fixed';
    audioEl.style.left = '-9999px';
    audioEl.style.top = '-9999px';
    audioEl.style.width = '1px';
    audioEl.style.height = '1px';
    audioEl.style.opacity = '0.01';
    document.body.appendChild(audioEl);

    // Добавляем аудио-трансивер sendrecv сразу
    // Only the offerer creates the initial transceiver. The answerer must use
    // the transceiver created by setRemoteDescription, otherwise audio can end
    // up on a second, unnegotiated m-line.
    const initiator = myUserId < peerUserId;
    const transceiver = initiator ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null;
    const sender = transceiver?.sender;

    const peerInfo = {
      pc: pc,
      transceiver: transceiver,
      sender: sender,
      audioEl: audioEl,
      candidateQueue: [],
      remoteTrack: null,
      remoteStream: null,
      isConnected: false,
      makingOffer: false,
      signalChain: Promise.resolve()
    };

    this.peers.set(peerUserId, peerInfo);

    if (this.localStream) {
      const myTrack = this.localStream.getAudioTracks()[0];
      if (sender && myTrack && !this.userMutedMic) {
        sender.replaceTrack(myTrack).catch(err => console.warn("[WebRTC] Initial replaceTrack error:", err));
      }
    }

    pc.ontrack = (event) => {
      console.log("[WebRTC] Получен удаленный аудиопоток от:", peerUserId);
      const stream = (event.streams && event.streams.length > 0 && event.streams[0])
        ? event.streams[0]
        : new MediaStream([event.track]);

      peerInfo.remoteStream = stream;
      peerInfo.remoteTrack = event.track;

      if (audioEl.srcObject !== stream) {
        audioEl.srcObject = stream;
      }

      audioEl.play().catch(err => {
        console.warn("[WebRTC] Автовоспроизведение звука ожидает жеста пользователя:", err);
      });

      if (window.currentGameState) {
        this.applyPhaseVoiceRules(window.currentGameState);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && window.connection && (window.connection.state === "Connected" || window.connection.state === 1)) {
        window.connection.invoke("SendWebRtcSignal", myUserId, peerUserId, JSON.stringify({
          type: 'candidate',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE статус с ${peerUserId}:`, pc.iceConnectionState);
      const iceOk = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      // ICE can be "connected" while media flows only one way, so the end-to-end
      // connection state stays authoritative when the browser reports it.
      if (pc.connectionState === 'connected') peerInfo.isConnected = true;
      else if (!iceOk) peerInfo.isConnected = false;
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[WebRTC] ICE failed для ${peerUserId}, перезапуск ICE...`);
        if (myUserId < peerUserId) {
          try {
            pc.restartIce();
            this.renegotiatePeer(peerUserId, pc);
          } catch (e) {}
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Статус соединения с ${peerUserId}:`, pc.connectionState);
      peerInfo.isConnected = pc.connectionState === 'connected';
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setTimeout(() => {
          const currentPeer = this.peers.get(peerUserId);
          if (currentPeer && currentPeer.pc === pc &&
              (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
            console.log(`[WebRTC] Попытка авто-восстановления связи с ${peerUserId}...`);
            this.reconnectPeer(peerUserId);
          }
        }, pc.connectionState === 'failed' ? 4000 : 8000);
      }
      if (window.currentGameState && window.refreshVoiceIndicators) {
        window.refreshVoiceIndicators(window.currentGameState);
      }
    };

    // The lower id opens the negotiation, the other side answers. Never start
    // both: two simultaneous offers put one peer into an unrecoverable glare.
    if (myUserId < peerUserId) {
      this.renegotiatePeer(peerUserId, pc);
    }
    return peerInfo;
  }

  reconnectPeer(peerUserId) {
    const peer = this.peers.get(peerUserId);
    if (!peer) return;

    console.log(`[WebRTC] Перезапуск соединения с ${peerUserId}`);
    try {
      if (peer.pc) peer.pc.close();
      if (peer.audioEl) peer.audioEl.remove();
    } catch (e) {}

    this.peers.delete(peerUserId);
    const created = this.createPeerConnection(peerUserId, window.myUserId);
    // Only the lower id opens the negotiation. The other side answers; if it
    // also sent an offer both peers would end up in an unrecoverable glare.
    if (created && window.myUserId < peerUserId) {
      this.renegotiatePeer(peerUserId, created.pc);
    }
    return created;
  }

  // Repair pairs whose initial offer/answer was lost (for example a peer
  // created before the signal connection or the microphone was ready).
  startConnectionWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const signalingReady = window.connection &&
        (window.connection.state === 'Connected' || window.connection.state === 1);
      if (!signalingReady) return;
      this.peers.forEach((peer, peerUserId) => {
        const pc = peer.pc;
        // Only the designated initiator repairs a pair; the other side must
        // never race it with a second offer.
        if (window.myUserId >= peerUserId) return;
        if (!pc || pc.signalingState !== 'stable' || peer.isConnected) return;
        if (pc.connectionState === 'connected') { peer.isConnected = true; return; }
        const now = Date.now();
        // Exponential backoff: 5s, 10s, 20s, then every 30s.
        peer.watchdogAttempts = (peer.watchdogAttempts || 0) + 1;
        const wait = Math.min(5000 * Math.pow(2, peer.watchdogAttempts - 1), 30000);
        if (peer.lastNegotiationRequest && now - peer.lastNegotiationRequest < wait) return;
        peer.lastNegotiationRequest = now;
        console.log(`[WebRTC] Повторная попытка соединения с ${peerUserId} (${peer.watchdogAttempts})`);
        this.renegotiatePeer(peerUserId, pc);
      });
    }, 5000);
  }

  renegotiatePeer(peerUserId, pc) {
    const peer = this.peers.get(peerUserId);
    if (!peer || peer.makingOffer || pc.signalingState !== 'stable') {
      return;
    }
    peer.makingOffer = true;

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        if (window.connection && (window.connection.state === "Connected" || window.connection.state === 1)) {
          window.connection.invoke("SendWebRtcSignal", window.myUserId, peerUserId, JSON.stringify({
            type: 'offer',
            sdp: pc.localDescription
          }));
        }
      })
      .catch(err => console.error("[WebRTC] Ошибка Offer:", err))
      .finally(() => { peer.makingOffer = false; });
  }

  handleSignal(senderUserId, signalStr) {
    if (!this.peers.has(senderUserId)) {
      this.createPeerConnection(senderUserId, window.myUserId);
    }
    const peer = this.peers.get(senderUserId);
    // SignalR does not await async event handlers. Serialize SDP and ICE so
    // candidates and repeated offers cannot race setRemoteDescription.
    peer.signalChain = peer.signalChain
      .then(() => this.processSignal(senderUserId, signalStr))
      .catch(err => console.error('[WebRTC] Signal processing failed:', err));
    return peer.signalChain;
  }

  async processSignal(senderUserId, signalStr) {
    try {
      const data = JSON.parse(signalStr);
      let peer = this.peers.get(senderUserId);

      if (!peer) {
        this.createPeerConnection(senderUserId, window.myUserId);
        peer = this.peers.get(senderUserId);
      }

      const pc = peer.pc;

      if (data.type === 'offer') {
        // Glare: both sides offered at once. Only the side with the higher id
        // yields by rolling back its own pending offer; the lower id keeps
        // its offer and ignores the incoming one, the peer will resend it
        // after it receives our answer.
        if (pc.signalingState === 'have-local-offer') {
          if (window.myUserId > senderUserId) {
            console.warn(`[WebRTC] Glare с ${senderUserId}: откат своего предложения`);
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch (e) {
              console.warn('[WebRTC] Откат не удался, пересоздаём соединение:', e);
              this.reconnectPeer(senderUserId);
              return;
            }
          } else {
            console.warn(`[WebRTC] Glare с ${senderUserId}: игнорируем чужое предложение`);
            return;
          }
        }

        if (pc.signalingState !== 'stable') {
          console.warn(`[WebRTC] Пропуск offer в состоянии ${pc.signalingState} от ${senderUserId}`);
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (!peer.transceiver) {
          peer.transceiver = pc.getTransceivers().find(t => t.receiver?.track?.kind === 'audio');
        }
        if (peer.transceiver && peer.transceiver.direction !== 'sendrecv') {
          peer.transceiver.direction = 'sendrecv';
        }
        peer.sender = peer.transceiver?.sender;
        const track = this.localStream?.getAudioTracks()[0];
        if (peer.sender) {
          await peer.sender.replaceTrack(track || null);
        }
        if (window.currentGameState) this.applyPhaseVoiceRules(window.currentGameState);

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e) {}
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (window.connection && (window.connection.state === "Connected" || window.connection.state === 1)) {
          window.connection.invoke("SendWebRtcSignal", window.myUserId, senderUserId, JSON.stringify({
            type: 'answer',
            sdp: pc.localDescription
          }));
        }
      } else if (data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

          while (peer.candidateQueue.length > 0) {
            const cand = peer.candidateQueue.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {}
          }
        }
      } else if (data.type === 'candidate' && data.candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          peer.candidateQueue.push(data.candidate);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error("[WebRTC] Ошибка обработки сигнала:", err);
      // A failed offer/answer leaves this pair unusable forever. Recreate the
      // connection instead of silently retrying against a broken session.
      if (err && (err.name === 'InvalidAccessError' || err.name === 'InvalidStateError' ||
          err.name === 'OperationError')) {
        const stale = this.peers.get(senderUserId);
        if (stale && Date.now() - (stale.lastReconnect || 0) > 10000) {
          stale.lastReconnect = Date.now();
          this.reconnectPeer(senderUserId);
        }
      }
    }
  }

  // СТРОГОЕ УПРАВЛЕНИЕ АУДИОПОТОКАМИ
  applyPhaseVoiceRules(state) {
    if (!state) {
      const track = this.localStream?.getAudioTracks()[0];
      if (track) track.enabled = !this.userMutedMic;
      return;
    }
    window.currentGameState = state;

    const mySlot = state.slots.find(s => s.userId === window.myUserId);
    const isMeAlive = mySlot ? mySlot.isAlive : true;
    const isMeMafia = mySlot && (mySlot.roleCode === 'mafia' || mySlot.roleCode === 'don');
    const myTrack = this.localStream ? this.localStream.getAudioTracks()[0] : null;

    // Вспомогательная функция управления отправкой аудио в конкретный PeerConnection
    const setAudioSenderActive = (peer, active) => {
      try {
        const sender = peer.sender || (peer.pc.getSenders() && peer.pc.getSenders()[0]);
        if (!sender) return;

        if (active && myTrack && !this.userMutedMic && isMeAlive) {
          if (sender.track !== myTrack) {
            sender.replaceTrack(myTrack).catch(err => console.warn("[WebRTC] replaceTrack error:", err));
          }
        } else {
          if (sender.track !== null) {
            sender.replaceTrack(null).catch(err => console.warn("[WebRTC] replaceTrack(null) error:", err));
          }
        }
      } catch (e) {
        console.warn("[WebRTC] setAudioSenderActive error:", e);
      }
    };

    // Вспомогательная функция управления приемом звука от пира (БЕЗ сброса srcObject и БЕЗ вызова pause!)
    const setPeerPlayback = (peer, shouldHear) => {
      if (!peer.audioEl) return;

      if (peer.remoteStream && peer.audioEl.srcObject !== peer.remoteStream) {
        peer.audioEl.srcObject = peer.remoteStream;
      }

      if (shouldHear && !this.userMutedSound) {
        peer.audioEl.muted = false;
        peer.audioEl.volume = 1.0;
        if (peer.remoteTrack) {
          peer.remoteTrack.enabled = true;
        }
        if (peer.audioEl.paused) {
          peer.audioEl.play().catch(() => {});
        }
      } else {
        // Мьютим и выключаем remoteTrack, сохраняя сессию воспроизведения непрерывной
        peer.audioEl.muted = true;
        peer.audioEl.volume = 0.0;
        if (peer.remoteTrack) {
          peer.remoteTrack.enabled = false;
        }
      }
    };

    // 1. МЕРТВЫЙ ИГРОК: микрофон заблокирован во всех фазах
    if (!isMeAlive && state.phase !== 0 && state.phase !== 5) {
      if (myTrack) myTrack.enabled = false;
      this.peers.forEach((peer, peerUserId) => {
        setAudioSenderActive(peer, false);
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : false;
        setPeerPlayback(peer, isPeerAlive && state.phase !== 1 && state.phase !== 4);
      });
      this.updateNavbarButtons();
      return;
    }

    // 2. НОЧЬ (Фаза 1 - Нулевая ночь / договорка мафии, Фаза 4 - Обычная ночь)
    if (state.phase === 1 || state.phase === 4) {
      if (isMeMafia) {
        // Живой член мафии: говорит ТОЛЬКО с живыми напарниками
        const canSpeak = !this.userMutedMic;
        if (myTrack) myTrack.enabled = canSpeak;

        this.peers.forEach((peer, peerUserId) => {
          const peerSlot = state.slots.find(s => s.userId === peerUserId);
          const isPeerMafia = peerSlot && peerSlot.isAlive && (peerSlot.roleCode === 'mafia' || peerSlot.roleCode === 'don');

          if (isPeerMafia) {
            setAudioSenderActive(peer, true);
            setPeerPlayback(peer, true);
          } else {
            setAudioSenderActive(peer, false);
            setPeerPlayback(peer, false);
          }
        });
      } else {
        // Мирный житель или шериф: СПИТ!
        if (myTrack) myTrack.enabled = false;

        this.peers.forEach(peer => {
          setAudioSenderActive(peer, false);
          setPeerPlayback(peer, false);
        });
      }
    } else if (state.phase === 2 || state.phase === 6) {
      // 3. ДЕНЬ (Фаза 2): Говорит назначенный спикер ИЛИ выкрик (проверяем через state.canSpeakNow)
      const isCurrentSpeaker = (state.currentSpeakerSlot === mySlot?.slotNumber) && !mySlot?.losesNextSpeech;
      const isMeShouting = (state.phase === 2 && state.activeShoutSlotNumber === mySlot?.slotNumber);
      const canSpeak = (state.canSpeakNow ?? (isCurrentSpeaker || isMeShouting)) && !this.userMutedMic;
      if (myTrack) myTrack.enabled = canSpeak;

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : false;
        const isPeerSpeaker = peerSlot ? (peerSlot.isCurrentSpeaker && !peerSlot.losesNextSpeech) : false;
        const isPeerShouting = peerSlot ? (state.phase === 2 && peerSlot.slotNumber === state.activeShoutSlotNumber) : false;

        setAudioSenderActive(peer, canSpeak);
        setPeerPlayback(peer, isPeerAlive && (isPeerSpeaker || isPeerShouting));
      });
    } else {
      // 4. Лобби (0), Голосование (3), Подъём группы (7), Конец игры (5): свободный микрофон
      const canSpeak = isMeAlive && !this.userMutedMic;
      if (myTrack) myTrack.enabled = canSpeak;

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : true;

        setAudioSenderActive(peer, isMeAlive);
        setPeerPlayback(peer, isPeerAlive);
      });
    }

    this.updateNavbarButtons();
  }

  highlightSpeaker(userId, isSpeaking) {
    if (isSpeaking) {
      this.activeSpeakers.add(userId);
    } else {
      this.activeSpeakers.delete(userId);
    }

    const card = document.querySelector(`.seat-card[data-user-id="${userId}"]`);
    if (card) {
      if (isSpeaking) {
        card.classList.add('speaking');
      } else {
        card.classList.remove('speaking');
      }
    }
  }
}

window.mafiaVoice = new MafiaVoiceEngine();
