// Основная клиентская логика
let connection = null;
let currentGameState = null;
let myUserId = localStorage.getItem('mafia_user_id');
let myNickname = localStorage.getItem('mafia_nickname') || 'Игрок ' + Math.floor(Math.random() * 900 + 100);

if (!myUserId) {
  myUserId = 'usr_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  localStorage.setItem('mafia_user_id', myUserId);
}

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

  if (elNicknameDisplay) elNicknameDisplay.textContent = myNickname;
  if (elInputNickname) elInputNickname.value = myNickname;

  // Предварительная отрисовка 8 пустых мест, чтобы экран не был черным
  renderInitialSeats();

  setupEventListeners();
  initSignalR();
}

function renderInitialSeats() {
  if (!elSeatsGrid) return;
  elSeatsGrid.innerHTML = '';
  for (let i = 1; i <= 8; i++) {
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
  document.addEventListener('click', () => {
    if (window.mafiaAudio) window.mafiaAudio.init();
  }, { once: true });

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
          connection.invoke("GetMyState", myUserId);
        }
      }
    });
  }

  const btnToggleMute = document.getElementById('btnToggleMute');
  if (btnToggleMute) {
    btnToggleMute.addEventListener('click', (e) => {
      if (window.mafiaAudio) {
        const isMuted = window.mafiaAudio.toggleMute();
        e.target.textContent = isMuted ? '🔇 Звук выкл' : '🔊 Звук вкл';
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
  currentGameState = state;

  if (prevPhase !== state.phase) {
    if (state.phase === 1 || state.phase === 4) {
      if (window.mafiaAudio) window.mafiaAudio.startNightAmbient();
    } else {
      if (window.mafiaAudio) {
        window.mafiaAudio.stopNightAmbient();
        window.mafiaAudio.playGavel();
      }
    }
  }

  if (elPhaseTitle) elPhaseTitle.textContent = state.phaseTitle;
  if (elPhaseDescription) elPhaseDescription.textContent = state.phaseDescription;
  if (elTimerValue) elTimerValue.textContent = state.secondsLeft;

  renderSeats(state);
  renderHUD(state);
  renderLog(state.recentEvents);
}

function renderSeats(state) {
  if (!elSeatsGrid) return;
  elSeatsGrid.innerHTML = '';

  state.slots.forEach(slot => {
    const card = document.createElement('div');
    card.className = 'seat-card';

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
        const btnNominate = document.createElement('button');
        btnNominate.className = 'btn btn-danger';
        btnNominate.textContent = 'Выставить на голосование';
        btnNominate.onclick = () => nominatePlayer(slot.slotNumber);
        actions.appendChild(btnNominate);
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
          const btnShoot = document.createElement('button');
          btnShoot.className = 'btn btn-danger';
          btnShoot.textContent = '🎯 Выстрелить';
          btnShoot.onclick = () => nightAction(slot.slotNumber);
          actions.appendChild(btnShoot);
        }

        if (state.canCheckNow) {
          const btnCheck = document.createElement('button');
          btnCheck.className = 'btn btn-primary';
          btnCheck.textContent = '🔍 Проверить';
          btnCheck.onclick = () => nightAction(slot.slotNumber);
          actions.appendChild(btnCheck);
        }
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

  if (state.phase === 2 && state.canSpeakNow) {
    const btnPass = document.createElement('button');
    btnPass.className = 'btn btn-gold';
    btnPass.textContent = '⏩ Завершить речь досрочно';
    btnPass.onclick = () => passSpeech();
    elHudActions.appendChild(btnPass);
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

function resetGame() {
  if (connection && connection.state === signalR.HubConnectionState.Connected) {
    connection.invoke("ResetGame");
  }
}

// Запуск инициализации вне зависимости от состояния загрузки DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
