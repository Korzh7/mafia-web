using System.Collections.Concurrent;
using MafiaWeb.Models;

namespace MafiaWeb.Services;

public class GameRoomService
{
    private readonly object _lock = new();
    private readonly List<PlayerSlot> _slots = new(8);
    private readonly List<GameEvent> _events = new();
    private readonly List<int> _nominatedSlots = new();
    private readonly Dictionary<string, string> _sheriffChecks = new(); // slot -> "Красный"/"Черный"
    private readonly Dictionary<string, string> _donChecks = new();     // slot -> "Шериф"/"Не шериф"

    public GamePhase Phase { get; private set; } = GamePhase.Lobby;
    public int DayNumber { get; private set; } = 0;
    public int SecondsLeft { get; private set; } = 0;
    public int? CurrentSpeakerSlot { get; private set; }
    public GameWinner Winner { get; private set; } = GameWinner.None;
    
    // Кандидаты на автокатастрофу (при ничьей)
    private List<int> _tieSlots = new();

    public GameRoomService()
    {
        for (int i = 1; i <= 8; i++)
        {
            _slots.Add(new PlayerSlot { SlotNumber = i });
        }
        AddEvent("Комната создана. Займите свои места за столом (1-8).", "info");
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
        lock (_lock)
        {
            return _slots.FirstOrDefault(s => s.UserId == userId)?.ConnectionId;
        }
    }

    public (bool Success, string Message) TakeSlot(int slotNumber, string userId, string nickname, string connectionId)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.Lobby)
                return (false, "Игра уже началась. Занять место нельзя.");

            if (slotNumber < 1 || slotNumber > 8)
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
            if (occupied.Count < 4)
                return (false, "Для игры нужно хотя бы 4 игрока (рекомендуется 8).");

            DistributeRoles(occupied);

            Phase = GamePhase.NightZero;
            DayNumber = 0;
            SecondsLeft = 60; // 60 секунд на договорку мафии
            _nominatedSlots.Clear();
            _sheriffChecks.Clear();
            _donChecks.Clear();
            Winner = GameWinner.None;

            AddEvent("Игра началась! Наступает Нулевая ночь — договорка мафии.", "night");
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
        }

        int count = players.Count;
        if (count >= 7)
        {
            // 8 игроков (или 7): 1 Дон, 1 Мафия, 1 Шериф, остальные Мирные
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Mafia;
            shuffled[2].Role = PlayerRole.Sheriff;
            // 3..7 мирные
        }
        else if (count >= 5)
        {
            // 5-6 игроков: 1 Дон (он же мафия), 1 Шериф, остальные мирные
            shuffled[0].Role = PlayerRole.Don;
            shuffled[1].Role = PlayerRole.Sheriff;
        }
        else
        {
            // 4 игрока: 1 Мафия, 1 Шериф, 2 мирных
            shuffled[0].Role = PlayerRole.Mafia;
            shuffled[1].Role = PlayerRole.Sheriff;
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

            if (targetSlotNumber < 1 || targetSlotNumber > 8)
                return (false, "Неверный номер игрока.");

            var target = _slots[targetSlotNumber - 1];
            if (string.IsNullOrEmpty(target.UserId) || !target.IsAlive)
                return (false, "Нельзя выставить мертвого или отсутствующего игрока.");

            if (_nominatedSlots.Contains(targetSlotNumber))
                return (false, $"Игрок #{targetSlotNumber} уже выставлен на голосование.");

            _nominatedSlots.Add(targetSlotNumber);
            AddEvent($"Игрок #{actor.SlotNumber} ({actor.Nickname}) выставил на голосование Игрока #{targetSlotNumber} ({target.Nickname})!", "alert");
            return (true, $"Игрок #{targetSlotNumber} выставлен.");
        }
    }

    public (bool Success, string Message) PassSpeech(string userId)
    {
        lock (_lock)
        {
            if (Phase != GamePhase.DayDiscussion)
                return (false, "Сейчас нет фазы речи.");

            var actor = _slots.FirstOrDefault(s => s.UserId == userId);
            if (actor == null || actor.SlotNumber != CurrentSpeakerSlot)
                return (false, "Сейчас говорит другой игрок.");

            // Передаем ход следующему
            NextSpeakerOrVote();
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

            if (!_nominatedSlots.Contains(candidateSlotNumber))
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

            if (targetSlotNumber < 1 || targetSlotNumber > 8)
                return (false, "Неверный слот.");

            var target = _slots[targetSlotNumber - 1];

            if (actor.Role is PlayerRole.Mafia or PlayerRole.Don)
            {
                actor.NightTargetSlot = targetSlotNumber;
                return (true, $"Выстрел направлен в Игрока #{targetSlotNumber}.");
            }

            if (actor.Role == PlayerRole.Sheriff)
            {
                var isBlack = target.Role is PlayerRole.Mafia or PlayerRole.Don;
                var res = isBlack ? "Черный (Мафия)" : "Красный (Мирный)";
                _sheriffChecks[targetSlotNumber.ToString()] = res;
                return (true, $"Проверка игрока #{targetSlotNumber}: {res}!");
            }

            return (false, "У вашей роли нет ночного действия.");
        }
    }

    // Обработка тика таймера каждую секунду
    public void TickSecond()
    {
        lock (_lock)
        {
            if (Phase is GamePhase.Lobby or GamePhase.GameOver)
                return;

            if (SecondsLeft > 0)
            {
                SecondsLeft--;
                return;
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

                case GamePhase.Voting:
                    // Голосование завершилось — подсчитываем голоса
                    FinishVoting();
                    break;

                case GamePhase.Night:
                    // Обычная ночь завершилась — подводим итоги ночи
                    FinishNight();
                    break;
            }
        }
    }

    private void StartDay(int dayNum)
    {
        DayNumber = dayNum;
        Phase = GamePhase.DayDiscussion;
        _nominatedSlots.Clear();

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
        SecondsLeft = 60;

        var speaker = _slots[CurrentSpeakerSlot.Value - 1];
        AddEvent($"Наступил День {DayNumber}. Город просыпается!", "info");
        AddEvent($"Слово предоставляется Игроку #{speaker.SlotNumber} ({speaker.Nickname}). У вас 60 секунд.", "alert");
    }

    private void NextSpeakerOrVote()
    {
        var alive = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).OrderBy(s => s.SlotNumber).ToList();
        int currentIdx = alive.FindIndex(s => s.SlotNumber == CurrentSpeakerSlot);

        // Ищем следующего живого игрока в круге
        int nextIdx = currentIdx + 1;

        // Если круг завершился
        int startIdx = (DayNumber - 1) % alive.Count;
        if (nextIdx >= alive.Count) nextIdx = 0;

        if (nextIdx == startIdx)
        {
            // Все высказались — переходим к голосованию
            StartVoting();
        }
        else
        {
            CurrentSpeakerSlot = alive[nextIdx].SlotNumber;
            SecondsLeft = 60;
            var speaker = _slots[CurrentSpeakerSlot.Value - 1];
            AddEvent($"Слово переходит к Игроку #{speaker.SlotNumber} ({speaker.Nickname}).", "info");
        }
    }

    private void StartVoting()
    {
        CurrentSpeakerSlot = null;
        
        // Очищаем предыдущие голоса
        foreach (var s in _slots) s.VotedForSlot = null;

        if (_nominatedSlots.Count == 0)
        {
            AddEvent("Ни один кандидат не был выставлен на голосование. Город засыпает без суда.", "info");
            StartNight();
            return;
        }

        if (_nominatedSlots.Count == 1)
        {
            // В первый день при одном кандидате голосование часто не проводится (правило классики)
            if (DayNumber == 1)
            {
                AddEvent($"Выставлен только Игрок #{_nominatedSlots[0]}. В первый день голосование не проводится. Город засыпает.", "info");
                StartNight();
                return;
            }
        }

        Phase = GamePhase.Voting;
        SecondsLeft = 15; // 15 секунд на клик по кандидату
        AddEvent($"Начинается голосование! Кандидаты: {string.Join(", ", _nominatedSlots.Select(n => $"#{n}"))}. У вас 15 секунд.", "alert");
    }

    private void FinishVoting()
    {
        var votesCount = new Dictionary<int, int>();
        foreach (var slotNum in _nominatedSlots)
            votesCount[slotNum] = 0;

        var aliveVoters = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).ToList();
        foreach (var voter in aliveVoters)
        {
            if (voter.VotedForSlot.HasValue && votesCount.ContainsKey(voter.VotedForSlot.Value))
            {
                votesCount[voter.VotedForSlot.Value]++;
                AddEvent($"Игрок #{voter.SlotNumber} ({voter.Nickname}) проголосовал против #{voter.VotedForSlot.Value}.", "info");
            }
            else
            {
                AddEvent($"Игрок #{voter.SlotNumber} ({voter.Nickname}) воздержался/не успел проголосовать.", "info");
            }
        }

        int maxVotes = votesCount.Values.DefaultIfEmpty(0).Max();
        var leaders = votesCount.Where(kv => kv.Value == maxVotes && maxVotes > 0).Select(kv => kv.Key).ToList();

        if (leaders.Count == 1)
        {
            int eliminatedSlot = leaders[0];
            var eliminated = _slots[eliminatedSlot - 1];
            eliminated.IsAlive = false;
            AddEvent($"Большинством голосов ({maxVotes}) город изгоняет Игрока #{eliminatedSlot} ({eliminated.Nickname})!", "death");

            if (CheckGameOver()) return;
        }
        else if (leaders.Count > 1)
        {
            AddEvent($"Голоса разделились поровну между игроками: {string.Join(", ", leaders.Select(l => $"#{l}"))}. Никто не покидает город (автокатастрофа)!", "alert");
        }
        else
        {
            AddEvent("Никто не проголосовал. Город никого не изгоняет.", "info");
        }

        StartNight();
    }

    private void StartNight()
    {
        Phase = GamePhase.Night;
        SecondsLeft = 35; // 35 секунд на стрельбу и проверки
        CurrentSpeakerSlot = null;

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
        var alive = _slots.Where(s => s.IsAlive && !string.IsNullOrEmpty(s.UserId)).ToList();
        int mafiaCount = alive.Count(s => s.Role is PlayerRole.Mafia or PlayerRole.Don);
        int peacefulCount = alive.Count - mafiaCount;

        if (mafiaCount == 0)
        {
            EndGame(GameWinner.Peacefuls, "Все члены мафии уничтожены. Победа мирных жителей!");
            return true;
        }

        if (mafiaCount >= peacefulCount)
        {
            EndGame(GameWinner.Mafia, "Мафия сравнялась по численности с мирными жителями. Победа мафии!");
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
            _nominatedSlots.Clear();
            _sheriffChecks.Clear();
            _donChecks.Clear();

            foreach (var s in _slots)
            {
                s.IsReady = false;
                s.IsAlive = true;
                s.Role = PlayerRole.Unknown;
                s.NightTargetSlot = null;
                s.VotedForSlot = null;
                s.Fouls = 0;
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
            var mySlot = _slots.FirstOrDefault(s => s.UserId == userId);
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

            bool canSpeak = Phase == GamePhase.DayDiscussion && mySlot != null && mySlot.IsAlive && mySlot.SlotNumber == CurrentSpeakerSlot;
            if (Phase == GamePhase.NightZero && isMeMafia) canSpeak = true;

            return new PublicGameStateDto
            {
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
                Winner = Winner
            };
        }
    }
}
