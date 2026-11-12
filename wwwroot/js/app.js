// Основная клиентская логика
let connection = null;
let currentGameState = null;
let myUserId = localStorage.getItem('mafia_user_id');
let myNickname = localStorage.getItem('mafia_nickname') || 'Игрок ' + Math.floor(Math.random() * 900 + 100);

if (!myUserId) {
  myUserId = 'usr_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  localStorage.setItem('mafia_user_id', myUserId);
}

window.myUserId = myUserId;

// DOM элементы (инициализируются в init)
let elNicknameDisplay = null;
let elPhaseTitle = null;
let elPhaseDescription = null;
let elTimerValue = null;
let elSeatsGrid = null;
let elEventLog = null;
let elMyRoleTitle = null;
let elRoleCard = null;
let elHudActions = null;
let elModalNickname = null;
let elInputNickname = null;
let elLobbySettingsBar = null;
let elTableSizeSelect = null;

// Инициализация приложения
function init() {
  console.log("Инициализация Мафия Онлайн...");

  elNicknameDisplay = document.getElementById('nicknameDisplay');
  elPhaseTitle = document.getElementById('phaseTitle');
  elPhaseDescription = document.getElementById('phaseDescription');
  elTimerValue = document.getElementById('timerValue');
  elSeatsGrid = document.getElementById('seatsGrid');
  elEventLog = document.getElementById('eventLog');
  elMyRoleTitle = document.getElementById('myRoleTitle');
  elRoleCard = document.getElementById('roleCard');
  elHudActions = document.getElementById('hudActions');
  elModalNickname = document.getElementById('modalNickname');
  elInputNickname = document.getElementById('inputNickname');
  elLobbySettingsBar = document.getElementById('lobbySettingsBar');
  elTableSizeSelect = document.getElementById('tableSizeSelect');

  if (elTableSizeSelect) {
    elTableSizeSelect.addEventListener('change', (e) => {
      const newSize = parseInt(e.target.value, 10);
      if (newSize >= 5 && newSize <= 12) {
        setTableSize(newSize);
      }
    });
  }

  if (elNicknameDisplay) elNicknameDisplay.textContent = myNickname;
  if (elInputNickname) elInputNickname.value = myNickname;

  // Немедленный автоматический запрос микрофона при входе
  if (window.mafiaVoice) {
    window.mafiaVoice.enableMicrophone().then(granted => {
      const promptBar = document.getElementById('micPromptBar');
      if (promptBar) promptBar.style.display = granted ? 'none' : 'flex';
    });
  }

  // Предварительная отрисовка пустых мест (10 по умолчанию), чтобы экран не был черным
  renderInitialSeats();

  setupEventListeners();
  initSignalR();
}

function renderInitialSeats() {
  if (!elSeatsGrid) return;
  elSeatsGrid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const card = document.createElement('div');
    card.className = 'seat-card';
    card.innerHTML = `
      <div class="seat-header">
        <div class="slot-badge">#${i}</div>
      </div>
      <div class="seat-player">
        <div class="player-name">Свободно</div>
      </div>
      <div class="seat-actions">
        <button class="btn btn-primary" onclick="takeSlot(${i})">Занять место</button>
      </div>
    `;
    elSeatsGrid.appendChild(card);
  }
}

function initSignalR() {
  console.log("Подключение к SignalR...");
  if (elPhaseTitle) elPhaseTitle.textContent = "Синхронизация стола...";

  connection = new signalR.HubConnectionBuilder()
    .withUrl("/gameHub")
    .withAutomaticReconnect([0, 2000, 5000, 10000])
    .configureLogging(signalR.LogLevel.Information)
    .build();

  window.connection = connection;

  connection.on("OnWebRtcSignal", (senderUserId, signalStr) => {
    if (window.mafiaVoice) {
      window.mafiaVoice.handleSignal(senderUserId, signalStr);
    }
  });

  connection.on("OnVoiceActivity", (userId, isSpeaking) => {
    if (window.mafiaVoice) {
      window.mafiaVoice.highlightSpeaker(userId, isSpeaking);
    }
  });

  connection.on("OnStateUpdated", (state) => {
    updateUI(state);
  });

  connection.on("OnTimerTick", (secondsLeft) => {
    updateTimer(secondsLeft);
  });

  connection.on("RequestStateRefresh", () => {
    if (connection.state === signalR.HubConnectionState.Connected) {
      connection.invoke("GetMyState", myUserId);
    }
  });

  connection.on("OnErrorNotification", (msg) => {
    alert("⚠️ " + msg);
  });

  connection.on("OnNightActionResult", (msg) => {
    showNightBanner(msg);
  });

  connection.on("OnActionNotification", (msg) => {
    console.log("Действие:", msg);
  });

  connection.onreconnecting(() => {
    if (elPhaseTitle) elPhaseTitle.textContent = "Переподключение...";
    if (elPhaseDescription) elPhaseDescription.textContent = "Связь потеряна, восстанавливаем соединение...";
  });

  connection.onreconnected(() => {
    console.log("SignalR переподключен.");
    connection.invoke("GetMyState", myUserId);
  });

  connection.start()
    .then(() => {
      console.log("SignalR успешно подключен!");
      connection.invoke("GetMyState", myUserId);
    })
    .catch(err => {
      console.error("Ошибка подключения SignalR:", err);
      if (elPhaseTitle) elPhaseTitle.textContent = "Ошибка подключения";
      if (elPhaseDescription) elPhaseDescription.textContent = "Не удалось подключиться к серверу: " + err.toString();
    });
}

function setupEventListeners() {
  const onUserInteract = () => {
    if (window.mafiaVoice) {
      window.mafiaVoice.unlockAllAudio();
      if (!window.mafiaVoice.isMicEnabled) {
        window.mafiaVoice.enableMicrophone().then(granted => {
          const promptBar = document.getElementById('micPromptBar');
          if (promptBar && granted) promptBar.style.display = 'none';
        });
      }
    }
    if (window.mafiaAudio) {
      window.mafiaAudio.init();
    }
  };

  document.addEventListener('click', onUserInteract);
  document.addEventListener('touchstart', onUserInteract, { passive: true });

  const btnGrantMic = document.getElementById('btnGrantMic');
  if (btnGrantMic) {
    btnGrantMic.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.mafiaVoice) {
        window.mafiaVoice.enableMicrophone().then(granted => {
          const promptBar = document.getElementById('micPromptBar');
          if (promptBar && granted) promptBar.style.display = 'none';
        });
      }
    });
  }

  const btnChangeNick = document.getElementById('btnChangeNick');
  if (btnChangeNick) {
    btnChangeNick.addEventListener('click', () => {
      if (elModalNickname) elModalNickname.style.display = 'flex';
    });
  }

  const btnSaveNick = document.getElementById('btnSaveNick');
  if (btnSaveNick) {
    btnSaveNick.addEventListener('click', () => {
      const val = elInputNickname ? elInputNickname.value.trim() : '';
      if (val) {
        myNickname = val;
        localStorage.setItem('mafia_nickname', myNickname);
        if (elNicknameDisplay) elNicknameDisplay.textContent = myNickname;
        if (elModalNickname) elModalNickname.style.display = 'none';
        if (connection && connection.state === signalR.HubConnectionState.Connected) {
          connection.invoke("UpdateNickname", myUserId, myNickname);
        }
      }
    });
  }

  const btnToggleMic = document.getElementById('btnToggleMic');
  if (btnToggleMic) {
    btnToggleMic.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.mafiaVoice) {
        window.mafiaVoice.toggleMic();
      }
    });
  }

  const btnToggleMute = document.getElementById('btnToggleMute');
  if (btnToggleMute) {
    btnToggleMute.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.mafiaVoice) {
        window.mafiaVoice.toggleSound();
      }
    });
  }
}

function updateTimer(seconds) {
  if (!currentGameState) return;
  currentGameState.secondsLeft = seconds;
  if (elTimerValue) elTimerValue.textContent = seconds;

  if (seconds <= 5 && seconds > 0) {
    if (elTimerValue) elTimerValue.classList.add('pulse-warning');
    if (window.mafiaAudio) window.mafiaAudio.playTick();
  } else {
    if (elTimerValue) elTimerValue.classList.remove('pulse-warning');
  }
}

function updateUI(state) {
  const prevPhase = currentGameState ? currentGameState.phase : null;
  const prevDeadCount = currentGameState ? currentGameState.slots.filter(s => s.isOccupied && !s.isAlive).length : 0;
  currentGameState = state;
  const currentDeadCount = state.slots.filter(s => s.isOccupied && !s.isAlive).length;

  if (prevPhase !== state.phase) {
    if (state.phase === 1 || state.phase === 4) {
      if (window.mafiaAudio) window.mafiaAudio.startNightAmbient();
    } else {
      if (window.mafiaAudio) {
        window.mafiaAudio.stopNightAmbient();
        if (currentDeadCount > prevDeadCount) {
          window.mafiaAudio.playGunshot();
        } else {
          window.mafiaAudio.playGavel();
        }
      }
    }
  }

  const aliveCount = state.slots.filter(s => s.isOccupied && s.isAlive).length;
  const occupiedCount = state.slots.filter(s => s.isOccupied).length;
  const aliveInfo = occupiedCount > 0 && state.phase > 0 ? ` • Живых: ${aliveCount}/${occupiedCount}` : '';

  if (elPhaseTitle) elPhaseTitle.textContent = state.phaseTitle;
  if (elPhaseDescription) elPhaseDescription.textContent = state.phaseDescription + aliveInfo;
  if (elTimerValue) elTimerValue.textContent = state.secondsLeft;

  if (elLobbySettingsBar) {
    elLobbySettingsBar.style.display = (state.phase === 0) ? 'flex' : 'none';
  }
  if (elTableSizeSelect && state.phase === 0) {
    const curSize = state.maxSlots || state.slots.length;
    if (parseInt(elTableSizeSelect.value, 10) !== curSize) {
      elTableSizeSelect.value = curSize;
    }
  }

  renderSeats(state);
  renderHUD(state);
  renderLog(state.recentEvents);

  if (window.mafiaVoice) {
    window.mafiaVoice.syncPeers(state.slots, myUserId);
    window.mafiaVoice.applyPhaseVoiceRules(state);
  }
}

function renderSeats(state) {
  if (!elSeatsGrid) return;
  elSeatsGrid.innerHTML = '';

  state.slots.forEach(slot => {
    const card = document.createElement('div');
    card.className = 'seat-card';
    if (slot.userId) card.setAttribute('data-user-id', slot.userId);

    const isMe = state.mySlotNumber === slot.slotNumber;
    if (isMe) card.classList.add('is-me');
    if (slot.isCurrentSpeaker) card.classList.add('active-speaker');
    if (slot.isNominated) card.classList.add('nominated');
    if (!slot.isAlive && slot.isOccupied) card.classList.add('dead');

    const header = document.createElement('div');
    header.className = 'seat-header';

    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.textContent = '#' + slot.slotNumber;
    header.appendChild(badge);

    if (slot.isCurrentSpeaker) {
      const spBadge = document.createElement('div');
      spBadge.className = 'speaker-badge';
      spBadge.textContent = 'Говорит';
      header.appendChild(spBadge);
    } else if (slot.isNominated) {
      const nomBadge = document.createElement('div');
      nomBadge.className = 'speaker-badge';
      nomBadge.style.background = '#ef4444';
      nomBadge.style.color = '#fff';
      nomBadge.textContent = 'Выставлен';
      header.appendChild(nomBadge);
    } else if (!slot.isAlive && slot.isOccupied) {
      const deadBadge = document.createElement('div');
      deadBadge.className = 'speaker-badge speaker-dead';
      deadBadge.textContent = '💀 Выбыл';
      header.appendChild(deadBadge);
    }

    card.appendChild(header);

    const playerArea = document.createElement('div');
    playerArea.className = 'seat-player';

    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = slot.isOccupied ? slot.nickname : 'Свободно';
    if (isMe) name.textContent += ' (Вы)';
    playerArea.appendChild(name);

    if (slot.roleTitle) {
      const roleBadge = document.createElement('div');
      roleBadge.className = `player-role-badge role-${slot.roleCode}`;
      roleBadge.textContent = slot.roleTitle;
      playerArea.appendChild(roleBadge);
    }

    // Фолы, выкрики и замечания
    if (slot.isOccupied && (slot.fouls > 0 || slot.shoutsCount > 0 || slot.losesNextSpeech)) {
      const foulsBadge = document.createElement('div');
      foulsBadge.className = 'fouls-badge' + (slot.fouls >= 3 ? ' fouls-danger' : '');
      let text = `⚠️ Фолы: ${slot.fouls}/4`;
      if (slot.shoutsCount > 0) {
        text += ` • Выкрики: ${slot.shoutsCount}/2`;
      }
      if (slot.losesNextSpeech) {
        text += ` • 🔇 ЛИШЕН СЛОВА`;
      }
      foulsBadge.textContent = text;
      playerArea.appendChild(foulsBadge);
    }

    // Активный выкрик прямо сейчас
    if (state.activeShoutSlotNumber === slot.slotNumber) {
      card.classList.add('shouter-active');
      const shoutBadge = document.createElement('div');
      shoutBadge.className = 'shout-active-badge';
      shoutBadge.textContent = `📢 ВЫКРИК (${state.activeShoutSecondsLeft}с)`;
      playerArea.appendChild(shoutBadge);
    }

    // Проверка шерифа или дона
    if (state.knownChecks && state.knownChecks[slot.slotNumber]) {
      const checkRes = state.knownChecks[slot.slotNumber];
      const checkBadge = document.createElement('div');
      const isBlackOrSheriff = checkRes.includes('ЧЕРНЫЙ') || checkRes.includes('ШЕРИФ');
      checkBadge.className = 'check-result-badge ' + (isBlackOrSheriff ? 'check-black' : 'check-red');
      checkBadge.textContent = '🔍 ' + checkRes;
      playerArea.appendChild(checkBadge);
    }

    // Выстрел мафии (виден мафии)
    if (state.myNightTargetSlot === slot.slotNumber) {
      card.classList.add('targeted-kill');
      const killBadge = document.createElement('div');
      killBadge.className = 'target-kill-badge';
      killBadge.textContent = '🎯 ВЫСТРЕЛ МАФИИ';
      playerArea.appendChild(killBadge);
    }

    card.appendChild(playerArea);

    const actions = document.createElement('div');
    actions.className = 'seat-actions';

    if (state.phase === 0) { // Лобби
      if (!slot.isOccupied && !state.mySlotNumber) {
        const btnTake = document.createElement('button');
        btnTake.className = 'btn btn-primary';
        btnTake.textContent = 'Занять место';
        btnTake.onclick = () => takeSlot(slot.slotNumber);
        actions.appendChild(btnTake);
      } else if (isMe) {
        const btnLeave = document.createElement('button');
        btnLeave.className = 'btn btn-danger';
        btnLeave.textContent = 'Встать';
        btnLeave.onclick = () => leaveSlot();
        actions.appendChild(btnLeave);

        const btnReady = document.createElement('button');
        btnReady.className = slot.isReady ? 'btn btn-success' : 'btn';
        btnReady.textContent = slot.isReady ? '✓ Готов' : 'Нажать Готов';
        btnReady.onclick = () => toggleReady();
        actions.appendChild(btnReady);
      }
    } else {
      if (state.phase === 2 && state.canSpeakNow && !isMe && slot.isAlive && !slot.isNominated) {
        if (!state.hasNominatedThisTurn) {
          const btnNominate = document.createElement('button');
          btnNominate.className = 'btn btn-danger';
          btnNominate.textContent = 'Выставить на голосование';
          btnNominate.onclick = () => nominatePlayer(slot.slotNumber);
          actions.appendChild(btnNominate);
        } else {
          const infoNom = document.createElement('div');
          infoNom.style.fontSize = '0.75rem';
          infoNom.style.color = 'var(--text-muted)';
          infoNom.textContent = '✓ Выставили кандидата';
          actions.appendChild(infoNom);
        }
      }

      if (state.phase === 3 && state.canVoteNow && slot.isNominated) {
        const btnVote = document.createElement('button');
        btnVote.className = 'btn btn-gold';
        btnVote.textContent = (state.slots.find(s => s.slotNumber === state.mySlotNumber)?.votedForSlot === slot.slotNumber)
          ? '✓ Ваш голос здесь'
          : 'Голосовать';
        btnVote.onclick = () => vote(slot.slotNumber);
        actions.appendChild(btnVote);
      }

      if (state.phase === 4 && slot.isAlive && !isMe) {
        if (state.canShootNow) {
          const isTarget = state.myNightTargetSlot === slot.slotNumber;
          const btnShoot = document.createElement('button');
          btnShoot.className = isTarget ? 'btn btn-danger' : 'btn btn-danger';
          btnShoot.style.opacity = isTarget ? '1' : '0.85';
          btnShoot.textContent = isTarget ? '🎯 Жертва зафиксирована' : '🎯 Выстрелить';
          btnShoot.onclick = () => nightAction(slot.slotNumber);
          actions.appendChild(btnShoot);
        }

        if (state.canCheckNow) {
          const alreadyChecked = state.knownChecks && state.knownChecks[slot.slotNumber];
          const hasCheckedThisNight = state.hasCheckedThisNight;
          const isDon = state.myRoleCode === 'don';
          const btnCheck = document.createElement('button');
          btnCheck.className = isDon ? 'btn btn-gold' : 'btn btn-primary';
          btnCheck.disabled = !!alreadyChecked || hasCheckedThisNight;
          if (alreadyChecked) {
            btnCheck.textContent = '✓ Уже проверен';
          } else if (hasCheckedThisNight) {
            btnCheck.textContent = '✓ Проверка исчерпана';
          } else {
            btnCheck.textContent = isDon ? '🕵️ Найти Шерифа' : '🔍 Проверить';
          }
          btnCheck.onclick = () => isDon ? donCheck(slot.slotNumber) : nightAction(slot.slotNumber);
          actions.appendChild(btnCheck);
        }
      }

      // Назначение фола во время дня или голосования
      if ((state.phase === 2 || state.phase === 3) && slot.isAlive && slot.isOccupied && !isMe) {
        const btnFoul = document.createElement('button');
        btnFoul.className = 'btn btn-foul';
        btnFoul.textContent = '+ Фол';
        btnFoul.title = 'Вынести предупреждение/фол';
        btnFoul.onclick = () => addFoul(slot.slotNumber);
        actions.appendChild(btnFoul);
      }
    }

    card.appendChild(actions);
    elSeatsGrid.appendChild(card);
  });
}

function renderHUD(state) {
  if (!elRoleCard || !elHudActions) return;

  if (state.myRoleTitle) {
    elRoleCard.style.display = 'flex';
    if (elMyRoleTitle) {
      elMyRoleTitle.textContent = state.myRoleTitle;
      elMyRoleTitle.className = `player-role-badge role-${state.myRoleCode}`;
    }
  } else {
    elRoleCard.style.display = 'none';
  }

  elHudActions.innerHTML = '';

  if (state.phase === 0) {
    const btnStart = document.createElement('button');
    btnStart.className = 'btn btn-gold';
    btnStart.style.maxWidth = '200px';
    btnStart.textContent = '▶ Запустить игру';
    btnStart.onclick = () => startGame();
    elHudActions.appendChild(btnStart);
  }

  if (state.phase === 2) {
    const isSpeaker = state.mySlotNumber && (state.currentSpeakerSlot === state.mySlotNumber);
    const mySlot = state.slots.find(s => s.slotNumber === state.mySlotNumber);
    const isMeAlive = mySlot ? mySlot.isAlive : false;

    if (isSpeaker) {
      if (state.myLosesNextSpeech) {
        const badgeSilenced = document.createElement('div');
        badgeSilenced.className = 'btn btn-secondary';
        badgeSilenced.style.cursor = 'default';
        badgeSilenced.textContent = '🔇 Вы лишены слова за 3-й выкрик/фол!';
        elHudActions.appendChild(badgeSilenced);
      } else {
        const btnPass = document.createElement('button');
        btnPass.className = 'btn btn-gold';
        btnPass.textContent = '⏩ Завершить речь досрочно';
        btnPass.onclick = () => passSpeech();
        elHudActions.appendChild(btnPass);
      }
    } else if (isMeAlive) {
      // Механика выкрика за фол
      if (state.activeShoutSlotNumber === state.mySlotNumber) {
        const btnShouting = document.createElement('button');
        btnShouting.className = 'btn btn-danger btn-shout-active';
        btnShouting.textContent = `🎙️ ВЫКРИК АКТИВЕН (${state.activeShoutSecondsLeft}с): говорите!`;
        btnShouting.disabled = true;
        elHudActions.appendChild(btnShouting);
      } else if (state.activeShoutSlotNumber) {
        const btnOtherShout = document.createElement('button');
        btnOtherShout.className = 'btn btn-secondary';
        btnOtherShout.textContent = `📢 Игрок #${state.activeShoutSlotNumber} кричит (${state.activeShoutSecondsLeft}с)...`;
        btnOtherShout.disabled = true;
        elHudActions.appendChild(btnOtherShout);
      } else if (state.myShoutsCount < 2) {
        const btnShout = document.createElement('button');
        btnShout.className = 'btn btn-shout';
        btnShout.textContent = `📢 Взять выкрик (${state.myShoutsCount + 1}/2, +1 фол)`;
        btnShout.title = 'Получить +1 фол и открыть микрофон столу на 6 секунд';
        btnShout.onclick = () => shout();
        elHudActions.appendChild(btnShout);
      } else if (state.myShoutsCount === 2) {
        const btnShout3 = document.createElement('button');
        btnShout3.className = 'btn btn-danger';
        btnShout3.textContent = `⚠️ 3-й выкрик (+1 фол, ЛИШЕНИЕ СЛОВА!)`;
        btnShout3.title = '3-й выкрик лишает вас слова на следующий ход речи!';
        btnShout3.onclick = () => shoutConfirm();
        elHudActions.appendChild(btnShout3);
      } else {
        const btnDone = document.createElement('button');
        btnDone.className = 'btn btn-secondary';
        btnDone.textContent = `⛔ Выкрики исчерпаны (3/3)`;
        btnDone.disabled = true;
        elHudActions.appendChild(btnDone);
      }
    }
  }

  if (state.phase === 5) {
    const btnRestart = document.createElement('button');
    btnRestart.className = 'btn btn-primary';
    btnRestart.textContent = '🔄 Вернуться в лобби';
    btnRestart.onclick = () => resetGame();
    elHudActions.appendChild(btnRestart);
  }
}

function renderLog(events) {
  if (!elEventLog || !events) return;
  elEventLog.innerHTML = '';
  events.forEach(evt => {
    const item = document.createElement('div');
    item.className = `log-item ${evt.type}`;

    const date = new Date(evt.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    item.innerHTML = `<span class="log-time">${timeStr}</span>${evt.text}`;
    elEventLog.appendChild(item);
  });
  elEventLog.scrollTop = elEventLog.scrollHeight;
}

function takeSlot(slotNum) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("TakeSlot", myUserId, myNickname, slotNum);
  } else {
    alert("Нет подключения к серверу. Подождите пару секунд.");
  }
}

function leaveSlot() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("LeaveSlot", myUserId);
  }
}

function toggleReady() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("ToggleReady", myUserId);
  }
}

function startGame() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("StartGame");
  }
}

function nominatePlayer(targetSlot) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("NominatePlayer", myUserId, targetSlot);
  }
}

function passSpeech() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("PassSpeech", myUserId);
  }
}

function vote(targetSlot) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("Vote", myUserId, targetSlot);
  }
}

function nightAction(targetSlot) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("NightAction", myUserId, targetSlot);
  }
}

function donCheck(targetSlot) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("DonCheck", myUserId, targetSlot);
  }
}

function addFoul(targetSlot) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    if (confirm(`Выписать замечание (фол) Игроку #${targetSlot}?`)) {
      connection.invoke("AddFoul", targetSlot);
    }
  }
}

function shout() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("Shout", myUserId);
  }
}

function shoutConfirm() {
  if (confirm("Внимание! Это ваш 3-й выкрик. Вы получите 3-й фол и будете ЛИШЕНЫ СЛОВА на следующий ход речи! Продолжить?")) {
    shout();
  }
}

function setTableSize(size) {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("SetTableSize", size);
  }
}

function resetGame() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("ResetGame");
  }
}

function showNightBanner(msg) {
  let banner = document.getElementById('nightActionBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'nightActionBanner';
    const container = document.querySelector('.table-area');
    const seats = document.getElementById('seatsGrid');
    if (container && seats) {
      container.insertBefore(banner, seats);
    }
  }

  banner.className = 'night-action-banner';
  if (msg.includes('ЧЕРНЫЙ')) {
    banner.classList.add('banner-black');
  } else if (msg.includes('КРАСНЫЙ')) {
    banner.classList.add('banner-red');
  } else if (msg.includes('Жертва') || msg.includes('Выстрел') || msg.includes('отстрел') || msg.includes('Стрельба') || msg.includes('разногласие')) {
    banner.classList.add('banner-kill');
  }

  banner.innerHTML = `
    <div style="font-size: 1.05rem; font-weight: 700; line-height: 1.4;">${msg}</div>
    <button class="btn" style="width: auto; padding: 4px 12px; font-size: 0.85rem;" onclick="this.parentElement.remove()">✕ Закрыть</button>
  `;

  setTimeout(() => {
    if (banner && banner.parentElement) {
      banner.remove();
    }
  }, 10000);
}

// Запуск инициализации вне зависимости от состояния загрузки DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
