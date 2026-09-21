const number = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const positive = (value) => number(value) && Number(value) > 0;
const round = (value, places = 8) => Number(Number(value).toFixed(places));

export function evaluateRiskGuard({ dailyLossR, drawdownPct, openRiskPct, proposedRiskPct = 0, limits }) {
  const reasons = [];
  const warnings = [];
  if (!limits || !positive(limits.dailyLossLimitR) || !positive(limits.drawdownPausePct) || !positive(limits.maxTotalOpenRiskPct)) {
    reasons.push('RISK_LIMITS_UNCONFIGURED');
  }
  if (!number(dailyLossR) || !number(drawdownPct) || !number(openRiskPct)) {
    reasons.push('RISK_STATE_UNKNOWN');
  } else if (limits) {
    if (Number(dailyLossR) >= Number(limits.dailyLossLimitR)) reasons.push('DAILY_LOSS_LIMIT');
    if (Number(drawdownPct) >= Number(limits.emergencyStopPct ?? Number.POSITIVE_INFINITY)) reasons.push('EMERGENCY_STOP');
    else if (Number(drawdownPct) >= Number(limits.drawdownPausePct)) reasons.push('DRAWDOWN_PAUSE');
    else if (Number(drawdownPct) >= Number(limits.drawdownWarningPct ?? Number.POSITIVE_INFINITY)) warnings.push('DRAWDOWN_WARNING');
    if (Number(openRiskPct) + Number(proposedRiskPct) > Number(limits.maxTotalOpenRiskPct) + 1e-10) reasons.push('TOTAL_OPEN_RISK_LIMIT');
  }
  return { allowed: reasons.length === 0, reasons, warnings };
}

export function calculatePositionSize({
  equity,
  riskPct,
  entryPrice,
  stopPrice,
  side,
  accountCurrency,
  contract,
  dailyLossR,
  drawdownPct,
  openRiskPct = 0,
  limits,
}) {
  const reasons = [];
  if (!positive(equity)) reasons.push('EQUITY_UNAVAILABLE');
  if (!positive(riskPct)) reasons.push('RISK_PERCENT_INVALID');
  if (!positive(entryPrice) || !positive(stopPrice) || entryPrice === stopPrice) reasons.push('ENTRY_OR_STOP_INVALID');
  if (!['LONG', 'SHORT'].includes(side)) reasons.push('SIDE_INVALID');
  if (!contract || !positive(contract.contractSize) || !positive(contract.tickSize) || !positive(contract.tickValue)
    || !positive(contract.minLot) || !positive(contract.lotStep) || !positive(contract.maxLot)) {
    reasons.push('CONTRACT_METADATA_INCOMPLETE');
  }
  if (!accountCurrency || !contract?.tickValueCurrency) reasons.push('CURRENCY_METADATA_MISSING');
  if (reasons.length) return { allowed: false, reasons, lots: null, riskAmount: null, riskPct: null };

  const priceDistance = Math.abs(Number(entryPrice) - Number(stopPrice));
  const tickCount = priceDistance / Number(contract.tickSize);
  let conversionRate = 1;
  if (String(accountCurrency).toUpperCase() !== String(contract.tickValueCurrency).toUpperCase()) {
    if (!positive(contract.tickValueConversionRate)) return { allowed: false, reasons: ['TICK_VALUE_CONVERSION_UNAVAILABLE'], lots: null, riskAmount: null, riskPct: null };
    conversionRate = Number(contract.tickValueConversionRate);
  }
  const lossPerLot = tickCount * Number(contract.tickValue) * conversionRate;
  if (!positive(lossPerLot)) return { allowed: false, reasons: ['LOSS_PER_LOT_INVALID'], lots: null, riskAmount: null, riskPct: null };

  const riskBudget = Number(equity) * Number(riskPct) / 100;
  const rawLots = riskBudget / lossPerLot;
  const steppedLots = Math.floor((rawLots + 1e-12) / Number(contract.lotStep)) * Number(contract.lotStep);
  const lots = round(Math.min(steppedLots, Number(contract.maxLot)));
  if (lots < Number(contract.minLot)) return { allowed: false, reasons: ['BELOW_MINIMUM_LOT'], lots: null, riskAmount: null, riskPct: null, lossPerLot };

  const riskAmount = round(lots * lossPerLot, 2);
  const actualRiskPct = round(riskAmount / Number(equity) * 100, 6);
  const guard = evaluateRiskGuard({
    dailyLossR,
    drawdownPct,
    openRiskPct,
    proposedRiskPct: actualRiskPct,
    limits,
  });
  if (!guard.allowed) return { allowed: false, reasons: guard.reasons, lots: null, riskAmount, riskPct: actualRiskPct, lossPerLot };
  return {
    allowed: true,
    reasons: [],
    warnings: guard.warnings,
    lots,
    riskAmount,
    riskPct: actualRiskPct,
    riskBudget,
    lossPerLot,
    stopDistance: priceDistance,
    contractSize: Number(contract.contractSize),
  };
}
