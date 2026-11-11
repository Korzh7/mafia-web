// Профессиональный WebRTC модуль голосовой связи с поддержкой TURN-серверов,
// обходом ограничений iOS/Android, строгой изоляцией ночной мафии и глушением мертвых
class MafiaVoiceEngine {
  constructor() {
    this.localStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.isMicEnabled = false;
    this.peers = new Map(); // userId -> { pc, audioEl, candidateQueue, remoteTrack, isConnected }
    
    // Надежные STUN + TURN сервера для пробития мобильных сетей и роутеров
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
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
      this.unlockAllAudio();
      console.log("[WebRTC] Микрофон успешно получен");

      // Добавляем трек во все существующие пир-соединения
      this.peers.forEach((peer, peerUserId) => {
        const senders = peer.pc.getSenders();
        const hasTrack = senders.some(s => s.track && s.track.kind === 'audio');
        if (!hasTrack && this.localStream) {
          this.localStream.getAudioTracks().forEach(track => {
            peer.pc.addTrack(track, this.localStream);
          });
          this.renegotiatePeer(peerUserId, peer.pc);
        }
      });

      return true;
    } catch (err) {
      console.error("[WebRTC] Ошибка доступа к микрофону:", err);
      alert("Не удалось включить микрофон. Пожалуйста, разрешите доступ к микрофону в браузере.");
      return false;
    }
  }

  // Снятие блокировки звука мобильных браузеров
  unlockAllAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      this.peers.forEach(peer => {
        if (peer.audioEl) {
          peer.audioEl.play().catch(() => {});
        }
      });
    } catch (e) {}
  }

  // Анализ громкости для подсветки активного спикера
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
        const isSpeaking = avg > 12;

        if (isSpeaking !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeaking;
          if (window.connection && window.connection.state === "Connected") {
            window.connection.invoke("SendVoiceActivity", window.myUserId, isSpeaking);
          }
          this.highlightSpeaker(window.myUserId, isSpeaking);
        }
      }, 100);
    } catch (e) {
      console.warn("[WebRTC] Анализ громкости не поддерживается:", e);
    }
  }

  // Синхронизация соединений для всех занятых слотов
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
        console.log("[WebRTC] Удаление соединения с вышедшим игроком:", peerId);
        if (peer.pc) peer.pc.close();
        if (peer.audioEl) peer.audioEl.remove();
        this.peers.delete(peerId);
      }
    }
  }

  createPeerConnection(peerUserId, myUserId) {
    console.log("[WebRTC] Создание PeerConnection для:", peerUserId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // Создаем аудиоэлемент со всеми флагами для мобильных Safari / Chrome
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', 'true');
    audioEl.setAttribute('webkit-playsinline', 'true');
    audioEl.setAttribute('data-peer-user-id', peerUserId);
    document.body.appendChild(audioEl);

    const peerInfo = {
      pc: pc,
      audioEl: audioEl,
      candidateQueue: [],
      remoteTrack: null,
      isConnected: false
    };

    this.peers.set(peerUserId, peerInfo);

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.ontrack = (event) => {
      console.log("[WebRTC] Получен удаленный аудиопоток от:", peerUserId);
      peerInfo.remoteTrack = event.track;
      audioEl.srcObject = event.streams[0];
      audioEl.muted = false;
      audioEl.volume = 1.0;

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.warn("[WebRTC] Автовоспроизведение ожидает клика:", err);
          const unlock = () => {
            audioEl.play().catch(() => {});
            document.removeEventListener('click', unlock);
            document.removeEventListener('touchstart', unlock);
          };
          document.addEventListener('click', unlock);
          document.addEventListener('touchstart', unlock);
        });
      }

      // Немедленно применяем правила текущей фазы
      if (window.currentGameState) {
        this.applyPhaseVoiceRules(window.currentGameState);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && window.connection) {
        window.connection.invoke("SendWebRtcSignal", myUserId, peerUserId, JSON.stringify({
          type: 'candidate',
          candidate: event.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Статус соединения с ${peerUserId}:`, pc.connectionState);
      peerInfo.isConnected = pc.connectionState === 'connected';
    };

    if (myUserId < peerUserId) {
      this.renegotiatePeer(peerUserId, pc);
    }
  }

  renegotiatePeer(peerUserId, pc) {
    pc.createOffer({ offerToReceiveAudio: true })
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        console.log("[WebRTC] Отправка Offer для:", peerUserId);
        if (window.connection) {
          window.connection.invoke("SendWebRtcSignal", window.myUserId, peerUserId, JSON.stringify({
            type: 'offer',
            sdp: pc.localDescription
          }));
        }
      })
      .catch(err => console.error("[WebRTC] Ошибка при создании Offer:", err));
  }

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
        console.log("[WebRTC] Получен Offer от:", senderUserId);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log("[WebRTC] Отправка Answer для:", senderUserId);
        if (window.connection) {
          window.connection.invoke("SendWebRtcSignal", window.myUserId, senderUserId, JSON.stringify({
            type: 'answer',
            sdp: pc.localDescription
          }));
        }
      } else if (data.type === 'answer') {
        console.log("[WebRTC] Получен Answer от:", senderUserId);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        }
      } else if (data.type === 'candidate' && data.candidate) {
        if (!pc.remoteDescription) {
          peer.candidateQueue.push(data.candidate);
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }
    } catch (err) {
      console.error("[WebRTC] Ошибка в handleSignal:", err);
    }
  }

  // Управление звуком с гарантированным глушением на iOS/Android и изоляцией фаз
  applyPhaseVoiceRules(state) {
    const mySlot = state.slots.find(s => s.slotNumber === state.mySlotNumber);
    const isMeAlive = mySlot ? mySlot.isAlive : true;
    const isMeMafia = mySlot && (mySlot.roleCode === 'mafia' || mySlot.roleCode === 'don');
    const myTrack = this.localStream ? this.localStream.getAudioTracks()[0] : null;

    // 1. МЕРТВЫЙ ИГРОК: микрофон выключен всегда!
    if (!isMeAlive) {
      if (myTrack) myTrack.enabled = false;
      this.peers.forEach(peer => {
        peer.audioEl.muted = false; // Мертвый слышит живых
        if (peer.remoteTrack) peer.remoteTrack.enabled = true;
      });
      return;
    }

    // 2. ФАЗА 1 (Нулевая ночь) и ФАЗА 4 (Обычная ночь)
    if (state.phase === 1 || state.phase === 4) {
      if (isMeMafia) {
        // Живая мафия говорит между собой
        if (myTrack) myTrack.enabled = true;

        this.peers.forEach((peer, peerUserId) => {
          const peerSlot = state.slots.find(s => s.userId === peerUserId);
          const isPeerMafia = peerSlot && peerSlot.isAlive && (peerSlot.roleCode === 'mafia' || peerSlot.roleCode === 'don');

          // Заглушаем всех, кто не мафия!
          peer.audioEl.muted = !isPeerMafia;
          if (peer.remoteTrack) peer.remoteTrack.enabled = isPeerMafia;
          if (isPeerMafia) peer.audioEl.play().catch(() => {});
        });
      } else {
        // Мирные жители и шериф спят: их микрофон заблокирован, мафию они НЕ слышат
        if (myTrack) myTrack.enabled = false;
        this.peers.forEach(peer => {
          peer.audioEl.muted = true;
          if (peer.remoteTrack) peer.remoteTrack.enabled = false;
        });
      }
    } else if (state.phase === 2) {
      // 3. ФАЗА 2: Дневное обсуждение
      const isCurrentSpeaker = state.currentSpeakerSlot === state.mySlotNumber;
      if (myTrack) {
        myTrack.enabled = isCurrentSpeaker; // Говорит только активный спикер
      }

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : true;

        // Мертвых игроков за столом днем не слышно!
        peer.audioEl.muted = !isPeerAlive;
        if (peer.remoteTrack) peer.remoteTrack.enabled = isPeerAlive;
        if (isPeerAlive) peer.audioEl.play().catch(() => {});
      });
    } else {
      // 4. Лобби (0), Голосование (3), Конец игры (5) — свободный микрофон для всех живых
      if (myTrack) myTrack.enabled = true;

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : true;

        peer.audioEl.muted = !isPeerAlive;
        if (peer.remoteTrack) peer.remoteTrack.enabled = isPeerAlive;
        if (isPeerAlive) peer.audioEl.play().catch(() => {});
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
