// Профессиональный WebRTC модуль голосовой связи:
// - Автоматический запуск микрофона при входе на сайт
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

    // Пользовательские переключатели (персистентные, не сбрасываются игрой!)
    this.userMutedMic = false;   // Пользователь сам нажал "Заглушить микрофон"
    this.userMutedSound = false; // Пользователь сам нажал "Заглушить весь звук"

    // userId -> { pc, transceiver, sender, audioEl, candidateQueue, remoteTrack, remoteStream, isConnected }
    this.peers = new Map();

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
    this.setupGlobalUnlockListeners();
  }

  // Регистрация постоянных слушателей пользовательских жестов для снятия блокировки звука в iOS/Android
  setupGlobalUnlockListeners() {
    const unlockHandler = () => {
      this.unlockAllAudio();
      if (!this.isMicEnabled) {
        this.enableMicrophone();
      }
    };

    ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockHandler, { passive: true });
    });
  }

  // Запрос доступа к микрофону
  async enableMicrophone() {
    if (this.isMicEnabled && this.localStream) {
      return true;
    }

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
      this.userMutedMic = false;
      this.setupAudioAnalysis();
      this.unlockAllAudio();
      console.log("[WebRTC] Микрофон успешно получен");

      const myTrack = this.localStream.getAudioTracks()[0];

      // Подключаем полученный трек ко всем активным пирам
      this.peers.forEach((peer) => {
        try {
          const sender = peer.sender || (peer.pc.getSenders() && peer.pc.getSenders()[0]);
          if (sender && myTrack) {
            sender.replaceTrack(myTrack).catch(err => console.warn("[WebRTC] replaceTrack error in enableMicrophone:", err));
          }
        } catch (e) {}
      });

      if (window.currentGameState) {
        this.applyPhaseVoiceRules(window.currentGameState);
      }

      this.updateNavbarButtons();
      return true;
    } catch (err) {
      console.warn("[WebRTC] Ожидание разрешения пользователя на использование микрофона:", err);
      this.updateNavbarButtons();
      return false;
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
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      setInterval(() => {
        const mySlot = window.currentGameState?.slots?.find(s => s.slotNumber === window.currentGameState.mySlotNumber);
        const isMeAlive = mySlot ? mySlot.isAlive : (window.currentGameState?.phase === 0 || window.currentGameState?.phase === 5);

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
        const isSpeaking = avg > 14;

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
    audioEl.setAttribute('playsinline', 'true');
    audioEl.setAttribute('webkit-playsinline', 'true');
    audioEl.setAttribute('data-peer-user-id', peerUserId);
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    // Добавляем аудио-трансивер sendrecv сразу
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const sender = transceiver.sender;

    const peerInfo = {
      pc: pc,
      transceiver: transceiver,
      sender: sender,
      audioEl: audioEl,
      candidateQueue: [],
      remoteTrack: null,
      remoteStream: null,
      isConnected: false
    };

    this.peers.set(peerUserId, peerInfo);

    if (this.localStream) {
      const myTrack = this.localStream.getAudioTracks()[0];
      if (myTrack && !this.userMutedMic) {
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
      if (pc.connectionState === 'failed') {
        setTimeout(() => {
          const currentPeer = this.peers.get(peerUserId);
          if (currentPeer && currentPeer.pc && currentPeer.pc.connectionState === 'failed') {
            console.log(`[WebRTC] Попытка авто-восстановления связи с ${peerUserId}...`);
            this.reconnectPeer(peerUserId);
          }
        }, 4000);
      }
    };

    if (myUserId < peerUserId) {
      this.renegotiatePeer(peerUserId, pc);
    }
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
    this.createPeerConnection(peerUserId, window.myUserId);
  }

  renegotiatePeer(peerUserId, pc) {
    if (pc.signalingState !== 'stable') {
      return;
    }

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
      .catch(err => console.error("[WebRTC] Ошибка Offer:", err));
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
        if (pc.signalingState !== 'stable') {
          console.warn(`[WebRTC] Glare с ${senderUserId}. Состояние:`, pc.signalingState);
          if (window.myUserId > senderUserId) {
            await pc.setLocalDescription({ type: "rollback" }).catch(() => {});
          } else {
            return;
          }
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

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
      console.error("[WebRTC] Ошибка в handleSignal:", err);
    }
  }

  // СТРОГОЕ УПРАВЛЕНИЕ АУДИОПОТОКАМИ (УРОВЕНЬ ТРАНСИВЕРОВ И АУДИО-ЭЛЕМЕНТОВ)
  applyPhaseVoiceRules(state) {
    const mySlot = state.slots.find(s => s.slotNumber === state.mySlotNumber);
    const isMeAlive = mySlot ? mySlot.isAlive : (state.phase === 0 || state.phase === 5);
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

    // 1. МЕРТВЫЙ ИГРОК: микрофон заблокирован во всех игровых фазах
    if (!isMeAlive && state.phase !== 0 && state.phase !== 5) {
      if (myTrack) myTrack.enabled = false;
      this.peers.forEach(peer => {
        setAudioSenderActive(peer, false);
        const peerSlot = state.slots.find(s => s.userId === peer.audioEl.getAttribute('data-peer-user-id'));
        const isPeerAlive = peerSlot ? peerSlot.isAlive : false;
        // Мертвый игрок слышит живых днем или в голосовании (но не ночью)
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
            // Отправляем звук напарнику и слышим напарника
            setAudioSenderActive(peer, true);
            setPeerPlayback(peer, true);
          } else {
            // Мирным и шерифу звук не отправляется (0 байт) и мафия их не слышит
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
    } else if (state.phase === 2) {
      // 3. ДЕНЬ (Фаза 2): Говорит назначенный спикер (если не лишен слова) ИЛИ игрок, взявший выкрик
      const isCurrentSpeaker = isMeAlive && (state.currentSpeakerSlot === state.mySlotNumber) && !state.myLosesNextSpeech;
      const isMeShouting = isMeAlive && (state.activeShoutSlotNumber === state.mySlotNumber);
      const canSpeak = (isCurrentSpeaker || isMeShouting) && !this.userMutedMic;
      if (myTrack) myTrack.enabled = canSpeak;

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : false;
        const isPeerSpeaker = peerSlot ? (peerSlot.isCurrentSpeaker && !peerSlot.losesNextSpeech) : false;
        const isPeerShouting = peerSlot ? (peerSlot.slotNumber === state.activeShoutSlotNumber) : false;

        // Отправляем звук, если мы назначенный спикер или взяли выкрик
        setAudioSenderActive(peer, isCurrentSpeaker || isMeShouting);

        // Слушаем живого спикера и того, кто совершает выкрик
        setPeerPlayback(peer, isPeerAlive && (isPeerSpeaker || isPeerShouting));
      });
    } else {
      // 4. Лобби (0), Голосование (3), Конец игры (5): свободный микрофон для всех ЖИВЫХ
      const canSpeak = isMeAlive && !this.userMutedMic;
      if (myTrack) myTrack.enabled = canSpeak;

      this.peers.forEach((peer, peerUserId) => {
        const peerSlot = state.slots.find(s => s.userId === peerUserId);
        const isPeerAlive = peerSlot ? peerSlot.isAlive : (state.phase === 0 || state.phase === 5);

        // Отправляем звук, если мы живы
        setAudioSenderActive(peer, isMeAlive);

        // Слушаем живых игроков стола
        setPeerPlayback(peer, isPeerAlive);
      });
    }

    this.updateNavbarButtons();
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
