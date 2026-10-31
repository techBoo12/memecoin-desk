// ============================================================================
// KNOWLEDGE BASE (training pack section 7, "knowledge base for RAG", the light version):
// every rule code the bot can log carries a one-line why + the pack source it comes from,
// so each skip / exit explains itself ("mint authority still live, see SPL Token docs").
// No language model here: a fixed, citable lookup that runs in 0 ms on the Worker.
// ============================================================================
export const KB = {
  R1: ['mint authority still live: the dev can print more supply', 'https://www.solana-program.com/docs/token'],
  R2: ['freeze authority live or a Token-2022 trap (transfer fee / hook / permanent delegate)', 'https://www.solana-program.com/docs/token-2022/extensions'],
  R2b: ['a second-opinion checker (GoPlus / RugCheck) flagged a hard risk', 'https://docs.gopluslabs.io/reference/solanatokensecurityusingget'],
  R3: ['LP not burned/locked: the dev can pull the pool', 'https://solana.stackexchange.com/questions/9750'],
  R4: ['top 10 wallets hold too much (pool + burn excluded)', 'https://api.rugcheck.xyz/swagger/index.html'],
  R5: ["the dev's wallet cluster holds too much of the supply", 'https://arxiv.org/abs/2602.13480'],
  R6: ['pool too thin', 'https://docs.dexscreener.com/api/reference'],
  R7: ["sell simulation failed or lost too much: can't get out", 'https://docs.honeypot.is/'],
  R11: ['entry quote needs more slippage than the cap: sandwich bait', 'https://developers.uniswap.org/docs/get-started/concepts/traders/swaps'],
  R13: ['network fee + Jito tip above the cap', 'https://docs.jito.wtf/lowlatencytxnsend/'],
  R14: ['outside the niche: only fresh pump.fun graduates', 'https://pump.fun/docs/bonding-curve'],
  R15: ['daily loss kill switch is on', 'https://www.freqtrade.io/en/stable/stoploss/'],
  R16: ['max open positions / already holding this token', 'https://en.wikipedia.org/wiki/Kelly_criterion'],
  M1: ['copycat: same ticker as a coin launched minutes ago', 'https://arxiv.org/abs/2609.10246'],
  M5: ['known rugger: this deployer (or its funder) rugged a coin we labelled before', 'https://arxiv.org/abs/2608.20271'],
  E1: ['daily loss kill switch', 'https://www.freqtrade.io/en/stable/stoploss/'],
  E2: ['liquidity removed / LP moved / mint or freeze authority set again', 'https://www.solana-program.com/docs/token'],
  E3: ['the deployer sold or moved tokens', 'https://bitquery.io/investigations/pump-fun-snipers-bundles'],
  E4: ['the cluster sold a big part of what it held at our entry', 'https://arxiv.org/abs/2609.10246'],
  E5: ["the cluster's share is falling fast", 'https://arxiv.org/abs/2609.10246'],
  E6: ['trailing stop', 'https://www.freqtrade.io/en/stable/stoploss/'],
  E7: ['take-profit rung', 'https://www.freqtrade.io/en/stable/stoploss/'],
  E8: ['max hold time', 'https://www.freqtrade.io/en/stable/stoploss/'],
  DATA: ['free data source failed, so the check is unknown and unknown = skip', 'https://docs.coingecko.com/'],
};
export const why = (code) => (KB[code] ? `${KB[code][0]} (source: ${KB[code][1]})` : code);
