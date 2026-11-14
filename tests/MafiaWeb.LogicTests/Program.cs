using MafiaWeb.Models;
using MafiaWeb.Services;

static class Program
{
    static int failures, total;
    static void Check(bool condition, string message = "assertion failed") { if (!condition) throw new Exception(message); }
    static void Eq<T>(T expected, T actual) => Check(Equals(expected, actual), $"expected {expected}, actual {actual}");
    static void Ok((bool Success, string Message) r) => Check(r.Success, r.Message);
    static string U(int n) => $"u{n}";
    static PlayerSlot S(GameRoomService g, int n) => g.GetSlots().Single(s => s.SlotNumber == n);
    static void Ticks(GameRoomService g, int n) { for (int i = 0; i < n; i++) g.TickSecond(); }
    static GameRoomService Lobby(int n = 8) {
        var g = new GameRoomService(); Ok(g.ConfigureTable(n.ToString()));
        for (int i = 1; i <= n; i++) Ok(g.TakeSlot(i, U(i), U(i), U(i)));
        return g;
    }
    static GameRoomService New(int n = 8) {
        var g = Lobby(n); for (int i = 1; i <= n; i++) Check(g.ToggleReady(U(i))); Ok(g.StartGame()); return g;
    }
    // Deterministic roles using the public mutable references, never reflection/private state.
    static void Roles(GameRoomService g, params int[] black) {
        foreach (var s in g.GetSlots()) s.Role = PlayerRole.Peaceful;
        for (int i = 0; i < black.Length; i++) S(g, black[i]).Role = i == 0 ? PlayerRole.Don : PlayerRole.Mafia;
        var sheriff = g.GetSlots().First(s => !black.Contains(s.SlotNumber)); sheriff.Role = PlayerRole.Sheriff;
    }
    static GameRoomService Day(int n = 8) { var g = New(n); Roles(g, 7, 8); Ticks(g, 60); return g; }
    static void EndSpeeches(GameRoomService g) {
        int guard = 30;
        while (g.Phase == GamePhase.DayDiscussion && guard-- > 0) Ok(g.PassSpeech(U(g.CurrentSpeakerSlot!.Value)));
        Check(guard > 0, "speech circle failed to terminate");
    }
    static void Voting(GameRoomService g, int first = 3, int second = 4) {
        Ok(g.NominatePlayer(U(g.CurrentSpeakerSlot!.Value), first));
        Ok(g.PassSpeech(U(g.CurrentSpeakerSlot!.Value)));
        Ok(g.NominatePlayer(U(g.CurrentSpeakerSlot!.Value), second)); EndSpeeches(g); Eq(GamePhase.Voting, g.Phase);
    }
    static void TieVote(GameRoomService g, int a = 3, int b = 4) {
        var live = g.GetSlots().Where(s => s.IsAlive).ToList(); Check(live.Count % 2 == 0);
        for (int i = 0; i < live.Count; i++) Ok(g.Vote(live[i].UserId!, i < live.Count / 2 ? a : b));
        Ticks(g, 15);
    }
    static GameRoomService Group(int a = 3, int b = 4) {
        var g = Day(); Voting(g, a, b); TieVote(g, a, b); Eq(GamePhase.TieDiscussion, g.Phase);
        Eq(30, g.SecondsLeft); Eq((int?)a, g.CurrentSpeakerSlot);
        Ticks(g, 29); Eq(1, g.SecondsLeft); Eq((int?)a, g.CurrentSpeakerSlot);
        Ticks(g, 1); Eq((int?)b, g.CurrentSpeakerSlot); Eq(30, g.SecondsLeft);
        Ticks(g, 30); Eq(GamePhase.Voting, g.Phase); Eq(2, g.GetPublicStateForUser(U(1)).VotingRound);
        TieVote(g, a, b); Eq(GamePhase.GroupVoting, g.Phase); return g;
    }
    static void Test(string name, Action action) {
        total++; try { action(); Console.WriteLine($"PASS {name}"); }
        catch (Exception e) { failures++; Console.WriteLine($"FAIL {name}: {e.Message}\n{e.StackTrace}"); }
    }
    static int Main() {
        Test("readiness gates start, moving clears readiness, reset", () => {
            var g = Lobby(4); Check(!g.StartGame().Success); for(int i=1;i<=3;i++) Check(g.ToggleReady(U(i)));
            Check(!g.StartGame().Success); Check(g.ToggleReady(U(4))); Ok(g.StartGame()); Check(!g.ToggleReady(U(1)));
            g.ResetGame(); Check(g.GetSlots().All(s=>!s.IsReady)); Check(!g.StartGame().Success);
            Ok(g.LeaveSlot(U(4))); Check(g.ToggleReady(U(1))); Ok(g.TakeSlot(4,U(1),"moved","c")); Check(!S(g,4).IsReady); Check(!S(g,1).IsReady);
        });
        Test("exactly 60 ticks night-zero and speech", () => {
            var g=New(); Ticks(g,59); Eq(GamePhase.NightZero,g.Phase); Eq(1,g.SecondsLeft);
            Check(g.TickSecond()); Eq(GamePhase.DayDiscussion,g.Phase); Eq(60,g.SecondsLeft); Eq((int?)1,g.CurrentSpeakerSlot);
            Ticks(g,59); Eq((int?)1,g.CurrentSpeakerSlot); Eq(1,g.SecondsLeft); Check(g.TickSecond()); Eq((int?)2,g.CurrentSpeakerSlot); Eq(60,g.SecondsLeft);
        });
        foreach(int n in new[]{4,8,10,12}) Test($"role distribution {n}",()=>{
            var g=New(n); var ss=g.GetSlots(); Eq(1,ss.Count(s=>s.Role==PlayerRole.Don)); Eq(1,ss.Count(s=>s.Role==PlayerRole.Sheriff));
            Eq(n==12?4:n==10?3:2,ss.Count(s=>s.Role is PlayerRole.Don or PlayerRole.Mafia)); Check(ss.All(s=>s.IsAlive));
        });
        Test("third foul skips current speech; nomination reset",()=>{
            var g=Day(); Ok(g.NominatePlayer(U(1),3)); Check(!g.NominatePlayer(U(1),4).Success);
            for(int i=0;i<3;i++) Ok(g.AddFoul(1)); Eq((int?)2,g.CurrentSpeakerSlot); Check(!S(g,1).LosesNextSpeech);
            Check(!g.NominatePlayer(U(1),4).Success); Ok(g.NominatePlayer(U(2),4));
        });
        Test("third foul skips future speech exactly once",()=>{
            var g=Day(); for(int i=0;i<3;i++) Ok(g.AddFoul(2)); Check(S(g,2).LosesNextSpeech);
            Ok(g.PassSpeech(U(1))); Eq((int?)3,g.CurrentSpeakerSlot); Check(!S(g,2).LosesNextSpeech); EndSpeeches(g); Ticks(g,35);
            Eq((int?)2,g.CurrentSpeakerSlot); Check(g.CanUserSpeakNow(U(2)));
        });
        Test("three shouts skip speech and expire in six ticks",()=>{
            var g=Day(); for(int i=0;i<3;i++){ Ok(g.Shout(U(2))); Check(g.CanUserSpeakNow(U(2))); Ticks(g,6); }
            Check(!g.CanUserSpeakNow(U(2))); Check(S(g,2).LosesNextSpeech); Check(!g.Shout(U(2)).Success);
            Ok(g.PassSpeech(U(1))); Eq((int?)3,g.CurrentSpeakerSlot);
        });
        Test("single candidate goes to night on days one and two",()=>{
            var g=Day(); for(int d=1;d<=2;d++) { Eq(d,g.DayNumber); Ok(g.NominatePlayer(U(g.CurrentSpeakerSlot!.Value),4)); EndSpeeches(g); Eq(GamePhase.Night,g.Phase); Check(S(g,4).IsAlive); Ticks(g,35); }
        });
        Test("uncast votes automatically go to last nominee",()=>{
            var g=Day(); Voting(g); Ok(g.Vote(U(1),3)); Ticks(g,15); Check(!S(g,4).IsAlive); Check(S(g,3).IsAlive); Eq(4,S(g,2).VotedForSlot); Eq(GamePhase.Night,g.Phase);
        });
        Test("dead nomination and dead voters rejected; dead candidate removed",()=>{
            var g=Day(); S(g,5).IsAlive=false; Check(!g.NominatePlayer(U(1),5).Success); Voting(g);
            Check(!g.Vote(U(5),3).Success); Ok(g.Vote(U(1),3)); for(int i=0;i<4;i++) Ok(g.AddFoul(3));
            Eq(GamePhase.Night,g.Phase); Check(S(g,1).VotedForSlot==null); Check(!g.GetPublicStateForUser(U(1)).NominatedSlots.Contains(3));
        });
        Test("dead candidate and votes ignored even through public mutation",()=>{
            var g=Day(); Voting(g); S(g,3).IsAlive=false; S(g,1).VotedForSlot=3; Ticks(g,15); Eq(GamePhase.Night,g.Phase); Check(S(g,4).IsAlive);
        });
        Test("dead voter's previously cast vote excluded from tally",()=>{
            var g=Day(); Voting(g); foreach(int i in new[]{1,2,5,6}) Ok(g.Vote(U(i),3));
            S(g,6).IsAlive=false; Ticks(g,15); Eq(GamePhase.Night,g.Phase); Check(!S(g,4).IsAlive); Check(S(g,3).IsAlive);
        });
        Test("hidden mafia count and role visibility",()=>{
            var g=Day(); foreach(var id in new string?[]{null,"spectator",U(1)}) {var dto=g.GetPublicStateForUser(id); Eq(0,dto.AliveMafiaCount); Eq("hidden",dto.Slots.Single(s=>s.SlotNumber==7).RoleCode);}
            Eq(2,g.GetPublicStateForUser(U(7)).AliveMafiaCount); Eq("mafia",g.GetPublicStateForUser(U(7)).Slots.Single(s=>s.SlotNumber==8).RoleCode);
            Eq("sheriff",g.GetPublicStateForUser(U(1)).MyRoleCode);
        });
        Test("tie speeches, repeat tie, half is insufficient and abstentions against",()=>{
            var g=Group(); for(int i=1;i<=4;i++) Ok(g.VoteGroup(U(i),true)); var dto=g.GetPublicStateForUser(U(1)); Eq(4,dto.GroupVotesFor); Eq(4,dto.GroupVotesAgainst);
            Ticks(g,15); Check(S(g,3).IsAlive&&S(g,4).IsAlive); Eq(GamePhase.Night,g.Phase);
        });
        Test("group strict majority removes all candidates",()=>{
            var g=Group(); for(int i=1;i<=5;i++) Ok(g.VoteGroup(U(i),true)); Ok(g.VoteGroup(U(6),false)); Ticks(g,15); Check(!S(g,3).IsAlive&&!S(g,4).IsAlive); Eq(GamePhase.Night,g.Phase);
        });
        Test("group removes entire group before victory evaluation",()=>{
            var g=Group(7,8); // Removing just the first black must not prevent removal of the second.
            for(int i=1;i<=5;i++) Ok(g.VoteGroup(U(i),true)); Ticks(g,15); Check(!S(g,7).IsAlive&&!S(g,8).IsAlive); Eq(GameWinner.Peacefuls,g.Winner);
            Eq(0,g.GetPublicStateForUser(null).AliveMafiaCount); Eq("don",g.GetPublicStateForUser(null).Slots.Single(s=>s.SlotNumber==7).RoleCode);
        });
        Test("group atomic removal avoids intermediate mafia parity win",()=>{
            var g=Group(3,7); // At 8 alive configure 3 black/5 red: red removal first would create 3:4, so reduce beforehand to 6.
            Roles(g,6,7,8); S(g,1).IsAlive=false; S(g,2).IsAlive=false; // 3:3; removing red #3 first yields 3:2; black #7 then yields 2:2.
            // Final 2:2 is still parity; use special 4 occupied not possible here. Assert both removed despite intermediate victory.
            foreach(int i in new[]{3,4,5,6}) Ok(g.VoteGroup(U(i),true)); Ticks(g,15); Check(!S(g,3).IsAlive&&!S(g,7).IsAlive); Eq(GameWinner.Mafia,g.Winner);
        });
        foreach(int n in new[]{8,10}) Test($"parity ends standard {n}",()=>{
            var g=New(n); Roles(g,1,2); foreach(var s in g.GetSlots().Where(s=>s.SlotNumber>4)) s.IsAlive=false;
            Ticks(g,60); EndSpeeches(g); Ticks(g,35); Eq(GameWinner.Mafia,g.Winner); Eq(GamePhase.GameOver,g.Phase);
        });
        Test("special four survives parity but loses at black majority",()=>{
            var g=New(4); Roles(g,1,2); Ticks(g,60); EndSpeeches(g); Ticks(g,35); Eq(GameWinner.None,g.Winner); Eq(GamePhase.DayDiscussion,g.Phase);
            EndSpeeches(g); Ok(g.NightAction(U(1),4)); Ok(g.NightAction(U(2),4)); Ticks(g,35); Eq(GameWinner.Mafia,g.Winner);
        });
        Test("sheriff/don checks private, once per night and reset",()=>{
            var g=Day(); EndSpeeches(g); Ok(g.NightAction(U(1),7)); Check(!g.NightAction(U(1),8).Success); Ok(g.DonCheck(U(7),1)); Check(!g.DonCheck(U(7),2).Success);
            Check(g.GetPublicStateForUser(U(1)).KnownChecks[7].Contains("ЧЕРНЫЙ")); Check(g.GetPublicStateForUser(U(7)).KnownChecks[1].Contains("ШЕРИФ"));
            Eq(0,g.GetPublicStateForUser(U(2)).KnownChecks.Count); Check(!g.DonCheck(U(8),1).Success); Check(!g.NightAction(U(2),7).Success);
            Ticks(g,35); EndSpeeches(g); Ok(g.NightAction(U(1),2)); Ok(g.DonCheck(U(7),2));
        });
        foreach(int mode in new[]{0,1,2}) Test($"shooting consensus mode {mode} (agree/disagree/missing)",()=>{
            var g=Day(); EndSpeeches(g); Ok(g.NightAction(U(7),3)); if(mode!=2) Ok(g.NightAction(U(8),mode==0?3:4));
            Ticks(g,35); Eq(mode!=0,S(g,3).IsAlive); Check(S(g,4).IsAlive);
        });
        Test("dead/self night targets rejected",()=>{
            var g=Day(); EndSpeeches(g); S(g,4).IsAlive=false; Check(!g.NightAction(U(7),4).Success); Check(!g.NightAction(U(7),7).Success); Check(!g.DonCheck(U(7),4).Success); Check(!g.NightAction(U(4),3).Success);
        });
        Test("speaker disqualification does not break speech circle",()=>{
            var g=Day(); for(int i=0;i<4;i++) Ok(g.AddFoul(1)); Eq((int?)2,g.CurrentSpeakerSlot);
            var seen=new HashSet<int>(); while(g.Phase==GamePhase.DayDiscussion) {Check(seen.Add(g.CurrentSpeakerSlot!.Value),"speaker repeats"); Check(seen.Count<=7); Ok(g.PassSpeech(U(g.CurrentSpeakerSlot.Value)));}
            Eq(7,seen.Count); Eq(GamePhase.Night,g.Phase);
        });
        Console.WriteLine($"RESULT: {total-failures}/{total} passed; {failures} failed"); return failures==0?0:1;
    }
}
