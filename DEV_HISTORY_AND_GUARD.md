# dev history, trusted-dev exception, buy-only alerts, early-exit guard (Oct 31 2026)

Paper only. No wallet, no keys, no real money. Her asks (WhatsApp, Oct 31, Lagos time): 9:23 AM voice note
("devs might hold a big chunk and not be ruggers ... check the dev wallet's history ... only alert me when it BUYS,
with all the details"), 9:25 AM ("cant we add it to the 14days test"), 9:26 + 9:29 AM (coordinated-exit early warning,
"must NOT sell on its own", ask with buttons).

## 1. alerts: only when the bot BUYS
- "dev crew loading" / "dev crew dumping" on coins the bot did NOT buy: **no Telegram message**. Still detected and
  logged (events + `🔕 crew moves on coins not held` in /insider and the report). `/alerts on|off` still works.
- A crew dumping a coin she **holds** (any lane) still sends ONE alert (per coin, max 6 an hour).
- Every buy (insider, trusted-dev, main desk, copy, hype) sends one **buy card**: coin, short mint, DexScreener link,
  lane, size, entry, liquidity, mcap, dev-crew % (insider/copy: linked wallets on-chain; desk/hype: rugcheck's
  linked/insider proxy), dev wallet %, dev history verdict + up to 3 evidence lines, the rules that passed, why it bought.
  Insider/copy cards keep the pack's R18 ENTRY record under the card.

## 2. dev history (`src/playbook/devhist.js`)
For the coin's dev (creator) wallet, the wallet that funded it, and up to 3 other fresh wallets that funder paid
("siblings": serial launchers use a new dev wallet per coin), find pump.fun launches in the last 45 days and judge each:
- **rug**: the launching wallet sold 80%+ of its bag within 6 h of launch (or the coin is dead and it sold), or the
  bot's own label said RUG (liquidity removed / -90% within 1 h).
- **survived**: still trading a day+ later with $10k+ liquidity and $30k+ market cap (DexScreener, free).
- **died**: no pool / under $2k liquidity a day later. **weak**: alive but small. **too new**: under 24 h old.
Verdict: **clean** = 2+ survivors, 0 rugs, survivors at least a third of the judged launches · **serial rugger** = 2+
rugs and at least half of the judged launches · **mixed** = anything else judged · **unknown** = no earlier launches
found (fresh wallet), all too new, or the history could not be read. Unknown is never treated as clean.
Limits, said plainly: evidence, not proof. Busy bot-like wallets (40+ txs a minute) are only read a few minutes back.
Holder growth is not measured (no free source). The funder's "siblings" may include buyer wallets, not only devs.

When it runs: only for a coin that already passed every other rule (to catch a serial rugger, and for the card), or a
trusted-dev candidate. Cached 6 h per dev wallet, max 60 lookups a day, max 7 Helius reads a lookup.
Cost: Helius getTransactionsForAddress = 10 credits per read. Measured on real coins Oct 31: 10-70 credits a lookup
(median ~20-40). At today's rate of candidates (a few a day) that is well under 1,000 credits a day; worst case
60 x 70 = 4,200, booked on the same 30,000/day ledger (non-priority, stops at the 80% soft cap).
On-demand check: `GET /admin/devhist?mint=&dev=&funder=&symbol=` (admin key).

## 3. trusted-dev exception (insider lane)
If the ONLY failures are the dev-crew cap (R5, 20%) and, when the crew is what makes the top 10 big, R4 (the top 10
**without** the crew must still be under 30%), AND the crew holds <= 60% (`/set trustedcap`), AND every other rule
passes (mint/freeze revoked, LP burned/locked, liquidity floor, sell simulation, second opinion, copycat, known
rugger, slippage + fee caps), the dev history is read. **clean** -> paper buy at **quarter size**. Anything else ->
the normal R5 skip, with the verdict in the skip note.
These trades are **in the 14-day test** (her 9:25 AM word): strategy `insider`, main book, main numbers, tagged
`trusted_dev: true`, shown as a sub-line in the report ("of which trusted-dev exception"). Logged
`TRUSTED-DEV EXCEPTION`. `/set trusteddev off` turns it off.

**Serial rugger skip (main-lane change, small):** a coin whose dev history is `serial_rugger` is skipped (code DH)
even when the crew is under 20%. Same on the main desk, copy and hype lanes. It only removes buys.
`/set skiprugger off` turns it off.

## 4. early-exit guard (`src/playbook/guard.js`)
On every open position it watches for a coordinated exit and **asks her**: one Telegram alert with the evidence and
`[🔴 Sell now] [🟢 Hold]`. It sells only when she taps Sell (paper fill at that moment). No answer = hold.
Signals (patterns, not proof), from the 1-second reads the insider/copy monitor already makes (no extra Helius calls):
- G1: 2+ different linked wallets sell inside 60 s
- G2: the crew's share falls 2+ points inside 120 s
- G3: crew wallets move tokens to brand-new wallets (pre-dump shuffle)
- G5: the pool's SOL side falls 15%+ inside 60 s (big sells)
- main desk positions (no crew list there): pool liquidity -15% inside 2 min (read every 10 s)
- LP pulled / authority set again = E2, which already sells at once.
Unchanged and still automatic: E1-E8 (kill switch, LP pulled, deployer sells, crew sold 20%+, crew share -15% in
60 s, trailing stop, take profit, max hold) and the desk's stop / trail / 40% liquidity emergency exit.
Per trade it records the first signal, what an instant sell then would have returned, her choice, the lead time to the
big dump (crew -10 points, price -30%, or a pack exit firing) and the actual result. The report shows
"🛡 early-exit guard: N trades warned · you sold on N · median lead Ns · instant-sell minus actual $X".
`/set guard off` turns it off.

Replay on today's two crew dumps (coins the bot skipped; token-account histories read from Helius, 360 credits; each
account's history is cut after 300 txs because of incoming dust spam, so later sells are missing):
- $Rockstar: crew 87.8% at the bot's decision 08:05:43 UTC. The 4 selling crew wallets sold one at a time, about 5 min
  apart (08:14:21, 08:19:22, 08:24:06, 08:30:06). G2 would fire at 08:14:30, 145 s before the old dump alert (08:16:55)
  and ~10 min before the crew was 10 points down (08:24:23).
- $Grok: crew 87.9% at 07:51:17. Sellers at 07:58:41, 08:02:59, 08:06:36, 08:09:59, 08:15:10. G2 at 07:58:46, 81 s
  before the old dump alert (08:00:07), ~11 min before -10 points (08:10:00).
- G1 (2 wallets inside 60 s) would NOT have fired on either: these crews stagger their sells. E4 (20% of the crew bag)
  was not reached inside the data read. Price at those moments was not replayed.
