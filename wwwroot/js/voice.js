// Модуль голосовой связи WebRTC (Peer-to-Peer с шумоподавлением и контролем фаз игры)
class MafiaVoiceEngine {
  constructor() {
    this.localStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.isMicEnabled = false;
    this.peers = new Map(); // userId -> { pc, audioEl, isMuted }
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ];
    this.lastSpeakingState = false;
  }

  // Запрос доступа к микрофону
  async enableMicrophone() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.isMicEnabled = true;
      this.setupAudioAnalysis();
      console.log("Микрофон успешно подключен");
      return true;
    } catch (err) {
      console.error("Ошибка доступа к микрофону:", err);
      alert("Не удалось получить доступ к микрофону. Проверьте разрешения браузера.");
      return false;
    }
  }

  // Анализ громкости для индикатора речи (зеленая рамка)
  setupAudioAnalysis() {
    if (!this.localStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      setInterval(() => {
        if (!this.isMicEnabled || !this.localStream) return;
        this.analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isSpeaking = avg > 15; // Порог речи

        if (isSpeaking !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeaking;
          if (window.connection && window.connection.state === "Connected") {
            window.connection.invoke("SendVoiceActivity", window.myUserId, isSpeaking);
          }
          this.highlightSpeaker(window.myUserId, isSpeaking);
        }
      }, 120);
    } catch (e) {
      console.warn("Анализ громкости не поддерживается:", e);
    }
  }

  // Подключение к другим игрокам
  syncPeers(slots, myUserId) {
    if (!this.localStream) return;

    slots.forEach(slot => {
      if (!slot.isOccupied || !slot.userId || slot.userId === myUserId) return;

      const peerUserId = slot.userId;
      if (!this.peers.has(peerUserId)) {
        this.createPeerConnection(peerUserId, myUserId);
      }
    });

    // Очистка отключившихся игроков
    for (const [peerId, peer] of this.peers.entries()) {
      const exists = slots.some(s => s.userId === peerId && s.isOccupied);
      if (!exists) {
        if (peer.pc) peer.pc.close();
        if (peer.audioEl) peer.audioEl.remove();
        this.peers.delete(peerId);
      }
    }
  }

  createPeerConnection(peerUserId, myUserId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // Добавляем наш аудиотрек
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Аудиоэлемент для воспроизведения голоса собеседника
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', 'true');
    document.body.appendChild(audioEl);

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && window.connection) {
        window.connection.invoke("SendWebRtcSignal", myUserId, peerUserId, JSON.stringify({
          type: 'candidate',
          candidate: event.candidate
        }));
      }
    };

    this.peers.set(peerUserId, { pc, audioEl });

    // Инициатор оффера (тот, чей ID лексикографически меньше)
    if (myUserId < peerUserId) {
      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        if (window.connection) {
          window.connection.invoke("SendWebRtcSignal", myUserId, peerUserId, JSON.stringify({
            type: 'offer',
            sdp: pc.localDescription
          }));
        }
      }).catch(err => console.error("Ошибка createOffer:", err));
    }
  }

  // Обработка входящего WebRTC сигнала (offer / answer / candidate)
  async handleSignal(senderUserId, signalStr) {
    try {
      const data = JSON.parse(signalStr);
      let peer = this.peers.get(senderUserId);

      if (!peer) {
        this.createPeerConnection(senderUserId, window.myUserId);
        peer = this.peers.get(senderUserId);
      }

      const pc = peer.pc;

      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (window.connection) {
          window.connection.invoke("SendWebRtcSignal", window.myUserId, senderUserId, JSON.stringify({
            type: 'answer',
            sdp: pc.localDescription
          }));
        }
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate') {
        if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }
    } catch (err) {
      console.error("Ошибка handleSignal:", err);
    }
  }

  // Управление громкостью и микрофонами в зависимости от фазы игры
  applyPhaseVoiceRules(state) {
    if (!this.localStream) return;

    const mySlot = state.slots.find(s => s.slotNumber === state.mySlotNumber);
    const isMeMafia = mySlot && (mySlot.roleCode === 'mafia' || mySlot.roleCode === 'don');
    const myTrack = this.localStream.getAudioTracks()[0];

    // Фаза 1 (Нулевая ночь) и Фаза 4 (Обычная ночь)
    if (state.phase === 1 || state.phase === 4) {
      if (isMeMafia) {
        // Мафия говорит между собой
        if (myTrack) myTrack.enabled = true;

        // Слышим только напарников-мафиози
        this.peers.forEach((peer, peerUserId) => {
          const peerSlot = state.slots.find(s => s.userId === peerUserId);
          const isPeerMafia = peerSlot && (peerSlot.roleCode === 'mafia' || peerSlot.roleCode === 'don');
          peer.audioEl.volume = isPeerMafia ? 1.0 : 0.0;
        });
      } else {
        // Мирные жители спят: их микрофон выключен, чужой звук заглушен
        if (myTrack) myTrack.enabled = false;
        this.peers.forEach(peer => {
          peer.audioEl.volume = 0.0;
        });
      }
    } else if (state.phase === 2) {
      // Фаза 2: Дневное обсуждение
      const isCurrentSpeaker = state.currentSpeakerSlot === state.mySlotNumber;
      if (myTrack) {
        // В строгом режиме говорит только спикер
        myTrack.enabled = isCurrentSpeaker;
      }
      this.peers.forEach(peer => {
        peer.audioEl.volume = 1.0;
      });
    } else {
      // Лобби, Голосование, Конец игры — свободный микрофон
      if (myTrack) myTrack.enabled = true;
      this.peers.forEach(peer => {
        peer.audioEl.volume = 1.0;
      });
    }
  }

  highlightSpeaker(userId, isSpeaking) {
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
