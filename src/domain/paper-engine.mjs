import { calculatePositionSize } from './risk.mjs';
import {
  analyzeTimeframe, buildEntryPlan, evaluateMtfGate, resolveStrategyParameters, TIMEFRAMES,
} from './strategy.mjs';
import { activeSessions } from './market-sessions.mjs';

export function evaluatePaperScan({
  market,
  candlesByTimeframe,
  newsState,
  riskState,
  account,
  instrument,
  paperCosts = null,
  config,
  entryPaused = true,
  paperMode = true,
  now = new Date(),
}) {
  const effectiveConfig = { ...(config ?? {}), strategyParameters: resolveStrategyParameters(config?.strategyParameters) };
  const analyses = TIMEFRAMES.map((timeframe) => analyzeTimeframe({
    candles: candlesByTimeframe?.[timeframe] ?? [],
    timeframe,
    source: market?.source,
    now,
    strategyParameters: effectiveConfig.strategyParameters,
  }));
  const long = analyses.filter((item) => item.fresh && item.direction === 'LONG').length;
  const short = analyses.filter((item) => item.fresh && item.direction === 'SHORT').length;
  const direction = long === short ? 'NEUTRAL' : long > short ? 'LONG' : 'SHORT';
  const m15 = analyses.find((item) => item.timeframe === 'M15');
  let plan = { allowed: false, plan: null, reasons: ['NO_DIRECTIONAL_SETUP'] };
  if (['LONG', 'SHORT'].includes(direction) && m15?.fresh && m15.indicators) {
    plan = buildEntryPlan({
      direction,
      quote: market?.quote,
      atr14: m15.indicators.atr14,
      support: m15.indicators.supportResistance.support,
      resistance: m15.indicators.supportResistance.resistance,
      ema21: m15.indicators.ema21,
      swingLow: m15.indicators.swingLow,
      swingHigh: m15.indicators.swingHigh,
      instrument,
      strategyParameters: effectiveConfig.strategyParameters,
    });
  }

  let sizing = { allowed: false, reasons: ['RISK_STATE_UNKNOWN'], lots: null };
  if (riskState?.freshness && riskState.freshness !== 'FRESH') {
    sizing = {
      allowed: false,
      reasons: [riskState.reason ?? (riskState.freshness === 'STALE' ? 'RISK_STATE_STALE' : 'RISK_STATE_UNAVAILABLE')],
      lots: null,
      riskAmount: null,
      riskPct: null,
    };
  } else if (riskState && account && plan.plan) {
    sizing = calculatePositionSize({
      equity: account.equity,
      riskPct: effectiveConfig.riskPerTradePct,
      entryPrice: plan.plan.entry,
      stopPrice: plan.plan.stop,
      side: direction,
      accountCurrency: account.currency,
      contract: instrument,
      dailyLossR: riskState.dailyLossR,
      drawdownPct: riskState.drawdownPct,
      openRiskPct: riskState.openRiskPct,
      limits: effectiveConfig,
    });
  }

  const risk = {
    allowed: sizing.allowed && !entryPaused && paperMode,
    reasons: [
      ...sizing.reasons,
      ...(entryPaused ? ['ENTRY_PAUSED'] : []),
      ...(!paperMode ? ['PAPER_MODE_DISABLED'] : []),
    ],
    sizing,
  };
  const gate = evaluateMtfGate({
    analyses,
    quote: market?.quote ? { ...market.quote, source: market.source, dataFreshness: market.dataFreshness } : null,
    news: newsState,
    risk,
    plan,
    config: effectiveConfig,
  });
  return {
    status: gate.status,
    accepted: gate.accepted,
    symbol: 'XAUUSD',
    direction: gate.direction,
    score: gate.score,
    confluencePct: gate.confluencePct,
    reasons: gate.reasons,
    analyses,
    gate,
    plan: gate.accepted ? plan.plan : null,
    sizing: gate.accepted ? sizing : null,
    snapshots: {
      market: market ?? null,
      risk: riskState ?? null,
      news: newsState ?? null,
      account: account ? { equity: account.equity, currency: account.currency } : null,
      instrument: instrument ?? null,
      paperCosts,
      config: effectiveConfig,
      configVersion: effectiveConfig.version ?? null,
      decision: {
        capturedAt: now.toISOString(),
        direction: gate.direction,
        score: gate.score,
        confluencePct: gate.confluencePct,
        alignedTimeframes: gate.alignedTimeframes,
        weights: gate.weights,
        gate,
        analyses,
        session: activeSessions(now),
      },
    },
    maxCandidates: 1,
  };
}
