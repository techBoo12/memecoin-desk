// ============================================================================
// LIVE DASHBOARD (read-only, public)
// Job: one page anyone can open: balance over time, every paper trade with
//      why it was bought and why it was sold, open trades, the near-miss list
//      with what each coin did after, scan stats, and the 24h test countdown.
// HARD STOP: read-only. No controls, no secrets, no chat ids, nothing that
//            can change the desk. The data comes from dashData() below, which
//            copies only public fields.
// ============================================================================
import { equity, riskStatus } from '../desk/risk.js';
import { windowStats } from '../desk/report.js';
import { summarize, outcome } from '../desk/nearmiss.js';

const r2 = (x, d = 2) => (x == null || !Number.isFinite(+x) ? null : +(+x).toFixed(d));

export function dashData(S, config, health) {
  const st = S.desk, run = S.run || {}, t = st.test || null;
  const since = t?.startedAt || 0;
  const w = windowStats(st, since);
  const all = windowStats(st, 0);
  const nm = summarize(S.nm || { items: [], archived: { byReason: {} } }, { since });
  const trade = (x) => ({
    id: x.id, symbol: x.symbol, url: x.url, entryAt: x.entryAt, exitAt: x.exitAt, entry: x.entryPrice, exit: x.exitPrice,
    size: r2(x.sizeUsd), pnl: r2(x.pnlUsd), pnlPct: r2(x.pnlPct), R: r2(x.R), score: x.score, exitReason: x.exitReason, manual: x.source === 'manual',
    inTest: Date.parse(x.entryAt) >= since,
    whyIn: x.why ? { score: x.why.score, parts: x.why.parts, quality: x.why.quality, buys: x.why.buys, holders: x.why.holders, tape: x.why.tape, sellTest: x.why.sellTest } : null,
    exitInfo: x.exit ? { fillSource: x.exit.fillSource, slipVsStopPct: x.exit.slipVsStopPct, peakPct: x.exit.peakPct } : null,
  });
  return {
    at: Date.now(), mode: 'paper', live: health.live, lastTickAt: health.lastTickAt, exitsEverySec: config.loop.watchEverySec, scanEverySec: config.loop.scanEverySec,
    balance: r2(equity(st)), startBalance: st.startBalance, testStartBalance: r2(t?.equityAtStart), paused: Boolean(st.paused), frozen: riskStatus(st, config).frozen?.why || null,
    test: t ? { n: t.n, hours: t.hours, startedAt: t.startedAt, endsAt: t.endsAt } : null,
    stats: { trades: w.n, wins: w.wins, losses: w.losses, winRate: r2(w.winRate * 100, 0), pnl: r2(w.pnl), sumR: r2(w.sumR), expectancy: r2(w.expectancy),
      allTrades: all.n, allPnl: r2(all.pnl), allExpectancy: r2(all.expectancy) },
    desk: { scans: run.scans, coins: run.uniqueCoins, killed: run.killedCoins, passed: run.alive, approved: run.approved, vetoes: run.vetoes, nearMisses: run.nearMisses,
      killsByRule: run.killsByRule, qualityFails: run.qualityFails },
    rules: { minScore: config.analyst.passScore, maxTradesPerDay: config.quality.maxTradesPerDay, maxOpen: config.risk.maxOpenPositions, stopPct: config.risk.stopLossPct },
    curve: (S.curve || []).map((p) => [p.t, p.eq]),
    open: st.positions.map((p) => ({ id: p.id, symbol: p.symbol, url: p.url, entryAt: p.entryAt, entry: p.entryPrice, last: p.lastPrice, chgPct: r2(((p.lastPrice / p.entryPrice) - 1) * 100, 1),
      stop: p.stopPrice, trailing: p.trailing, size: r2(p.sizeUsd), mark: r2(p.markUsd), score: p.score, lastCheckAt: p.lastCheckAt, manual: p.source === 'manual',
      whyIn: p.why ? { score: p.why.score, quality: p.why.quality, buys: p.why.buys, holders: p.why.holders, tape: p.why.tape } : null })),
    trades: st.closed.slice(-30).reverse().map(trade),
    nearMisses: [...(S.nm?.items || [])].reverse().slice(0, 40).map((it) => {
      const o = outcome(it);
      return { id: it.id, at: it.at, symbol: it.symbol, url: it.url, reason: it.reasonKey, detail: (it.reasons || []).map((r) => r.note).join('; ').slice(0, 160), score: it.score, looks: it.looks,
        checks: Object.fromEntries(['15m', '1h', '4h', '24h'].map((k) => [k, it.checks[k] ? (it.checks[k].dead ? 'dead' : it.checks[k].chgPct) : null])), outcome: o.label };
    }),
    nearMissTotals: nm.totals, nearMissVerdicts: nm.verdicts,
    nearMissByReason: Object.fromEntries(Object.entries(nm.byReason).map(([k, b]) => [k, { n: b.n, pumped: b.pumped, dumped: b.dumped, flat: b.flat, pending: b.pending }])),
    feed: (S.events || []).slice(-14).reverse(),
  };
}

export function dashPage() {
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>memecoin desk · live paper trading</title>
<meta property="og:title" content="memecoin desk · live"><meta property="og:description" content="a solana memecoin desk trading fake money 24/7. every trade, every reason, every near miss.">
<meta name=theme-color content="#0a0c0f">
<style>
:root{--bg:#0a0c0f;--card:#12161b;--line:#1e242c;--fg:#e8edf2;--dim:#7d8896;--lime:#B8F04A;--red:#ff5d5d;--amber:#ffb547}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:22px 16px 60px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.brand{font-weight:800;letter-spacing:-.02em;font-size:20px}.brand b{color:var(--lime)}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:99px;padding:5px 11px;font-size:12px;color:var(--dim);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 0 rgba(184,240,74,.6);animation:p 1.8s infinite}.dot.off{background:var(--red);animation:none}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(184,240,74,.55)}70%{box-shadow:0 0 0 9px rgba(184,240,74,0)}100%{box-shadow:0 0 0 0 rgba(184,240,74,0)}}
.hero{margin:22px 0 6px}.lbl{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.bal{font-size:54px;font-weight:800;letter-spacing:-.04em;line-height:1.05;font-variant-numeric:tabular-nums}
.chg{font-weight:700;font-variant-numeric:tabular-nums}.g{color:var(--lime)}.r{color:var(--red)}.a{color:var(--amber)}.d{color:var(--dim)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.grid>div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px}
.grid .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
@media(max-width:560px){.grid{grid-template-columns:repeat(2,1fr)}.bal{font-size:46px}}
h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:26px 0 8px;font-weight:700}
.cd{font-variant-numeric:tabular-nums;font-weight:800;font-size:22px}.bar{height:6px;background:var(--line);border-radius:9px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:var(--lime)}
svg{display:block;width:100%;height:170px}
.row{padding:12px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.rh{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.sym{font-weight:800}
.why{color:var(--dim);font-size:13px;margin-top:4px}.tag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:7px;padding:1px 6px;margin:3px 4px 0 0;color:#b9c3cf}
.cps{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px}.cps span{font-size:12px;text-align:center;background:#0d1014;border:1px solid var(--line);border-radius:8px;padding:4px 0;font-variant-numeric:tabular-nums}
.feed{font:12px/1.6 ui-monospace,Menlo,monospace;color:#aeb8c4;white-space:pre-wrap;word-break:break-word}
a{color:inherit;text-decoration:none}.foot{color:var(--dim);font-size:12px;margin-top:30px;text-align:center}
.empty{color:var(--dim);font-size:14px}
</style></head><body><div class=wrap>
<div class=top><div class=brand>memecoin <b>desk</b></div><div class=pill><span class=dot id=dot></span><span id=live>connecting…</span></div></div>
<div class=hero><div class=lbl>paper balance · fake money</div><div class=bal id=bal>$—</div><div><span class=chg id=chg></span> <span class=d id=chgl></span></div></div>
<div class=card><div class=rh><div><div class=lbl id=testl>24h test</div><div class=cd id=cd>—</div></div><div class="d" style="text-align:right;font-size:13px" id=testd></div></div><div class=bar><i id=prog style="width:0"></i></div></div>
<div class=card style="padding:12px 8px 6px"><svg id=chart viewBox="0 0 700 170" preserveAspectRatio=none></svg></div>
<div class=grid>
<div><div class=lbl>trades</div><div class=v id=s_tr>0</div></div><div><div class=lbl>win rate</div><div class=v id=s_wr>—</div></div>
<div><div class=lbl>p/l</div><div class=v id=s_pl>$0</div></div><div><div class=lbl>expectancy</div><div class=v id=s_ex>—</div></div>
</div>
<h2>open trades</h2><div class=card id=open></div>
<h2>every trade + why</h2><div class=card id=trades></div>
<h2>near misses · coins it almost bought</h2><div class=card><div id=nmt class=d style="font-size:13px;margin-bottom:6px"></div><div id=nm></div></div>
<h2>the desk</h2><div class=grid id=desk></div>
<h2>live feed</h2><div class=card><div class=feed id=feed></div></div>
<div class=foot>paper trading only · no wallet, no keys · not financial advice<br>runs 24/7 on cloudflare's free plan · built by techBoo with Tab</div>
</div>
<script>
const $=(id)=>document.getElementById(id);const esc=(s)=>String(s??'').replace(/[<>&"]/g,(c)=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const money=(x)=>x==null?'—':(x<0?'-':'')+'$'+Math.abs(x).toFixed(2);const sg=(x,d=2)=>x==null?'—':(x>=0?'+':'')+(+x).toFixed(d);
const cls=(x)=>x==null?'d':x>0?'g':x<0?'r':'d';const ago=(t)=>{const s=Math.max(0,(Date.now()-t)/1000);return s<90?Math.round(s)+'s ago':s<5400?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'};
let D=null;
function chart(c,start){const s=$('chart');if(!c.length){s.innerHTML='';return}const pts=c.slice();if(pts.length===1)pts.push([Date.now(),pts[0][1]]);
const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]).concat(start!=null?[start]:[]);const x0=Math.min(...xs),x1=Math.max(...xs,x0+1);let y0=Math.min(...ys),y1=Math.max(...ys);const pad=Math.max((y1-y0)*.25,.15);y0-=pad;y1+=pad;
const X=t=>8+(t-x0)/(x1-x0)*684,Y=v=>160-(v-y0)/(y1-y0)*150;const d=pts.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+' '+Y(p[1]).toFixed(1)).join(' ');
const up=pts[pts.length-1][1]>=(start??pts[0][1]);const col=up?'#B8F04A':'#ff5d5d';
s.innerHTML='<defs><linearGradient id=gf x1=0 y1=0 x2=0 y2=1><stop offset=0 stop-color="'+col+'" stop-opacity=.28 /><stop offset=1 stop-color="'+col+'" stop-opacity=0 /></linearGradient></defs>'+
(start!=null?'<line x1=0 x2=700 y1="'+Y(start)+'" y2="'+Y(start)+'" stroke="#2a323c" stroke-dasharray="4 5" />':'')+
'<path d="'+d+' L'+X(pts[pts.length-1][0])+' 168 L'+X(pts[0][0])+' 168 Z" fill="url(#gf)"/><path d="'+d+'" fill=none stroke="'+col+'" stroke-width=2.6 stroke-linejoin=round vector-effect=non-scaling-stroke />'+
'<circle cx="'+X(pts[pts.length-1][0])+'" cy="'+Y(pts[pts.length-1][1])+'" r=4.5 fill="'+col+'"/>'}
function tick(){if(!D||!D.test)return;const left=D.test.endsAt-Date.now(),tot=D.test.endsAt-D.test.startedAt;
if(left<=0){$('cd').textContent='report sent';$('prog').style.width='100%';return}
const h=Math.floor(left/36e5),m=Math.floor(left%36e5/6e4),s=Math.floor(left%6e4/1e3);$('cd').textContent=h+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';
$('prog').style.width=(100*(1-left/tot)).toFixed(2)+'%'}
function render(){const d=D;$('bal').textContent=money(d.balance);const base=d.testStartBalance??d.startBalance;const ch=d.balance-base;
$('chg').className='chg '+cls(ch);$('chg').textContent=sg(ch)+' ('+sg(ch/base*100)+'%)';$('chgl').textContent=d.test?'since the test started':'';
$('dot').className='dot'+(d.live?'':' off');$('live').textContent=(d.live?'live':'offline')+' · checked '+(d.lastTickAt?ago(Date.parse(d.lastTickAt)):'—');
if(d.test){$('testl').textContent=d.test.hours+'h paper test'+(d.test.n>1?' #'+d.test.n:'')+' · report in';$('testd').innerHTML='rules: score '+d.rules.minScore+'+<br>max '+d.rules.maxTradesPerDay+' trades/day · '+d.rules.maxOpen+' open'}
chart(d.curve,base);const s=d.stats;$('s_tr').textContent=s.trades;$('s_wr').textContent=s.trades?s.winRate+'%':'—';$('s_pl').textContent=money(s.pnl);$('s_pl').className='v '+cls(s.pnl);$('s_ex').textContent=s.trades?sg(s.expectancy)+'R':'—';
$('open').innerHTML=d.open.length?d.open.map(p=>'<div class=row><div class=rh><a class=sym href="'+esc(p.url)+'" target=_blank>$'+esc(p.symbol)+'</a>'+(p.manual?' <span class=tag>manual</span>':'')+'<span class="chg '+cls(p.chgPct)+'">'+sg(p.chgPct,1)+'%</span></div><div class=why>'+money(p.size)+' in · stop '+(p.trailing?'trailing':'-'+d.rules.stopPct+'%')+' · checked '+(p.lastCheckAt?ago(p.lastCheckAt):'—')+(p.whyIn?'<br>why in: score '+p.whyIn.score+' · buys '+esc(p.whyIn.buys)+' · holders '+esc(p.whyIn.holders):'')+'</div></div>').join(''):'<div class=empty>nothing open. waiting for a coin that clears every rule.</div>';
$('trades').innerHTML=d.trades.length?d.trades.map(t=>'<div class=row><div class=rh><span><a class=sym href="'+esc(t.url)+'" target=_blank>$'+esc(t.symbol)+'</a> <span class=d style="font-size:12px">'+esc(t.id)+(t.inTest?'':' · before test')+(t.manual?' · manual':'')+'</span></span><span class="chg '+cls(t.pnl)+'">'+money(t.pnl)+' · '+sg(t.R)+'R</span></div>'+
'<div class=why>in: '+(t.whyIn?'score '+t.whyIn.score+' · '+esc(t.whyIn.buys)+' buys · holders '+esc(t.whyIn.holders)+' · '+esc(t.whyIn.tape):'score '+t.score+' (old rules)')+'<br>out: '+esc(t.exitReason)+(t.exitInfo?' · peak +'+t.exitInfo.peakPct+'%':'')+'</div></div>').join(''):'<div class=empty>no closed trades yet</div>';
const T=d.nearMissTotals;$('nmt').innerHTML=T.n+' tracked · <span class=g>📈 '+T.pumped+' pumped</span> · <span class=r>📉 '+T.dumped+' dumped</span> · ➖ '+T.flat+' flat · ⏳ '+T.pending+' waiting'+(d.nearMissVerdicts.length?'<br>'+d.nearMissVerdicts.map(esc).join('<br>'):'');
$('nm').innerHTML=d.nearMisses.length?d.nearMisses.map(n=>'<div class=row><div class=rh><a class=sym href="'+esc(n.url)+'" target=_blank>$'+esc(n.symbol)+'</a><span class=d style="font-size:12px">'+ago(n.at)+'</span></div><div class=why><span class=tag>'+esc(n.reason)+'</span>'+(n.score!=null?'<span class=tag>score '+n.score+'</span>':'')+'<br>'+esc(n.detail)+'</div><div class=cps>'+['15m','1h','4h','24h'].map(k=>{const v=n.checks[k];return '<span class="'+(v==='dead'?'r':v==null?'d':cls(v))+'">'+k+' '+(v==null?'⏳':v==='dead'?'dead':sg(v,0)+'%')+'</span>'}).join('')+'</div></div>').join(''):'<div class=empty>no near misses yet</div>';
const k=d.desk;$('desk').innerHTML=[['scans',k.scans],['coins seen',k.coins],['killed',k.killed],['passed 8/8',k.passed],['paper buys',k.approved],['said no',k.vetoes],['near misses',k.nearMisses],['exits every',d.exitsEverySec+'s']].map(x=>'<div><div class=lbl>'+x[0]+'</div><div class=v>'+(x[1]??0)+'</div></div>').join('');
$('feed').textContent=d.feed.join('\\n')}
async function load(){try{const r=await fetch('/api/dash',{cache:'no-store'});D=await r.json();render();tick()}catch(e){$('live').textContent='reconnecting…'}}
load();setInterval(load,15000);setInterval(tick,1000);
</script></body></html>`;
}
