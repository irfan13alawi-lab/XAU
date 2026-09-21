# Offline historical walk-forward replay

The research harness replays XAUUSD quotes through the same local `PaperWorker`, scan rules, risk checks, and paper-order lifecycle used by the dashboard. Every fold uses a fresh SQLite in-memory database. The harness has no broker adapter, network provider, credential access, or live-order route; `LIVE_TRADING_ENABLED` remains false.

This is a chronological expanding-history replay, not a model-training or parameter-optimization routine. The initial period warms indicators with entries paused; the later bars are split into sequential test folds. Positions still open at a fold boundary are reported as remaining exposure and excluded from closed-trade metrics. Intra-bar tick order is not invented: paper execution sees only the bid/ask observations supplied in the dataset.

## Input file contract

Use one UTF-8 JSON object with `schemaVersion: 1` and `symbol: "XAUUSD"`. Timestamps must be ISO-8601 strings containing `Z` or an explicit UTC offset. Arrays must be chronologically ordered as specified below.

```json
{
  "schemaVersion": 1,
  "symbol": "XAUUSD",
  "manifest": {
    "datasetId": "vendor-xau-2026q1-v1",
    "dataClass": "BROKER_HISTORICAL",
    "provider": "YourVendor",
    "retrievedAt": "2026-04-01T00:00:00.000Z",
    "sha256": "64-character-canonical-dataset-hash"
  },
  "quotes": [
    { "observedAt": "2026-01-05T00:15:00.000Z", "bid": 2640.10, "ask": 2640.30, "last": 2640.20, "source": "BROKER" }
  ],
  "candlesByTimeframe": {
    "H4": [{ "closedAt": "2026-01-05T00:00:00.000Z", "open": 2638.0, "high": 2642.0, "low": 2637.0, "close": 2640.0, "tickVolume": 100, "source": "BROKER", "quality": "VERIFIED_CLOSED" }],
    "H1": [],
    "M30": [],
    "M15": []
  },
  "newsSnapshots": [
    { "fetchedAt": "2026-01-05T00:15:00.000Z", "status": "HEALTHY", "events": [] }
  ],
  "account": { "equity": 10000, "currency": "USD" },
  "instrument": {
    "contractSize": 100, "tickSize": 0.01, "tickValue": 1,
    "tickValueCurrency": "USD", "minLot": 0.01, "lotStep": 0.01,
    "maxLot": 100
  },
  "paperCosts": {
    "slippagePrice": 0.1, "commissionPerLot": 2, "swapPerLotPerDay": 1,
    "fillLatencyMs": 250, "fillRatio": 1, "contractSize": 100,
    "quoteToAccountRate": 1, "lotStep": 0.01, "minimumLot": 0.01,
    "breakEvenOffsetPrice": 0.05, "accountCurrency": "USD"
  },
  "maxSpreadPrice": 1.0
}
```

The JSON above illustrates field names only; it is not a valid evaluation dataset. Supply at least 100 candles per timeframe and enough M15 history for the requested folds. The actual instrument contract, tick-value conversion, account currency/equity, spread threshold, and cost assumptions must come from the chosen provider/account specification. `paperCosts.contractSize`, `lotStep`, and `minimumLot` must agree with the instrument metadata. Quotes require strictly increasing `observedAt`, valid positive bid/ask, and `ask >= bid`; the dataset is limited to 50,000 quote observations and 100,000 candles per timeframe. Closed candles require strictly increasing `closedAt`, valid OHLC, and `closedAt` no later than the final quote. News snapshots must be chronologically ordered, fetched no later than the final quote, and include the status/events actually known at each fetch time; future event schedules are allowed, later-fetched calendar knowledge is not.

For broker history, quote rows use `source: "BROKER"`; candle rows use `source: "BROKER"` and `quality: "VERIFIED_CLOSED"`. The manifest provider is a display label only; do not put credentials or URLs with secrets in the dataset. Hash the canonical JSON content without relying on the `manifest.sha256` value, then place the printed hash in that field:

```powershell
npm run research-hash -- .\data\xau-history.json
```

This command only prints a hash; it does not modify the input file. Recompute it after every dataset edit.

## Run an evaluation

```powershell
npm run evaluate -- .\data\xau-history.json --fold-count 3 --training-fraction 0.70 --minimum-training-bars 100
```

Defaults are three sequential test folds, a 70% initial training/warm-up period, and at least 100 training M15 bars. Reports are written under `data/research-results/` using a deterministic run ID and exclusive-create semantics; existing files are never overwritten. Change the dataset or fold parameters for a new report.

Review `provenance.quoteCoverage.maximumObservedGapMs` and `gapsOver30Seconds`, each fold's `scanCoveragePct`, closed/open exposure, fill assumptions, sample count, and suppression reason. Incomplete M15 scan coverage suppresses aggregate metrics/cohorts. Decision and trade-detail arrays are capped at 2,000 artifacts per fold; total counts and truncation flags remain in the report. A large quote gap can make simulated fills and stop management unrealistic even if scan coverage is complete, so it requires human review. Performance metrics are hidden below 30 closed trades per fold. Synthetic data is rejected by the CLI and cannot produce performance metrics even in the explicitly test-only software path.

### Run from the local dashboard

Place a UTF-8 JSON file in `data/research-datasets/` and enter only its filename in the Trade Journal panel. The local API accepts a maximum 256 MiB dataset and only `datasetName` plus optional `foldCount`, `trainingFraction`, and `minimumTrainingBars` fields. The action requires the same-origin local operator token and an `Idempotency-Key`; reusing a key with different normalized options or a different dataset name returns `409`.

The dashboard calls `POST /api/actions/research` and displays per-fold scan coverage, sample counts, and metrics only where the evaluator permits them. The complete report is saved as `data/research-results/<runId>.json`; it is separate from the SQLite database backup and must be copied separately if it needs retention. No upload, network fetch, broker connection, or live order occurs. Missing, malformed, synthetic, or only owner-attested history is not represented as independently verified broker evidence.

For dashboard journal summaries and eligible cohorts, win rate includes a 95% Wilson score interval and expectancy in R includes an approximate two-sided 95% Student-t interval using a Cornish–Fisher critical-value approximation. Each interval requires at least 30 valid observations for that specific metric; the displayed `n` is the metric-specific sample count, which can be lower than the number of closed trades when values are missing. These are descriptive uncertainty intervals, not profitability evidence or forecasts. They assume independent trade observations and do not model serial dependence, selection bias, data authenticity, or future outcomes. The historical replay report itself continues to suppress performance metrics below its 30-closed-trade minimum.

## Interpretation and evidence limits

`BROKER_HISTORICAL` is an owner-provided classification, not an independent authenticity check. Reports say `OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED`; verify the vendor export, timestamps, symbol mapping, missing bars/ticks, account currency, contract specification, calendar history, and execution-cost assumptions before interpreting a replay. The report is not an investment recommendation, a profitability claim, or authorization to turn on live trading. Historical replay does not demonstrate future returns or broker fill behavior.

Run `npm test` to exercise chronological fold splitting, hash tamper rejection, news look-ahead rejection, the real local paper worker/lifecycle on an in-memory synthetic fixture, synthetic metric suppression, and scan coverage accounting.
