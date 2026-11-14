using System.Collections.Concurrent;
using MafiaWeb.Models;

namespace MafiaWeb.Services;

public class GameRoomService
{
    private readonly object _lock = new();
    private readonly List<PlayerSlot> _slots = new(8);
    private readonly List<GameEvent> _events = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _userConnections = new();
    private readonly List<int> _nominatedSlots = new();
    private readonly Dictionary<int, string> _sheriffChecks = new(); // slot -> "Красный"/"Черный"
    private readonly Dictionary<int, string> _donChecks = new();     // slot -> "Шериф"/"Не шериф"

    public string? HostUserId { get; private set; }
    private int _votingRound;
    private readonly List<int> _tieCandidates = new();
    private readonly HashSet<int> _tieSpoken = new();
    private readonly Dictionary<int, bool> _groupVotes = new();
    private bool IsLive(int n) => _slots.Any(s => s.SlotNumber == n && s.IsAlive && !string.IsNullOrEmpty(s.UserId));
    public GamePhase Phase { get; private set; } = GamePhase.Lobby;
    public int DayNumber { get; private set; } = 0;
    public int SecondsLeft { get; private set; } = 0;
    public int? CurrentSpeakerSlot { get; private set; }
    public GameWinner Winner { get; private set; } = GameWinner.None;

    // Ограничения правил: 1 выставление за речь и 1 проверка за ночь
    private bool _speakerNominatedThisTurn = false;
    private int? _sheriffCheckedSlotThisNight = null;
    private int? _donCheckedSlotThisNight = null;

    // Слоты, уже отговорившие в текущем дне (круг речи завершен, когда отговорили все живые).
    // Множество надежнее позиции стартового спикера: игроки могут выбывать посреди дня.
    private readonly HashSet<int> _spokenSlotsThisDay = new();

    // Механика выкриков за фол (максимум 2 выкрика, 3-й выкрик лишает следующей речи)
    private int? _activeShoutSlotNumber = null;
    private int _activeShoutSecondsLeft = 0;

    public int MaxSlots { get; private set; } = 10;
    public RoomMode Mode { get; private set; } = RoomMode.Standard;
    public string RoomConfigCode { get; private set; } = "10";

    public GameRoomService()
    {
        for (int i = 1; i <= MaxSlots; i++)
        {
            _slots.Add(new PlayerSlot { SlotNumber = i });
        }
        AddEvent($"Комната создана. Выберите режим или количество мест (2-12) и займите свои места за столом (1-{MaxSlots}).", "info");
    }

    public (bool Success, string Message) ConfigureTable(string configCode)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Lobby)
                return (false, "Конфигурацию стола можно менять только в лобби до старта игры.");

            RoomMode newMode;
            int targetSlots;

            switch (configCode)
            {
                case "2_peaceful":
                    newMode = RoomMode.TestTwoPeacefuls;
                    targetSlots = 2;
                    break;
                case "2_mafia":
                    newMode = RoomMode.TestTwoMafia;
                    targetSlots = 2;
                    break;
                default:
                    if (!int.TryParse(configCode, out targetSlots) || targetSlots < 4 || targetSlots > 12)
                    {
                        return (false, "Размер стола должен быть от 4 до 12 игроков.");
                    }
                    newMode = RoomMode.Standard;
                    break;
            }

            var occupiedBeyond = _slots.Where(s => s.SlotNumber > targetSlots && !string.IsNullOrEmpty(s.UserId)).ToList();
            if (occupiedBeyond.Count > 0)
            {
                var names = string.Join(", ", occupiedBeyond.Select(s => $"#{s.SlotNumber} ({s.Nickname})"));
                return (false, $"Нельзя уменьшить стол до {targetSlots} мест: слоты заняты игроками: {names}. Сначала освободите эти места.");
            }

            Mode = newMode;
            RoomConfigCode = configCode;
            MaxSlots = targetSlots;

            while (_slots.Count < targetSlots)
            {
                _slots.Add(new PlayerSlot { SlotNumber = _slots.Count + 1 });
            }

            while (_slots.Count > targetSlots)
            {
                _slots.RemoveAt(_slots.Count - 1);
            }

            string modeDesc = newMode switch
            {
                RoomMode.TestTwoPeacefuls => "ТЕСТ: 2 Мирных жителя (проверка дневного микрофона)",
                RoomMode.TestTwoMafia => "ТЕСТ: 2 Мафии (проверка ночной договорки)",
                _ => $"{targetSlots} мест"
            };

            AddEvent($"Конфигурация стола изменена: {modeDesc}.", "info");
            return (true, $"Установлена конфигурация: {modeDesc}.");
        }
    }

    public (bool Success, string Message) SetTableSize(int newSize)
    {
        return ConfigureTable(newSize.ToString());
    }

    public IReadOnlyList<PlayerSlot> GetSlots()
    {
        lock (_lock)
        {
            return _slots.ToList();
        }
    }

    public void UpdateConnectionId(string userId, string connectionId)
    {
        _userConnections[userId] = connectionId;
        lock (_lock)
        {
            var slot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (slot != null)
            {
                slot.ConnectionId = connectionId;
            }
        }
    }

    public string? GetConnectionIdByUserId(string userId)
    {
        if (_userConnections.TryGetValue(userId, out var connId) && !string.IsNullOrEmpty(connId))
        {
            return connId;
        }

        lock (_lock)
        {
            return _slots.FirstOrDefault(s => s.UserId == userId)?.ConnectionId;
        }
    }

    public void UpdateNickname(string userId, string nickname)
    {
        lock (_lock)
        {
            var slot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (slot != null && !string.IsNullOrWhiteSpace(nickname))
            {
                var oldNick = slot.Nickname;
                slot.Nickname = nickname.Trim();
                if (oldNick != slot.Nickname)
                {
                    AddEvent($"Игрок #{slot.SlotNumber} изменил имя на «{slot.Nickname}».", "info");
                }
            }
        }
    }

    public bool CanUserSpeakNow(string userId)
    {
        lock (_lock)
        {
            var slot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (slot == null || !slot.IsAlive) return false;

            // Активный выкрик дает временное право речи во время выкрика
            if (_activeShoutSlotNumber == slot.SlotNumber && _activeShoutSecondsLeft > 0)
                return true;

            if (Phase is GamePhase.Lobby or GamePhase.Voting or GamePhase.GroupVoting or GamePhase.GameOver)
                return true;

            if (Phase is GamePhase.DayDiscussion or GamePhase.TieDiscussion)
            {
                if (slot.SlotNumber == CurrentSpeakerSlot)
                {
                    // Если игрок лишен слова за 3-й выкрик/фол
                    if (slot.LosesNextSpeech) return false;
                    return true;
                }
                return false;
            }

            if (Phase is GamePhase.NightZero or GamePhase.Night)
                return slot.Role is PlayerRole.Mafia or PlayerRole.Don;

            return false;
        }
    }

    public (bool Success, string Message) TakeSlot(int slotNumber, string userId, string nickname, string connectionId)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Lobby)
                return (false, "Игра уже началась. Занять место нельзя.");

            if (slotNumber < 1 || slotNumber > _slots.Count)
                return (false, "Неверный номер слота.");

            var slot = _slots[slotNumber - 1];

            // Если игрок уже сидит на этом месте (например, переподключился)
            if (slot.UserId == userId)
            {
                slot.ConnectionId = connectionId;
                slot.Nickname = nickname;
                return (true, "Место подтверждено.");
            }

            if (!string.IsNullOrEmpty(slot.UserId))
                return (false, "Этот слот уже занят другим игроком.");

            // Освобождаем старый слот, если игрок уже сидел где-то
            var oldSlot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (oldSlot != null)
            {
                oldSlot.UserId = null;
                oldSlot.Nickname = string.Empty;
                oldSlot.ConnectionId = null;
                oldSlot.IsReady = false;
            }

            HostUserId ??= userId;
            slot.UserId = userId;
            slot.Nickname = nickname;
            slot.ConnectionId = connectionId;
            slot.IsReady = false;

            AddEvent($"{nickname} сел за стол на место #{slotNumber}.", "info");
            return (true, "Место занято.");
        }
    }

    public (bool Success, string Message) LeaveSlot(string userId)
    {
        lock (_lock)
        {
            var slot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (slot == null) return (false, "Вы не за столом.");

            if (Phase != GamePhase.Lobby)
            {
                // Во время игры просто помечаем отключение соединения
                slot.ConnectionId = null;
                return (true, "Связь потеряна.");
            }

            var nick = slot.Nickname;
            var num = slot.SlotNumber;
            slot.UserId = null;
            slot.Nickname = string.Empty;
            slot.ConnectionId = null;
            slot.IsReady = false;

            if (HostUserId == userId) HostUserId = _slots.FirstOrDefault(s => !string.IsNullOrEmpty(s.UserId))?.UserId;
            AddEvent($"{nick} освободил место #{num}.", "info");
            return (true, "Вы встали из-за стола.");
        }
    }

    public bool ToggleReady(string userId)
    {
        lock (_lock)
        {
            var slot = _slots.FirstOrDefault(s => s.UserId == userId);
            if (slot == null || Phase != GamePhase.Lobby) return false;

            slot.IsReady = !slot.IsReady;
            AddEvent($"{slot.Nickname} {(slot.IsReady ? "готов к игре" : "снял готовность")}.", "info");
            return true;
        }
    }

    public (bool Success, string Message) StartGame()
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Lobby)
                return (false, "Игра уже идет.");

            var occupied = _slots.Where(s => !string.IsNullOrEmpty(s.UserId)).ToList();
            int requiredPlayers = (Mode is RoomMode.TestTwoPeacefuls or RoomMode.TestTwoMafia) ? 2 : 4;
            if (occupied.Count < requiredPlayers)
                return (false, $"Для запуска нужно хотя бы {requiredPlayers} игрока (сейчас занято {occupied.Count}).");

            if (occupied.Any(s => !s.IsReady)) return (false, "Все занявшие места игроки должны нажать «Готов».");
            DistributeRoles(occupied);

            _votingRound = 0;
            _tieCandidates.Clear();
            _tieSpoken.Clear();
            _groupVotes.Clear();
            _nominatedSlots.Clear();
            _sheriffChecks.Clear();
            _donChecks.Clear();
            _speakerNominatedThisTurn = false;
            _spokenSlotsThisDay.Clear();
            _sheriffCheckedSlotThisNight = null;
            _donCheckedSlotThisNight = null;
            _activeShoutSlotNumber = null;
            _activeShoutSecondsLeft = 0;
            Winner = GameWinner.None;

            if (Mode == RoomMode.TestTwoPeacefuls)
            {
                Phase = GamePhase.DayDiscussion;
                DayNumber = 1;
                CurrentSpeakerSlot = occupied[0].SlotNumber;
                SecondsLeft = 60;
                AddEvent($"Тестовая игра (2 Мирных) запущена! Проверка дневного звука. Говорит Игрок #{CurrentSpeakerSlot.Value} ({occupied[0].Nickname}).", "day");
            }
            else if (Mode == RoomMode.TestTwoMafia)
            {
                Phase = GamePhase.NightZero;
                DayNumber = 0;
                CurrentSpeakerSlot = null;
                SecondsLeft = 60;
                AddEvent("Тестовая игра (2 Мафии) запущена! Наступает Нулевая ночь — мафия говорит друг с другом в закрытом канале.", "night");
            }
            else
            {
                Phase = GamePhase.NightZero;
                DayNumber = 0;
                CurrentSpeakerSlot = null;
                SecondsLeft = 60;
                AddEvent("Игра началась! Наступает Нулевая ночь — договорка мафии.", "night");
            }

            return (true, "Игра запущена.");
        }
    }

    private void DistributeRoles(List<PlayerSlot> players)
    {
        var rng = new Random();
        var shuffled = players.OrderBy(_ => rng.Next()).ToList();

        // Сброс
        foreach (var s in _slots)
        {
            s.Role = PlayerRole.Peaceful;
            s.IsAlive = !string.IsNullOrEmpty(s.UserId);
            s.NightTargetSlot = null;
            s.VotedForSlot = null;
            s.Fouls = 0;
            s.ShoutsCount = 0;
            s.LosesNextSpeech = false;
        }

        if (Mode == RoomMode.TestTwoPeacefuls)
        {
            foreach (var s in players)
            {
                s.Role = PlayerRole.Peaceful;
            }
            return;
        }

        if (Mode == RoomMode.TestTwoMafia)
        {
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            return;
        }

        int count = players.Count;
        if (count >= 12)
        {
            // 12 игроков: 1 Дон, 3 Мафии, 1 Шериф, 7 Мирных (4 черных vs 8 красных)
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            shuffled[2].Role = PlayerRole.Mafia;
            shuffled[3].Role = PlayerRole.Mafia;
            shuffled[4].Role = PlayerRole.Sheriff;
        }
        else if (count >= 9)
        {
            // 9-11 игроков (включая классику на 10 чел): 1 Дон, 2 Мафии, 1 Шериф, остальные Мирные (3 черных)
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            shuffled[2].Role = PlayerRole.Mafia;
            shuffled[3].Role = PlayerRole.Sheriff;
        }
        else if (count >= 7)
        {
            // 7-8 игроков: 1 Дон, 1 Мафия, 1 Шериф, остальные Мирные (2 черных)
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            shuffled[2].Role = PlayerRole.Sheriff;
        }
        else if (count >= 5)
        {
            // 5-6 игроков: 1 Дон (он же стреляющая мафия), 1 Шериф, остальные Мирные (1 черный)
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Sheriff;
        }
        else
        {
            // 4 игрока (Тестовый сценарий связи: 2 Мафии vs 2 Красных):
            // 1 Дон, 1 Мафия, 1 Шериф, 1 Мирный житель.
            // Позволяет проверить:
            // 1) Дневной звук каждого игрока в свою минуту речи.
            // 2) Ночной закрытый аудиочат мафии (слышат только друг друга).
            // 3) Ночную стрельбу мафии с проверкой согласия.
            // 4) Ночные проверки Шерифа и Дона.
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            shuffled[2].Role = PlayerRole.Sheriff;
        }
    }

    public (bool Success, string Message) NominatePlayer(string userId, int targetSlotNumber)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.DayDiscussion)
                return (false, "Выставлять кандидатов можно только во время дневного обсуждения.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || !actor.IsAlive)
                return (false, "Вы не можете выставлять кандидатов.");

            if (CurrentSpeakerSlot != actor.SlotNumber)
                return (false, "Выставлять кандидатуру можно только в свою минуту речи!");

            if (actor.LosesNextSpeech)
                return (false, "Вы лишены слова за 3-й выкрик/фол и не можете выставлять кандидатов.");

            if (_speakerNominatedThisTurn)
                return (false, "Вы уже выставили одного игрока в эту минуту! По правилам Мафии за свою речь можно выставить только одного кандидата.");

            if (targetSlotNumber < 1 || targetSlotNumber > _slots.Count)
                return (false, "Неверный номер игрока.");

            if (targetSlotNumber == actor.SlotNumber)
                return (false, "Нельзя выставить на голосование самого себя.");

            var target = _slots[targetSlotNumber - 1];
            if (string.IsNullOrEmpty(target.UserId) || !target.IsAlive)
                return (false, "Нельзя выставить мертвого или отсутствующего игрока.");

            if (_nominatedSlots.Contains(targetSlotNumber))
                return (false, $"Игрок #{targetSlotNumber} уже выставлен на голосование.");

            _nominatedSlots.Add(targetSlotNumber);
            _speakerNominatedThisTurn = true;
            AddEvent($"Игрок #{actor.SlotNumber} ({actor.Nickname}) выставил на голосование Игрока #{targetSlotNumber} ({target.Nickname})!", "alert");
            return (true, $"Игрок #{targetSlotNumber} выставлен.");
        }
    }

    public (bool Success, string Message) PassSpeech(string userId)
    {
        lock (_lock)
        {
            if (Phase is not (GamePhase.DayDiscussion or GamePhase.TieDiscussion))
                return (false, "Сейчас нет фазы речи.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || actor.SlotNumber != CurrentSpeakerSlot)
                return (false, "Сейчас говорит другой игрок.");

            // Передаем ход следующему
            if (Phase == GamePhase.TieDiscussion) NextTieSpeaker(); else NextSpeakerOrVote();
            return (true, "Речь завершена.");
        }
    }

    public (bool Success, string Message) Vote(string userId, int candidateSlotNumber)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Voting)
                return (false, "Сейчас не идет голосование.");

            var voter = _slots.FirstOrDefault(s => s.UserId == userId);
            if (voter == null || !voter.IsAlive)
                return (false, "Вы не можете голосовать.");

            if (!_nominatedSlots.Contains(candidateSlotNumber) || !IsLive(candidateSlotNumber))
                return (false, "Этот игрок не выставлен на голосование.");

            voter.VotedForSlot = candidateSlotNumber;
            return (true, "Голос принят.");
        }
    }

    public (bool Success, string Message) NightAction(string userId, int targetSlotNumber)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Night)
                return (false, "Действие доступно только ночью.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || !actor.IsAlive)
                return (false, "Вы мертвы.");

            if (targetSlotNumber < 1 || targetSlotNumber > _slots.Count)
                return (false, "Неверный слот.");

            var target = _slots[targetSlotNumber - 1];
            if (!target.IsAlive || string.IsNullOrEmpty(target.UserId))
                return (false, "Нельзя выбрать мертвого или отсутствующего игрока.");

            if (targetSlotNumber == actor.SlotNumber)
                return (false, "Нельзя выбирать себя в качестве ночной цели.");

            if (actor.Role is PlayerRole.Mafia or PlayerRole.Don)
            {
                actor.NightTargetSlot = targetSlotNumber;
                var aliveMafia = _slots.Where(s => s.IsAlive && s.Role is PlayerRole.Mafia or PlayerRole.Don).ToList();
                if (aliveMafia.Count <= 1)
                {
                    return (true, $"Жертва зафиксирована: Игрок #{targetSlotNumber} ({target.Nickname}). Он будет убит утром!");
                }

                int chosenCount = aliveMafia.Count(m => m.NightTargetSlot.HasValue);
                var distinctTargets = aliveMafia.Where(m => m.NightTargetSlot.HasValue).Select(m => m.NightTargetSlot!.Value).Distinct().ToList();

                if (chosenCount == aliveMafia.Count)
                {
                    if (distinctTargets.Count == 1)
                    {
                        return (true, $"Стрельба клана согласована единогласно! Жертва: Игрок #{targetSlotNumber} ({target.Nickname}). Он будет убит утром!");
                    }
                    else
                    {
                        var targetsList = string.Join(", ", distinctTargets.Select(t => $"#{t} ({_slots[t - 1].Nickname})"));
                        return (true, $"Внимание: разногласие клана! Выбраны разные цели: {targetsList}. Договоритесь до конца ночи, иначе будет промах!");
                    }
                }

                return (true, $"Выстрел направлен в Игрока #{targetSlotNumber} ({target.Nickname}). Проголосовали {chosenCount} из {aliveMafia.Count} членов мафии...");
            }

            if (actor.Role == PlayerRole.Sheriff)
            {
                if (_sheriffCheckedSlotThisNight.HasValue)
                    return (false, "Шериф уже совершил проверку этой ночью! За одну ночь можно проверить только одного игрока.");

                var isBlack = target.Role is PlayerRole.Mafia or PlayerRole.Don;
                var res = isBlack ? "ЧЕРНЫЙ (МАФИЯ)" : "КРАСНЫЙ (МИРНЫЙ)";
                _sheriffChecks[targetSlotNumber] = res;
                _sheriffCheckedSlotThisNight = targetSlotNumber;
                return (true, $"Результат проверки: Игрок #{targetSlotNumber} ({target.Nickname}) — {res}!");
            }

            return (false, "У вашей роли нет ночного действия.");
        }
    }

    public (bool Success, string Message) DonCheck(string userId, int targetSlotNumber)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Night)
                return (false, "Проверка доступна только ночью.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || !actor.IsAlive || actor.Role != PlayerRole.Don)
                return (false, "Только живой Дон мафии может проводить поиск шерифа.");

            if (_donCheckedSlotThisNight.HasValue)
                return (false, "Дон уже совершил проверку этой ночью! За одну ночь можно проверить только одного игрока.");

            if (targetSlotNumber < 1 || targetSlotNumber > _slots.Count)
                return (false, "Неверный слот.");

            var target = _slots[targetSlotNumber - 1];
            if (!target.IsAlive || string.IsNullOrEmpty(target.UserId))
                return (false, "Нельзя проверить мертвого или отсутствующего игрока.");

            if (targetSlotNumber == actor.SlotNumber)
                return (false, "Нет смысла проверять самого себя — потратьте проверку на другого игрока.");

            var isSheriff = target.Role == PlayerRole.Sheriff;
            var res = isSheriff ? "ШЕРИФ!" : "НЕ ШЕРИФ";
            _donChecks[targetSlotNumber] = res;
            _donCheckedSlotThisNight = targetSlotNumber;
            return (true, $"Проверка Дона: Игрок #{targetSlotNumber} ({target.Nickname}) — {res}!");
        }
    }

    public (bool Success, string Message) AddFoul(int targetSlotNumber)
    {
        lock (_lock)
        {
            if (Phase is GamePhase.Lobby or GamePhase.GameOver)
                return (false, "Фолы фиксируются во время партии.");

            if (targetSlotNumber < 1 || targetSlotNumber > _slots.Count)
                return (false, "Неверный номер игрока.");

            var target = _slots[targetSlotNumber - 1];
            if (!target.IsAlive || string.IsNullOrEmpty(target.UserId))
                return (false, "Игрок уже выбыл или отсутствует.");

            target.Fouls++;
            if (target.Fouls >= 4)
            {
                target.IsAlive = false;
                if (_activeShoutSlotNumber == targetSlotNumber)
                {
                    _activeShoutSlotNumber = null;
                    _activeShoutSecondsLeft = 0;
                }
                AddEvent($"Игрок #{targetSlotNumber} ({target.Nickname}) получил 4-й фол и дисквалифицирован из-за стола!", "death");
                HandleDisqualification(targetSlotNumber);
                return (true, $"Игрок #{targetSlotNumber} дисквалифицирован за 4 фола.");
            }

            if (target.Fouls == 3)
            {
                target.LosesNextSpeech = true;
                AddEvent($"Игрок #{targetSlotNumber}: третий фол, следующая речь пропускается.", "alert");
                return (true, "Назначен третий фол: одна речь пропускается.");
            }

            AddEvent($"Игроку #{targetSlotNumber} ({target.Nickname}) вынесено замечание (фол {target.Fouls}/4).", "alert");
            return (true, $"Фол назначен игроку #{targetSlotNumber}.");
        }
    }

    public (bool Success, string Message) Shout(string userId)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.DayDiscussion)
                return (false, "Выкрик можно использовать только во время дневного обсуждения, пока говорит другой игрок.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || !actor.IsAlive)
                return (false, "Вы не можете совершить выкрик.");

            if (actor.SlotNumber == CurrentSpeakerSlot)
                return (false, "Сейчас ваша минута речи! Вы и так можете говорить, фол за выкрик не требуется.");

            if (actor.ShoutsCount >= 3)
                return (false, "Вы уже использовали максимальные 3 выкрика за игру (3-й лишил вас слова). Дальше — только удаление из игры.");

            if (_activeShoutSlotNumber.HasValue && _activeShoutSecondsLeft > 0)
            {
                var curShouter = _slots[_activeShoutSlotNumber.Value - 1];
                return (false, $"Сейчас уже говорит выкриком Игрок #{curShouter.SlotNumber} ({curShouter.Nickname}). Подождите пару секунд.");
            }

            actor.ShoutsCount++;
            actor.Fouls++;
            _activeShoutSlotNumber = actor.SlotNumber;
            _activeShoutSecondsLeft = 6;

            if (actor.Fouls >= 4)
            {
                actor.IsAlive = false;
                _activeShoutSlotNumber = null;
                _activeShoutSecondsLeft = 0;
                AddEvent($"Игрок #{actor.SlotNumber} ({actor.Nickname}) совершил выкрик и получил 4-й фол — дисквалифицирован из игры!", "death");
                HandleDisqualification(actor.SlotNumber);
                return (true, "4-й фол: вы дисквалифицированы из-за стола.");
            }

            if (actor.ShoutsCount == 3 || actor.Fouls == 3)
            {
                actor.LosesNextSpeech = true;
                AddEvent($"⚡ Игрок #{actor.SlotNumber} ({actor.Nickname}) взял 3-Й ВЫКРИК (фол {actor.Fouls}/4)! Игрок ЛИШАЕТСЯ следующей речи! Микрофон открыт на 6 сек.", "death");
                return (true, "3-й выкрик зафиксирован! Вы получили 3-й фол и лишены следующей речи. Микрофон открыт на 6 секунд.");
            }

            AddEvent($"📢 Игрок #{actor.SlotNumber} ({actor.Nickname}) взял ВЫКРИК (выкрик {actor.ShoutsCount}/2, фол {actor.Fouls}/4)! Микрофон открыт на 6 сек.", "alert");
            return (true, $"Выкрик {actor.ShoutsCount}/2 оформлен (+1 фол). У вас 6 секунд речи!");
        }
    }

    // Обработка тика таймера каждую секунду.
    // Возвращает true, если видимое игрокам состояние изменилось (фаза, спикер, активный выкрик)
    // и клиентам нужен полный рефреш состояния, а не только значение таймера.
    public bool TickSecond()
    {
        lock (_lock)
        {
            if (Phase is GamePhase.Lobby or GamePhase.GameOver)
                return false;

            var prevPhase = Phase;
            var prevSpeaker = CurrentSpeakerSlot;
            var prevShoutSlot = _activeShoutSlotNumber;

            if (_activeShoutSecondsLeft > 0)
            {
                _activeShoutSecondsLeft--;
                if (_activeShoutSecondsLeft == 0)
                {
                    _activeShoutSlotNumber = null;
                }
            }

            if (SecondsLeft > 0)
            {
                SecondsLeft--;
                if (SecondsLeft > 0) return prevShoutSlot != _activeShoutSlotNumber;
            }

            // Таймер истек — переключаем фазы
            switch (Phase)
            {
                case GamePhase.NightZero:
                    // Завершилась нулевая ночь — наступает День 1
                    StartDay(1);
                    break;

                case GamePhase.DayDiscussion:
                    // Время спикера истекло — передаем слово следующему или на голосование
                    NextSpeakerOrVote();
                    break;

                case GamePhase.TieDiscussion:
                    NextTieSpeaker();
                    break;
                case GamePhase.GroupVoting:
                    FinishGroupVoting();
                    break;
                case GamePhase.Voting:
                    // Голосование завершилось — подсчитываем голоса
                    FinishVoting();
                    break;

                case GamePhase.Night:
                    // Обычная ночь завершилась — подводим итоги ночи
                    FinishNight();
                    break;
            }

            return prevPhase != Phase || prevSpeaker != CurrentSpeakerSlot || prevShoutSlot != _activeShoutSlotNumber;
        }
    }

    private void StartDay(int dayNum)
    {
        _votingRound = 0;
        _tieCandidates.Clear();
        _tieSpoken.Clear();
        _groupVotes.Clear();
        DayNumber = dayNum;
        Phase = GamePhase.DayDiscussion;
        _nominatedSlots.Clear();
        _speakerNominatedThisTurn = false;
        _spokenSlotsThisDay.Clear();
        _activeShoutSlotNumber = null;
        _activeShoutSecondsLeft = 0;

        // Спикер начинается с (DayNumber % AliveCount)
        var alive = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).OrderBy(s => s.SlotNumber).ToList();
        if (alive.Count == 0)
        {
            EndGame(GameWinner.None, "Все игроки погибли.");
            return;
        }

        // Стартует игрок, чей слот ближе всего к дню
        int startIdx = (dayNum - 1) % alive.Count;
        CurrentSpeakerSlot = alive[startIdx].SlotNumber;

        var speaker = _slots[CurrentSpeakerSlot.Value - 1];
        AddEvent($"Наступил День {DayNumber}. Город просыпается!", "info");

        if (speaker.LosesNextSpeech)
        {
            speaker.LosesNextSpeech = false;

            AddEvent($"🔇 Игрок #{speaker.SlotNumber} ({speaker.Nickname}) ЛИШЁН СЛОВА за 3-й выкрик/фол и пропускает свою речь!", "alert");
            NextSpeakerOrVote();
        }
        else
        {
            SecondsLeft = 60;
            AddEvent($"Слово предоставляется Игроку #{speaker.SlotNumber} ({speaker.Nickname}). У вас 60 секунд.", "alert");
        }
    }

    private void NextSpeakerOrVote()
    {
        var alive = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).OrderBy(s => s.SlotNumber).ToList();
        if (alive.Count == 0)
        {
            EndGame(GameWinner.None, "Все игроки погибли.");
            return;
        }

        // Речь текущего спикера (произнесенная или пропущенная за лишение слова) засчитана
        if (CurrentSpeakerSlot.HasValue)
        {
            _spokenSlotsThisDay.Add(CurrentSpeakerSlot.Value);
        }

        // Круг завершен, когда отговорили все живые
        bool everyoneSpoke = alive.All(s => _spokenSlotsThisDay.Contains(s.SlotNumber));
        if (everyoneSpoke)
        {
            // Все высказались — переходим к голосованию
            _activeShoutSlotNumber = null;
            _activeShoutSecondsLeft = 0;
            StartVoting();
            return;
        }

        // Ищем следующего живого игрока в круге
        int currentIdx = alive.FindIndex(s => s.SlotNumber == CurrentSpeakerSlot);
        int nextIdx;
        if (currentIdx >= 0)
        {
            nextIdx = (currentIdx + 1) % alive.Count;
        }
        else
        {
            // Спикер выбыл посреди своей речи (дисквалификация) — передаем слово
            // следующему живому игроку по порядку слотов после него
            nextIdx = alive.FindIndex(s => CurrentSpeakerSlot.HasValue && s.SlotNumber > CurrentSpeakerSlot.Value);
            if (nextIdx < 0) nextIdx = 0;
        }

        while (_spokenSlotsThisDay.Contains(alive[nextIdx].SlotNumber)) nextIdx = (nextIdx + 1) % alive.Count;
        CurrentSpeakerSlot = alive[nextIdx].SlotNumber;
        _speakerNominatedThisTurn = false;
        _activeShoutSlotNumber = null;
        _activeShoutSecondsLeft = 0;
        var speaker = _slots[CurrentSpeakerSlot.Value - 1];

        if (speaker.LosesNextSpeech)
        {
            speaker.LosesNextSpeech = false;

            AddEvent($"🔇 Игрок #{speaker.SlotNumber} ({speaker.Nickname}) ЛИШЁН СЛОВА за 3-й выкрик/фол и пропускает свою речь!", "alert");
            NextSpeakerOrVote();
        }
        else
        {
            SecondsLeft = 60;
            AddEvent($"Слово переходит к Игроку #{speaker.SlotNumber} ({speaker.Nickname}).", "info");
        }
    }

    private void StartVoting()
    {
        _activeShoutSlotNumber = null;
        _activeShoutSecondsLeft = 0;
        CurrentSpeakerSlot = null;
        _nominatedSlots.RemoveAll(n => !IsLive(n));
        foreach (var slot in _slots) slot.VotedForSlot = null;
        if (_nominatedSlots.Count < 2)
        {
            AddEvent($"Выставлено меньше двух кандидатов: голосование и исключение не проводятся.", "info");
            StartNight(); return;
        }
        if (_votingRound == 0) _votingRound = 1;
        Phase = GamePhase.Voting;
        SecondsLeft = 15;
        AddEvent($"Голосование, круг {_votingRound}: неподанные голоса уходят последнему кандидату.", "info");
    }

    private void FinishVoting()
    {
        _nominatedSlots.RemoveAll(n => !IsLive(n));
        if (_nominatedSlots.Count < 2) { StartNight(); return; }
        var counts = _nominatedSlots.ToDictionary(n => n, _ => 0);
        foreach (var voter in _slots.Where(s => IsLive(s.SlotNumber)))
        {
            int choice = voter.VotedForSlot is int n && counts.ContainsKey(n) ? n : _nominatedSlots[^1];
            voter.VotedForSlot = choice;
            counts[choice]++;
            AddEvent($"Игрок #{voter.SlotNumber} голосует против #{choice}.", "info");
        }
        int max = counts.Values.Max();
        var leaders = _nominatedSlots.Where(n => counts[n] == max).ToList();
        if (leaders.Count == 1)
        {
            _slots[leaders[0] - 1].IsAlive = false;
            AddEvent($"Игрок #{leaders[0]} исключён ({max} голосов).", "info");
            if (!CheckGameOver()) StartNight();
            return;
        }
        _tieCandidates.Clear(); _tieCandidates.AddRange(leaders);
        CurrentSpeakerSlot = null;
        if (_votingRound == 1)
        {
            _tieSpoken.Clear(); Phase = GamePhase.TieDiscussion;
            AddEvent($"Ничья: каждому кандидату предоставляется 30 секунд, затем повторное голосование.", "info");
            NextTieSpeaker();
        }
        else
        {
            Phase = GamePhase.GroupVoting; SecondsLeft = 15; _groupVotes.Clear();
            AddEvent($"Повторная ничья: голосование за подъём всей группы. Требуется строгое большинство всех живых игроков.", "info");
        }
    }

    private void NextTieSpeaker()
    {
        if (CurrentSpeakerSlot is int previous) _tieSpoken.Add(previous);
        while (true)
        {
            int next = _tieCandidates.FirstOrDefault(n => IsLive(n) && !_tieSpoken.Contains(n));
            if (next == 0)
            {
                _nominatedSlots.Clear(); _nominatedSlots.AddRange(_tieCandidates.Where(IsLive));
                _votingRound = 2; StartVoting(); return;
            }
            CurrentSpeakerSlot = next;
            var speaker = _slots[next - 1];
            if (speaker.LosesNextSpeech)
            {
                speaker.LosesNextSpeech = false; _tieSpoken.Add(next);
                AddEvent($"Игрок #{next}: речь пропущена за третий фол.", "info");
                continue;
            }
            SecondsLeft = 30;
            AddEvent($"Игрок #{next}: дополнительная речь, 30 секунд.", "info");
            return;
        }
    }

    public (bool Success, string Message) VoteGroup(string userId, bool support)
    {
        lock (_lock)
        {
            var voter = _slots.FirstOrDefault(s => s.UserId == userId && s.IsAlive);
            if (Phase != GamePhase.GroupVoting || voter == null) return (false, "Голосование за подъём группы недоступно.");
            _groupVotes[voter.SlotNumber] = support;
            return (true, "Голос принят.");
        }
    }

    private void FinishGroupVoting()
    {
        int alive = _slots.Count(s => IsLive(s.SlotNumber));
        int support = _groupVotes.Count(v => IsLive(v.Key) && v.Value);
        if (support > alive / 2)
        {
            foreach (int n in _tieCandidates.Where(IsLive).ToList())
            {
                _slots[n - 1].IsAlive = false;
                AddEvent($"Игрок #{n} исключён вместе с группой.", "info");
            }
            if (CheckGameOver()) return;
        }
        else AddEvent($"Группа остаётся: строгое большинство всех живых не поддержало подъём.", "info");
        StartNight();
    }

    private void HandleDisqualification(int number)
    {
        _nominatedSlots.Remove(number); _tieCandidates.Remove(number); _groupVotes.Remove(number);
        _slots[number - 1].VotedForSlot = null;
        foreach (var slot in _slots.Where(s => s.VotedForSlot == number)) slot.VotedForSlot = null;
        if (CheckGameOver()) return;
        if (CurrentSpeakerSlot == number)
        {
            if (Phase == GamePhase.DayDiscussion) NextSpeakerOrVote();
            else if (Phase == GamePhase.TieDiscussion) NextTieSpeaker();
        }
        if (Phase == GamePhase.Voting && _nominatedSlots.Count < 2) StartNight();
    }

    private void StartNight()
    {
        _activeShoutSlotNumber = null;
        _activeShoutSecondsLeft = 0;
        Phase = GamePhase.Night;
        SecondsLeft = 35; // 35 секунд на стрельбу и проверки
        CurrentSpeakerSlot = null;
        _sheriffCheckedSlotThisNight = null;
        _donCheckedSlotThisNight = null;
        _speakerNominatedThisTurn = false;

        // Сброс ночных целей
        foreach (var s in _slots) s.NightTargetSlot = null;

        AddEvent("Город засыпает. Просыпается мафия и шериф...", "night");
    }

    private void FinishNight()
    {
        // Проверяем стрельбу мафии
        var aliveMafia = _slots.Where(s => s.IsAlive && s.Role is PlayerRole.Mafia or PlayerRole.Don).ToList();
        
        int? targetToKill = null;
        if (aliveMafia.Count > 0)
        {
            // Если все живые мафиози указали на одну цель
            var targets = aliveMafia.Select(m => m.NightTargetSlot).Distinct().ToList();
            if (targets.Count == 1 && targets[0].HasValue)
            {
                targetToKill = targets[0]!.Value;
            }
        }

        if (targetToKill.HasValue)
        {
            var victim = _slots[targetToKill.Value - 1];
            if (victim.IsAlive)
            {
                victim.IsAlive = false;
                AddEvent($"Утро началось с трагедии: ночью был убит Игрок #{victim.SlotNumber} ({victim.Nickname})!", "death");
            }
            else
            {
                AddEvent("Ночью мафия стреляла в уже мертвого игрока. Никто не погиб.", "info");
            }
        }
        else
        {
            AddEvent("Утро началось спокойно: этой ночью никто не погиб (мафия промахнулась или не договорилась)!", "info");
        }

        if (CheckGameOver()) return;

        StartDay(DayNumber + 1);
    }

    private bool CheckGameOver()
    {
        // В тестовых режимах на 2 игрока игра не завершается автоматически по паритету,
        // чтобы дать возможность протестировать звук и действия столько, сколько нужно
        if (Mode is RoomMode.TestTwoPeacefuls or RoomMode.TestTwoMafia)
        {
            return false;
        }

        var alive = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).ToList();
        int mafiaCount = alive.Count(s => s.Role is PlayerRole.Mafia or PlayerRole.Don);
        int peacefulCount = alive.Count - mafiaCount;

        if (mafiaCount == 0)
        {
            EndGame(GameWinner.Peacefuls, "Все члены мафии уничтожены. Победа мирных жителей!");
            return true;
        }

        // В тестовом сценарии на 4 игрока (2 мафии vs 2 мирных) игра стартует при счете 2:2.
        // Мафия побеждает при получении перевеса (2 vs 1 или 1 vs 0), а не сразу на старте.
        // При стандартных столах (5+ игроков) действует классическое правило паритета (mafiaCount >= peacefulCount).
        int totalOccupied = _slots.Count(s => !string.IsNullOrEmpty(s.UserId));
        bool isSmallTestGame = totalOccupied <= 4;

        bool mafiaWon = isSmallTestGame
            ? (mafiaCount > peacefulCount || peacefulCount == 0)
            : (mafiaCount >= peacefulCount);

        if (mafiaWon)
        {
            EndGame(GameWinner.Mafia, "Мафия победила город!");
            return true;
        }

        return false;
    }

    private void EndGame(GameWinner winner, string reason)
    {
        Phase = GamePhase.GameOver;
        Winner = winner;
        SecondsLeft = 0;
        CurrentSpeakerSlot = null;

        AddEvent($"ИГРА ОКОНЧЕНА! {reason}", "alert");
    }

    public void ResetGame()
    {
        lock (_lock)
        {
            Phase = GamePhase.Lobby;
            DayNumber = 0;
            SecondsLeft = 0;
            CurrentSpeakerSlot = null;
            Winner = GameWinner.None;
            _votingRound = 0;
            _tieCandidates.Clear();
            _tieSpoken.Clear();
            _groupVotes.Clear();
            _nominatedSlots.Clear();
            _sheriffChecks.Clear();
            _donChecks.Clear();
            _speakerNominatedThisTurn = false;
            _spokenSlotsThisDay.Clear();
            _sheriffCheckedSlotThisNight = null;
            _donCheckedSlotThisNight = null;
            _activeShoutSlotNumber = null;
            _activeShoutSecondsLeft = 0;

            foreach (var s in _slots)
            {
                s.IsReady = false;
                s.IsAlive = true;
                s.Role = PlayerRole.Unknown;
                s.NightTargetSlot = null;
                s.VotedForSlot = null;
                s.Fouls = 0;
                s.ShoutsCount = 0;
                s.LosesNextSpeech = false;
            }

            AddEvent("Игра сброшена в лобби. Займите слоты и приготовьтесь.", "info");
        }
    }

    private void AddEvent(string text, string type)
    {
        _events.Add(new GameEvent { Text = text, Type = type, Timestamp = DateTime.UtcNow });
        if (_events.Count > 100) _events.RemoveAt(0);
    }

    public PublicGameStateDto GetPublicStateForUser(string? userId)
    {
        lock (_lock)
        {
            var mySlot = string.IsNullOrEmpty(userId) ? null : _slots.FirstOrDefault(s => s.UserId == userId);
            bool isMeMafia = mySlot?.Role is PlayerRole.Mafia or PlayerRole.Don;
            bool isGameOver = Phase == GamePhase.GameOver;

            var slotsDto = _slots.Select(s =>
            {
                bool showRole = isGameOver || (s.UserId == userId) || (isMeMafia && s.Role is PlayerRole.Mafia or PlayerRole.Don);

                string? roleCode = showRole ? s.Role switch
                {
                    PlayerRole.Peaceful => "peaceful",
                    PlayerRole.Mafia => "mafia",
                    PlayerRole.Don => "don",
                    PlayerRole.Sheriff => "sheriff",
                    _ => "unknown"
                } : (s.IsAlive ? "hidden" : "unknown");

                string? roleTitle = showRole ? s.Role switch
                {
                    PlayerRole.Peaceful => "Мирный",
                    PlayerRole.Mafia => "Мафия",
                    PlayerRole.Don => "Дон Мафии",
                    PlayerRole.Sheriff => "Шериф",
                    _ => null
                } : null;

                return new PublicPlayerDto
                {
                    SlotNumber = s.SlotNumber,
                    UserId = s.UserId,
                    Nickname = s.Nickname,
                    IsOccupied = !string.IsNullOrEmpty(s.UserId),
                    IsReady = s.IsReady,
                    IsAlive = s.IsAlive,
                    IsCurrentSpeaker = s.SlotNumber == CurrentSpeakerSlot,
                    IsNominated = _nominatedSlots.Contains(s.SlotNumber),
                    Fouls = s.Fouls,
                    ShoutsCount = s.ShoutsCount,
                    LosesNextSpeech = s.LosesNextSpeech,
                    RoleCode = roleCode,
                    RoleTitle = roleTitle,
                    VotedForSlot = (Phase == GamePhase.Voting && s.UserId == userId) ? s.VotedForSlot : null
                };
            }).ToList();

            string phaseTitle = Phase switch
            {
                GamePhase.Lobby => "Лобби (Ожидание игроков)",
                GamePhase.NightZero => "Нулевая ночь (Договорка мафии)",
                GamePhase.DayDiscussion => $"День {DayNumber} (Обсуждение)",
                GamePhase.TieDiscussion => "Дополнительные речи",
                GamePhase.GroupVoting => "Голосование за подъём группы",
                GamePhase.Voting => $"День {DayNumber} (Голосование)",
                GamePhase.Night => $"Ночь {DayNumber} (Стрельба и проверки)",
                GamePhase.GameOver => "Игра окончена",
                _ => ""
            };

            string phaseDesc = Phase switch
            {
                GamePhase.Lobby => "Займите свободный слот за столом и нажмите «Готов».",
                GamePhase.NightZero => "Город спит. Мафия знакомится и договаривается голосом.",
                GamePhase.DayDiscussion => CurrentSpeakerSlot.HasValue 
                    ? $"Говорит Игрок #{CurrentSpeakerSlot.Value} ({_slots[CurrentSpeakerSlot.Value - 1].Nickname})."
                    : "Обсуждение.",
                GamePhase.TieDiscussion => $"Игрок #{CurrentSpeakerSlot}: 30 секунд.",
                GamePhase.GroupVoting => "Голосование за подъём всех оставшихся в ничьей; воздержание считается против.",
                GamePhase.Voting => "Выберите кандидата, против которого хотите отдать свой голос.",
                GamePhase.Night => "Мафия стреляет по общей цели. Шериф и Дон совершают ночные проверки.",
                GamePhase.GameOver => Winner switch
                {
                    GameWinner.Peacefuls => "Победа красного города (Мирные жители)!",
                    GameWinner.Mafia => "Победа черного клана (Мафия)!",
                    _ => "Ничья!"
                },
                _ => ""
            };

            bool canSpeak = !string.IsNullOrEmpty(userId) && CanUserSpeakNow(userId);

            int aliveMafiaCount = _slots.Count(s => s.IsAlive && s.Role is PlayerRole.Mafia or PlayerRole.Don);

            return new PublicGameStateDto
            {
                HostUserId = HostUserId,
                VotingRound = _votingRound,
                TieCandidateSlots = _tieCandidates.ToList(),
                GroupVotesFor = _groupVotes.Count(v => IsLive(v.Key) && v.Value),
                GroupVotesAgainst = _slots.Count(s => IsLive(s.SlotNumber)) - _groupVotes.Count(v => IsLive(v.Key) && v.Value),
                CanGroupVoteNow = Phase == GamePhase.GroupVoting && mySlot?.IsAlive == true,
                MyGroupVote = mySlot != null && _groupVotes.TryGetValue(mySlot.SlotNumber, out var groupVote) ? groupVote : null,
                Phase = Phase,
                PhaseTitle = phaseTitle,
                PhaseDescription = phaseDesc,
                DayNumber = DayNumber,
                SecondsLeft = SecondsLeft,
                CurrentSpeakerSlot = CurrentSpeakerSlot,
                NominatedSlots = _nominatedSlots.ToList(),
                Slots = slotsDto,
                RecentEvents = _events.TakeLast(30).ToList(),
                MySlotNumber = mySlot?.SlotNumber,
                MyRoleCode = mySlot?.Role switch
                {
                    PlayerRole.Peaceful => "peaceful",
                    PlayerRole.Mafia => "mafia",
                    PlayerRole.Don => "don",
                    PlayerRole.Sheriff => "sheriff",
                    _ => null
                },
                MyRoleTitle = mySlot?.Role switch
                {
                    PlayerRole.Peaceful => "Мирный житель",
                    PlayerRole.Mafia => "Мафия",
                    PlayerRole.Don => "Дон Мафии",
                    PlayerRole.Sheriff => "Шериф",
                    _ => null
                },
                CanSpeakNow = canSpeak,
                CanVoteNow = Phase == GamePhase.Voting && mySlot != null && mySlot.IsAlive,
                CanShootNow = Phase == GamePhase.Night && mySlot != null && mySlot.IsAlive && isMeMafia,
                CanCheckNow = Phase == GamePhase.Night && mySlot != null && mySlot.IsAlive && (mySlot.Role is PlayerRole.Sheriff or PlayerRole.Don),
                HasNominatedThisTurn = _speakerNominatedThisTurn,
                HasCheckedThisNight = (mySlot?.Role == PlayerRole.Sheriff && _sheriffCheckedSlotThisNight.HasValue) ||
                                      (mySlot?.Role == PlayerRole.Don && _donCheckedSlotThisNight.HasValue),
                KnownChecks = (mySlot?.Role == PlayerRole.Sheriff) ? new Dictionary<int, string>(_sheriffChecks) :
                              (mySlot?.Role == PlayerRole.Don) ? new Dictionary<int, string>(_donChecks) : new(),
                MyNightTargetSlot = mySlot?.NightTargetSlot,
                AliveMafiaCount = (isMeMafia || isGameOver) ? aliveMafiaCount : 0,
                MaxSlots = MaxSlots,
                RoomConfigCode = RoomConfigCode,
                ActiveShoutSlotNumber = _activeShoutSlotNumber,
                ActiveShoutSecondsLeft = _activeShoutSecondsLeft,
                MyShoutsCount = mySlot?.ShoutsCount ?? 0,
                MyLosesNextSpeech = mySlot?.LosesNextSpeech ?? false,
                Winner = Winner
            };
        }
    }
}
