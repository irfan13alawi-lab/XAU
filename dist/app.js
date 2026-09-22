(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const toast = $('#toast');
  const toastText = $('#toastText');
  const API_REQUEST_TIMEOUT_MS = 8_000;
  let toastTimer;
  let refreshInFlight = false;
  let dashboardState = null;
  let selectedTimeframe = 'M15';
  let candleRequestId = 0;
  let operatorToken = '';

  function showToast(message) {
    if (!toast || !toastText) return;
    toastText.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setText(selector, value, root = document) {
    const element = typeof selector === 'string' ? $(selector, root) : selector;
    if (element) element.textContent = value == null || value === '' ? '—' : String(value);
  }

  function money(value, currency = 'USD') {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value));
  }

  function price(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 }).format(Number(value));
  }

  function percent(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return `${Number(value).toFixed(2)}%`;
  }

  function timeOf(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false, timeZoneName: 'short' });
  }

  function timestampOf(value) {
    if (!value) return 'timestamp unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'timestamp unavailable' : date.toLocaleString('en-GB', {
      timeZone: 'UTC', year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    });
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (operatorToken && (path === '/api/dashboard' || path.startsWith('/api/actions/'))) {
      headers.set('Authorization', `Bearer ${operatorToken}`);
    }
    if (options.method && options.method !== 'GET') {
      headers.set('Content-Type', 'application/json');
      if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', crypto.randomUUID());
    }
    const callerSignal = options.signal;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort(callerSignal.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const response = await fetch(path, { ...options, headers, cache: 'no-store', signal: controller.signal });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        body = { error: 'Invalid service response.' };
      }
      return { response, body };
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error('Local API request timed out after ' + (API_REQUEST_TIMEOUT_MS / 1000) + 's.');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  function renderOffline(message = 'Local service unavailable') {
    setText('#apiStatusLabel', 'API OFFLINE');
    setText('#sidebarStatus', message);
    setText('#botState', 'BROKER OFFLINE');
    setText('#engineCoreState', 'BLOCKED');
    setText('#workerState', 'Service unavailable');
    setText('#workerLatency', 'Telemetry unavailable');
    setText('#workerTrend', 'Current API data unavailable');
    setText('#brokerHealth', 'OFFLINE');
    setText('#newsHealth', 'UNKNOWN · ENTRY BLOCKED');
    setText('#safetyMessage', 'The local service is unavailable. No market quote or trading action is assumed.');
    if ($('#pauseButton')) $('#pauseButton').disabled = true;
    setText('#scanStatus', 'No verified data · scan held');
    setText('#gateResult', 'ENTRY BLOCKED');
    setText('#gateReason', 'Local API unavailable');
    setText('#dataGate', 'Data unavailable');
    setText('#newsGate', 'News unknown');
    setText('#riskGate', 'Entry held');
    setText('[data-market="freshness"]', 'UNAVAILABLE');
    for (const selector of ['#pauseButton', '#scanButton', '#paperModeButton', '#operatorToken', '#operatorAuthButton', '#researchButton', '#researchDatasetName', '.close-paper-button']) {
      const control = $(selector);
      if (control) control.disabled = true;
    }
    $('#apiStatusDot')?.classList.remove('green');
    $('#apiStatusDot')?.classList.add('amber');
    $('#sidebarStatusDot')?.classList.remove('green');
    $('#sidebarStatusDot')?.classList.add('amber');
  }

  function renderMarket(market) {
    setText('[data-market="last"]', price(market?.quote?.last));
    setText('[data-market="bid"]', price(market?.quote?.bid));
    setText('[data-market="ask"]', price(market?.quote?.ask));
    const bid = Number(market?.quote?.bid);
    const ask = Number(market?.quote?.ask);
    const spreadPrice = market?.spreadPrice ?? (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid ? ask - bid : null);
    const spreadPoints = market?.spreadPoints;
    setText('[data-market="spread"]', spreadPrice == null ? '—' : `${price(spreadPrice)} USD${spreadPoints == null ? '' : ` · ${Number(spreadPoints).toFixed(1)} pts`}`);
    setText('[data-market="change"]', market?.quote ? 'Change unavailable' : 'No verified quote');
    setText('[data-market="freshness"]', market?.dataFreshness ?? 'UNAVAILABLE');
    setText('#marketSource', `${market?.source ?? 'none'} · ${market?.reason ?? 'No verified feed'}`);
    setText('#marketBadge', market?.status === 'BROKER' ? 'BROKER DATA' : market?.status ?? 'NO FEED');
    setText('#candleTimestamp', market?.lastClosedCandleAt ? `Closed ${timeOf(market.lastClosedCandleAt)}` : 'No closed candle received');
    setText('#chartEmpty', market?.quote ? 'Quote received · waiting for verified closed candles.' : 'Connect a verified market-data feed to display candles.');
    setText('#marketSession', market?.session?.active?.length ? market.session.active.join(' + ')
      : market?.session?.marketScheduleStatus === 'WEEKEND_CLOSED' ? 'WEEKEND CLOSED' : market?.session ? 'NO ACTIVE SESSION' : 'UNAVAILABLE');
  }

  function svgNode(tag, attributes = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function renderCandles(payload) {
    const svg = $('#priceChart');
    const area = $('#chartArea');
    const empty = $('#chartEmpty');
    const yLabels = $('#chartYLabels');
    const xLabels = $('#chartXLabels');
    if (!svg || !area || !empty || !yLabels || !xLabels) return;
    svg.replaceChildren();
    const candles = Array.isArray(payload?.candles) ? payload.candles.filter((item) =>
      [item.open, item.high, item.low, item.close].every((value) => Number.isFinite(Number(value)))
      && Number(item.low) <= Math.min(Number(item.open), Number(item.close))
      && Number(item.high) >= Math.max(Number(item.open), Number(item.close))
      && Number(item.high) >= Number(item.low)
      && Number.isFinite(Date.parse(item.closedAt))) : [];
    setText('#marketAtr', payload?.indicators?.atr14 == null ? 'UNAVAILABLE' : price(payload.indicators.atr14));
    setText('#marketDayRange', payload?.utcDayRange ? `${price(payload.utcDayRange.high)} / ${price(payload.utcDayRange.low)} UTC` : 'UNAVAILABLE');
    const lastCandle = candles.at(-1);
    const volumeRatio = payload?.tickVolumeRatio?.status === 'AVAILABLE' && Number.isFinite(Number(payload.tickVolumeRatio.value))
      ? `${Number(payload.tickVolumeRatio.value).toFixed(2)}×` : 'ratio unavailable';
    setText('#marketVolume', lastCandle?.tickVolume == null ? `UNAVAILABLE · ${volumeRatio}` : `${Number(lastCandle.tickVolume).toLocaleString('en-US')} · ${volumeRatio}`);
    setText('#volatilityBucket', payload?.volatility?.bucket ?? 'UNAVAILABLE');
    setText('#candleCount', `${payload?.candleCount ?? 0} / ${payload?.requiredCandles ?? 100}`);
    setText('#candleTimestamp', payload?.lastClosedAt ? `${selectedTimeframe} closed ${timeOf(payload.lastClosedAt)} · ${payload.source}` : 'No verified closed candle received');
    setText('[data-market="freshness"]', payload?.dataFreshness ?? 'UNAVAILABLE');
    if (!candles.length) {
      svg.hidden = true;
      yLabels.hidden = true;
      xLabels.hidden = true;
      area.classList.add('chart-empty-area');
      empty.hidden = false;
      setText('#chartEmpty', `No verified ${selectedTimeframe} broker candles · ${payload?.reason ?? 'feed unavailable'}`);
      return;
    }

    const width = 860;
    const plot = { left: 16, right: 842, top: 14, bottom: 266 };
    const extrema = candles.flatMap((item) => [Number(item.high), Number(item.low)]);
    const minimum = Math.min(...extrema);
    const maximum = Math.max(...extrema);
    const rawRange = maximum - minimum || Math.max(Math.abs(maximum) * 0.001, 1);
    const upper = maximum + rawRange * 0.06;
    const lower = minimum - rawRange * 0.06;
    const y = (value) => plot.top + (upper - Number(value)) / (upper - lower) * (plot.bottom - plot.top);
    const step = (plot.right - plot.left) / candles.length;
    const barWidth = Math.max(1.2, Math.min(8, step * 0.58));
    const grid = svgNode('g', { class: 'chart-grid' });
    const labels = [];
    for (let index = 0; index <= 4; index += 1) {
      const value = upper - (upper - lower) * index / 4;
      const lineY = plot.top + (plot.bottom - plot.top) * index / 4;
      grid.append(svgNode('path', { d: `M${plot.left} ${lineY}H${plot.right}` }));
      labels.push(price(value));
    }
    for (let index = 0; index <= 6; index += 1) {
      const lineX = plot.left + (plot.right - plot.left) * index / 6;
      grid.append(svgNode('path', { d: `M${lineX} ${plot.top}V${plot.bottom}` }));
    }
    svg.append(grid);

    const candleLayer = svgNode('g', { class: 'candle-layer' });
    candles.forEach((item, index) => {
      const x = plot.left + step * (index + 0.5);
      const openY = y(item.open);
      const closeY = y(item.close);
      const rising = Number(item.close) >= Number(item.open);
      const directionClass = rising ? 'candle-up' : 'candle-down';
      candleLayer.append(svgNode('line', { x1: x, x2: x, y1: y(item.high), y2: y(item.low), class: directionClass }));
      candleLayer.append(svgNode('rect', {
        x: x - barWidth / 2, y: Math.min(openY, closeY), width: barWidth,
        height: Math.max(1, Math.abs(closeY - openY)), class: directionClass,
      }));
    });
    svg.append(candleLayer);

    const addOverlay = (series, className) => {
      if (!Array.isArray(series)) return;
      let path = '';
      let drawing = false;
      series.forEach((value, index) => {
        if (value == null || value === '' || !Number.isFinite(Number(value))) { drawing = false; return; }
        const x = plot.left + step * (index + 0.5);
        path += `${drawing ? 'L' : 'M'}${x.toFixed(2)} ${y(value).toFixed(2)} `;
        drawing = true;
      });
      if (path) svg.append(svgNode('path', { d: path.trim(), class: className }));
    };
    addOverlay(payload.ema9Series, 'ema-fast');
    addOverlay(payload.ema21Series, 'ema-slow');

    const last = candles.at(-1);
    const lastY = y(last.close);
    svg.append(svgNode('line', { x1: plot.left, x2: plot.right, y1: lastY, y2: lastY, class: 'price-line' }));
    svg.append(svgNode('circle', { cx: plot.right - 4, cy: lastY, r: 3.5, class: 'price-dot' }));
    const tagY = Math.max(plot.top, Math.min(plot.bottom - 22, lastY - 11));
    svg.append(svgNode('rect', { x: width - 75, y: tagY, rx: 4, width: 72, height: 22, class: 'price-tag-bg' }));
    const priceTag = svgNode('text', { x: width - 69, y: tagY + 15, class: 'price-tag' });
    priceTag.textContent = price(last.close);
    svg.append(priceTag);

    yLabels.replaceChildren(...labels.map((value) => makeElement('span', '', value)));
    const dateLabels = [candles[0], candles[Math.floor((candles.length - 1) / 2)], last]
      .map((item) => makeElement('span', '', new Date(item.closedAt).toLocaleString('en-GB', { timeZone: 'UTC', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
    xLabels.replaceChildren(...dateLabels);
    svg.setAttribute('aria-label', `Verified closed ${selectedTimeframe} XAUUSD broker candles, latest close ${price(last.close)} at ${last.closedAt}`);
    svg.hidden = false;
    yLabels.hidden = false;
    xLabels.hidden = false;
    empty.hidden = true;
    area.classList.remove('chart-empty-area');
    setText('#chartEmpty', payload.sufficientHistory ? '' : `Chart only · ${candles.length} verified candles; analysis requires ${payload.requiredCandles ?? 100}.`);
  }

  async function loadCandles() {
    const requestId = ++candleRequestId;
    try {
      const { response, body } = await request(`/api/market/candles?timeframe=${encodeURIComponent(selectedTimeframe)}`);
      if (requestId !== candleRequestId) return;
      if (!response.ok) throw new Error(body.error ?? 'Candle history unavailable.');
      renderCandles(body);
    } catch {
      if (requestId === candleRequestId) renderCandles(null);
    }
  }

  function renderMtf(snapshot, dashboard) {
    const analyses = new Map((snapshot?.analyses ?? []).map((item) => [item.timeframe, item]));
    const order = ['H4', 'H1', 'M30', 'M15'];
    const readyCount = order.filter((timeframe) => {
      const item = analyses.get(timeframe);
      return item && item.direction !== 'UNAVAILABLE' && !item.rejectionReasons?.length;
    }).length;
    $$('.timeframe-row').forEach((row) => {
      const timeframe = $('.tf-name', row)?.textContent?.trim();
      const item = analyses.get(timeframe);
      const direction = item?.direction ?? 'UNAVAILABLE';
      const directionNode = $('.tf-direction', row);
      if (directionNode) {
        directionNode.textContent = direction;
        directionNode.classList.remove('long', 'short', 'neutral');
        directionNode.classList.add(direction === 'LONG' ? 'long' : direction === 'SHORT' ? 'short' : 'neutral');
      }
      const strength = Number(item?.strength);
      const normalizedStrength = Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) : 0;
      const bar = $('.tf-track span', row);
      if (bar) bar.style.width = `${normalizedStrength}%`;
      setText('.tf-score', Number.isFinite(strength) ? `${Math.round(strength)}%` : '—', row);
      const votes = item?.votes ?? [];
      const voteSummary = `${votes.filter((vote) => vote.direction === 'LONG').length}L/${votes.filter((vote) => vote.direction === 'SHORT').length}S`;
      const reason = item?.rejectionReasons?.[0] ?? (votes.length ? `${voteSummary} · ${timeOf(item.candleClosedAt)}` : 'Data unavailable');
      setText('.tf-reason', reason, row);
      setText('.wait', item && !item.rejectionReasons?.length ? '✓' : '!', row);
    });

    const signal = snapshot?.signal;
    const direction = signal?.direction ?? snapshot?.decision?.direction ?? 'NEUTRAL';
    setText('#gateDirection', direction === 'NEUTRAL' ? 'NO BIAS' : direction);
    setText('.direction-arrow', direction === 'LONG' ? '↑' : direction === 'SHORT' ? '↓' : '—');
    setText('#gateCount', `${readyCount} of 4 timeframes available`);
    const score = signal?.score ?? snapshot?.decision?.score;
    setText('#confluenceScore', score != null && Number.isFinite(Number(score)) ? `${Number(score).toFixed(0)}/100` : '—/100');
    const confluencePct = snapshot?.decision?.confluencePct;
    setText('#confluencePct', confluencePct != null && Number.isFinite(Number(confluencePct)) ? `${Number(confluencePct).toFixed(0)}% aligned` : '—% aligned');
    const scanStatus = snapshot?.status ?? 'UNAVAILABLE';
    setText('#gateResult', scanStatus === 'UNAVAILABLE' ? 'ENTRY BLOCKED' : scanStatus.replaceAll('_', ' '));
    const gateDot = $('#gateDot');
    gateDot?.classList.toggle('green', scanStatus === 'ORDER_STAGED');
    gateDot?.classList.toggle('amber', scanStatus !== 'ORDER_STAGED');
    setText('#gateReason', (snapshot?.scan?.reasons ?? snapshot?.decision?.gate?.reasons ?? []).join(' · ') || (scanStatus === 'UNAVAILABLE' ? 'No scan has been recorded' : 'No rejection reason recorded'));
    const market = dashboard?.market ?? {};
    setText('#dataGate', `${market.dataFreshness ?? 'UNAVAILABLE'} · ${market.candleQuality ?? 'NO CANDLE'}`);
    const news = dashboard?.news ?? {};
    setText('#newsGate', news.status === 'HEALTHY' ? `NEWS ${news.status}` : `NEWS ${news.status ?? 'UNKNOWN'} · ENTRY BLOCKED`);
    setText('#riskGate', snapshot?.riskDecision?.allowed ? 'RISK GUARD CLEAR' : `RISK HELD · ${(snapshot?.riskDecision?.reasons ?? []).slice(0, 2).join(', ') || 'unknown'}`);
    setText('#newsHealth', news.status === 'HEALTHY' ? 'HEALTHY' : `${news.status ?? 'UNKNOWN'} · ENTRY BLOCKED`);
    renderSignalSnapshot(snapshot);
  }

  function renderSignalSnapshot(snapshot) {
    const container = $('#signalCards');
    if (!container) return;
    container.replaceChildren();
    if (!snapshot?.scan) {
      container.append(makeElement('div', 'empty-state', 'No scan recorded. A scan is never inferred from UI refresh.'));
      return;
    }
    const signal = snapshot.signal;
    const card = makeElement('article', `panel signal-card${signal ? ' selected' : ''}`);
    const top = makeElement('div', 'signal-card-top');
    top.append(makeElement('span', 'signal-index', `SCAN · ${snapshot.scan.id}`));
    top.append(makeElement('span', 'status-pill gray-pill', snapshot.status));
    const title = makeElement('h3', '', signal ? `${signal.direction} · ${snapshot.status}` : `No order · ${snapshot.status}`);
    const timestamp = makeElement('p', 'signal-card-foot', `Completed ${timeOf(snapshot.scan.completedAt)} · ${snapshot.scan.configVersion}`);
    const details = makeElement('div', 'signal-tags');
    if (signal) {
      details.append(makeElement('span', '', `ENTRY ${price(signal.entry)}`));
      details.append(makeElement('span', '', `SL ${price(signal.stop)}`));
      details.append(makeElement('span', '', `TP1 ${price(signal.takeProfit1)}`));
      details.append(makeElement('span', '', `TP2 ${price(signal.takeProfit2)}`));
      details.append(makeElement('span', '', `SCORE ${Number(signal.score).toFixed(0)}`));
    }
    for (const reason of snapshot.scan.reasons ?? []) details.append(makeElement('span', '', String(reason).replaceAll('_', ' ')));
    card.append(top, title, timestamp, details);
    container.append(card);
  }

  function renderPositions(positions = [], orders = [], operatorAuthenticated = false, quoteFresh = false) {
    const tbody = $('#positionRows');
    if (!tbody) return;
    tbody.replaceChildren();
    const records = [
      ...positions.map((item) => ({ ...item, recordType: 'POSITION' })),
      ...orders.map((item) => ({ ...item, recordType: 'ORDER' })),
    ];
    if (!records.length) {
      const row = document.createElement('tr');
      const cell = makeElement('td', 'empty-table', 'No persisted paper positions or pending orders.');
      cell.colSpan = 7;
      row.append(cell);
      tbody.append(row);
      return;
    }
    for (const item of records) {
      const row = document.createElement('tr');
      const instrument = document.createElement('td');
      const identity = makeElement('div', 'symbol-cell');
      identity.append(makeElement('span', 'mini-gold', 'Au'));
      const symbol = makeElement('div');
      symbol.append(makeElement('strong', '', item.symbol ?? 'XAUUSD'));
      symbol.append(makeElement('small', '', `${item.recordType === 'ORDER' ? 'Pending' : 'Paper'} · ${item.id ?? '—'}`));
      identity.append(symbol);
      instrument.append(identity);
      row.append(instrument);

      const side = document.createElement('td');
      side.append(makeElement('span', `side-badge ${item.side === 'LONG' || item.side === 'BUY' ? 'long' : 'pending'}`, item.side ?? item.order_type ?? '—'));
      row.append(side);

      const entry = document.createElement('td');
      const entryDual = makeElement('div', 'dual-cell');
      entryDual.append(makeElement('strong', '', price(item.entry_price)));
      const markText = item.recordType === 'ORDER'
        ? `expires ${timeOf(item.expires_at)}`
        : `Last ${price(item.mark_price)} · ${timestampOf(item.lastMarkAt)}${quoteFresh ? '' : ' · STALE'}`;
      entryDual.append(makeElement('small', item.recordType === 'POSITION' ? 'position-mark-meta' : '', markText));
      entry.append(entryDual);
      row.append(entry);

      const stop = document.createElement('td');
      const stopDual = makeElement('div', 'dual-cell');
      stopDual.append(makeElement('strong', '', price(item.stop_price)));
      stopDual.append(makeElement('small', '', price(item.take_profit_1)));
      stop.append(stopDual);
      row.append(stop);

      row.append(makeElement('td', 'risk-text', item.quantity_open_lots ?? item.quantity_lots ?? '—'));
      const pnl = makeElement('td', `pnl-cell ${item.unrealized_pnl == null ? 'neutral' : Number(item.unrealized_pnl) >= 0 ? 'positive' : 'negative'}`, item.recordType === 'ORDER' ? '—' : money(item.unrealized_pnl));
      if (item.recordType === 'POSITION') pnl.append(makeElement('small', '', `Realized ${money(item.realized_pnl)}`));
      row.append(pnl);

      const actionCell = document.createElement('td');
      if (item.recordType === 'POSITION') {
        const closeButton = makeElement('button', 'ghost-button close-paper-button', operatorAuthenticated ? 'Close paper' : 'Unlock controls');
        closeButton.type = 'button';
        closeButton.disabled = !operatorAuthenticated || !quoteFresh;
        closeButton.title = !operatorAuthenticated ? 'Authenticate local operator controls first.'
          : !quoteFresh ? 'A fresh verified broker quote is required.' : 'Close with the latest verified quote and configured paper slippage.';
        closeButton.addEventListener('click', async () => {
          if (!operatorAuthenticated || !quoteFresh) return;
          const positionId = String(item.id ?? '');
          if (!window.confirm(`Close paper position ${positionId} using the latest verified broker quote and configured paper slippage? This records a paper close only; it cannot send a live order.`)) return;
          closeButton.disabled = true;
          try {
            const { response, body } = await request('/api/actions/close', {
              method: 'POST', body: JSON.stringify({ positionId }),
            });
            if (!response.ok) {
              const reason = body.error === 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED' ? 'Close held: fresh broker quote is unavailable.'
                : body.error === 'PAPER_COST_MODEL_UNAVAILABLE' ? 'Close held: paper cost assumptions are unavailable.'
                  : body.error === 'POSITION_NOT_OPEN' ? 'This position is no longer open.'
                    : `Paper close rejected safely (${body.error ?? 'service unavailable'}).`;
              throw new Error(reason);
            }
            showToast('Paper position closed and journaled. No live order was sent.');
          } catch (error) {
            showToast(error.message || 'Paper close unavailable; position state was not assumed.');
          } finally {
            await loadDashboard();
          }
        });
        actionCell.append(closeButton);
      } else actionCell.textContent = '—';
      row.append(actionCell);
      tbody.append(row);
    }
  }

  function renderAudit(events = []) {
    const list = $('#auditList');
    if (!list) return;
    list.replaceChildren();
    if (!events.length) {
      list.append(makeElement('div', 'empty-state', 'No audit events recorded yet.'));
      return;
    }
    for (const event of events) {
      const item = makeElement('div', 'audit-item');
      const time = makeElement('span', 'audit-time', timeOf(event.created_at));
      const dot = makeElement('span', `audit-dot ${event.event_type?.includes('BLOCKED') ? 'amber' : 'cyan'}`);
      const content = makeElement('div');
      content.append(makeElement('strong', '', String(event.event_type ?? 'EVENT').replaceAll('_', ' ')));
      content.append(makeElement('small', '', event.reason ?? ''));
      item.append(time, dot, content);
      list.append(item);
    }
  }

  function renderJournal(stats, closedCount) {
    const grid = $('#journalMetrics');
    const slices = $('#journalSlices');
    if (!grid) return;
    const n = Number(stats?.sampleCount ?? closedCount ?? 0);
    const metrics = stats?.metrics ?? null;
    const enough = Boolean(stats?.sufficientSample && metrics);
    const moneyValue = (value) => stats?.currency ? money(value, stats.currency) : '—';
    const numberValue = (value, digits = 2, suffix = '') => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : '—';
    const intervalText = (interval, lowKey, highKey, digits, suffix, method, sampleCount) => interval
      ? `${method} 95% CI ${numberValue(interval[lowKey], digits, suffix)}–${numberValue(interval[highKey], digits, suffix)} · n=${sampleCount}`
      : note;
    const note = enough ? `paper journal · n=${n}`
      : stats?.metricsSuppressedReason ? `hidden · ${String(stats.metricsSuppressedReason).replaceAll('_', ' ').toLowerCase()}`
        : `hidden · n=${n}; minimum ${stats?.minimumInterpretationSample ?? 30}`;
    const cards = [
      ['Closed paper trades', String(n), 'persisted outcomes'],
      ['Win rate', enough ? numberValue(metrics.winRatePct, 1, '%') : '—', enough
        ? intervalText(metrics.winRate95CiPct, 'lowerPct', 'upperPct', 1, '%', 'Wilson', metrics.winRateSampleCount) : note],
      ['Profit factor', enough ? numberValue(metrics.profitFactor) : '—', note],
      ['Expectancy', enough ? numberValue(metrics.expectancyR, 2, 'R') : '—', enough
        ? intervalText(metrics.expectancyR95Ci, 'lower', 'upper', 2, 'R', 'Approx. t', metrics.expectancyRSampleCount) : note],
      ['Net P&L', enough ? moneyValue(metrics.netPnl) : '—', stats?.currency ?? 'currency context required'],
      ['Max drawdown', enough ? numberValue(metrics.maxDrawdownR, 2, 'R') : '—', 'peak-to-trough in cumulative R'],
      ['Average win / loss', enough ? `${moneyValue(metrics.averageWin)} / ${moneyValue(metrics.averageLoss)}` : '—', note],
      ['Net result', enough ? numberValue(metrics.netR, 2, 'R') : '—', 'sum of normalized R'],
      ['Average fill delay', enough ? `${numberValue(metrics.averageFillDelaySeconds, 0, ' sec')} · n=${metrics.fillDelaySampleCount}` : '—', 'order created to first paper fill'],
      ['Average trade duration', enough ? numberValue(metrics.averageDurationSeconds / 60, 1, ' min') : '—', 'open to final close'],
      ['Average MFE / MAE', enough ? `${numberValue(metrics.averageMfePrice, 2)} / ${numberValue(metrics.averageMaePrice, 2)}` : '—', 'price movement · descriptive'],
      ['TP1 reached', enough ? `${metrics.tp1HitCount} / ${n}` : '—', 'closed positions with TP1 event'],
      ['TP2 exits', enough ? String(metrics.tp2CloseCount) : '—', 'paper close reason'],
      ['Direct stop exits', enough ? String(metrics.directSlCount) : '—', 'before TP1 protection'],
      ['Protected exits', enough ? String(metrics.protectedAfterTp1Count) : '—', 'stop after TP1'],
      ['Today realized', stats?.periods?.today?.sampleCount && stats.currency ? moneyValue(stats.periods.today.realizedNetPnl) : '—', `closed today · n=${stats?.periods?.today?.sampleCount ?? 0}`],
      ['Trailing 7 days', stats?.periods?.trailing7Days?.sampleCount && stats.currency ? moneyValue(stats.periods.trailing7Days.realizedNetPnl) : '—', `closed in UTC window · n=${stats?.periods?.trailing7Days?.sampleCount ?? 0}`],
      ['Expired pending', String(stats?.pendingExpiredCount ?? 0), 'not counted as a closed trade'],
      ['Interpretation', enough ? 'PAPER HISTORY ONLY' : 'NO CONCLUSION', enough
        ? 'descriptive only · assumes independent trades · not a forecast' : note],
    ];
    grid.replaceChildren(...cards.map(([label, value, detail]) => {
      const card = makeElement('div', 'journal-stat');
      card.append(makeElement('span', '', label), makeElement('strong', '', value), makeElement('small', '', detail));
      return card;
    }));

    if (!slices) return;
    slices.replaceChildren();
    const groups = [
      ['side', 'Trade side'], ['exitResult', 'Exit result'], ['setupQuality', 'Setup-quality tags'],
      ['regime', 'Market regime'], ['session', 'Trading session'], ['spreadAtr', 'Spread / ATR bucket'],
      ['news', 'News state'], ['broker', 'Broker source'], ['symbol', 'Symbol'], ['timeframe', 'Timeframe'],
    ];
    for (const [key, title] of groups) {
      const entries = Object.entries(stats?.slices?.[key] ?? {});
      const panel = makeElement('article', 'journal-cohort');
      panel.append(makeElement('h3', '', title));
      if (!entries.length) {
        panel.append(makeElement('p', 'empty-state', 'No persisted trades in this cohort yet.'));
        slices.append(panel);
        continue;
      }
      const table = makeElement('table', 'journal-table');
      const head = makeElement('thead');
      const headingRow = makeElement('tr');
      for (const label of ['Group', 'n', 'Readout']) headingRow.append(makeElement('th', '', label));
      head.append(headingRow);
      const body = makeElement('tbody');
      for (const [name, summary] of entries) {
        const row = makeElement('tr');
        const summaryMetrics = summary.metrics;
        const winInterval = summaryMetrics?.winRate95CiPct;
        const expectancyInterval = summaryMetrics?.expectancyR95Ci;
        const readout = summaryMetrics
          ? `${numberValue(summaryMetrics.winRatePct, 1, '%')} win${winInterval ? ` (95% CI ${numberValue(winInterval.lowerPct, 1, '%')}–${numberValue(winInterval.upperPct, 1, '%')})` : ''} · PF ${numberValue(summaryMetrics.profitFactor)} · ${numberValue(summaryMetrics.expectancyR, 2, 'R')}${expectancyInterval ? ` (approx. 95% CI ${numberValue(expectancyInterval.lower, 2)}–${numberValue(expectancyInterval.upper, 2)}R)` : ''} · ${moneyValue(summaryMetrics.netPnl)}`
          : summary.metricsSuppressedReason
            ? `Hidden · ${String(summary.metricsSuppressedReason).replaceAll('_', ' ').toLowerCase()}`
            : `Insufficient sample · ${summary.sampleCount}/30`;
        row.append(makeElement('td', '', name.replaceAll('_', ' ')), makeElement('td', 'mono', summary.sampleCount), makeElement('td', '', readout));
        body.append(row);
      }
      table.append(head, body);
      panel.append(table);
      slices.append(panel);
    }
  }

  function renderResearchResult(result) {
    const container = $('#researchResult');
    if (!container) return;
    container.replaceChildren();
    const evidence = makeElement('strong', 'research-evidence', `${result.evidenceClass ?? 'HISTORICAL REPLAY'} · ${result.performanceEvidenceEligible ? 'coverage eligible' : 'not performance evidence'}`);
    const provenance = makeElement('p', 'research-provenance', `Dataset ${result.provenance?.datasetId ?? '—'} · ${result.provenance?.sourceAttestation ?? 'owner assertion'} · provider ${result.provenance?.provider ?? '—'} · SHA-256 ${String(result.provenance?.datasetSha256 ?? '—').slice(0, 12)}… · ${Number(result.provenance?.quoteCount ?? 0).toLocaleString('en-US')} quotes`);
    const folds = makeElement('div', 'research-folds');
    for (const fold of result.folds ?? []) {
      const panel = makeElement('div', 'research-fold');
      panel.append(makeElement('strong', '', `Fold ${fold.fold} · ${fold.scanCoveragePct}% scan coverage`));
      const metrics = fold.performance?.metrics;
      if (metrics && fold.performance.sampleCount >= 30) {
        panel.append(makeElement('span', '', `n=${fold.performance.sampleCount} · win ${Number(metrics.winRatePct).toFixed(1)}% · PF ${metrics.profitFactor == null ? '—' : Number(metrics.profitFactor).toFixed(2)} · E[R] ${metrics.expectancyR == null ? '—' : Number(metrics.expectancyR).toFixed(3)} · net ${metrics.netR == null ? '—' : Number(metrics.netR).toFixed(2)}R · max DD ${Number(metrics.maxDrawdownR).toFixed(2)}R`));
      } else {
        panel.append(makeElement('span', '', `n=${fold.performance?.sampleCount ?? fold.closedTradeCount ?? 0} · metrics hidden · ${fold.performance?.suppressedReason ?? 'SAMPLE_BELOW_30'}`));
      }
      folds.append(panel);
    }
    container.append(evidence, provenance, folds,
      makeElement('small', 'research-caveat', `Report ${String(result.runId ?? '').slice(0, 12)}… · report SHA-256 ${String(result.reportSha256 ?? '—').slice(0, 12)}… · build ${result.buildId ?? '—'} · schema ${result.schemaVersionUsed ?? '—'} · strategy ${result.strategyVersion ?? '—'} · saved locally · historical replay, not a forecast · live trading ${result.liveTradingEnabled ? 'enabled' : 'disabled'}.`));
  }

  function renderWatchlist(markets = []) {
    const container = $('#marketWatchlist');
    if (!container) return;
    container.replaceChildren();
    if (!Array.isArray(markets) || !markets.length) {
      container.append(makeElement('div', 'empty-state', 'No verified market-data snapshots yet.'));
      return;
    }
    for (const item of markets) {
      const freshness = item.dataFreshness ?? 'UNAVAILABLE';
      const card = makeElement('article', `watch-card ${freshness === 'FRESH' ? 'fresh' : freshness === 'STALE' ? 'stale' : ''}`);
      const top = makeElement('div', 'watch-card-top');
      top.append(makeElement('strong', '', item.symbol ?? '—'));
      top.append(makeElement('small', '', freshness));
      const quote = item.quote ?? {};
      const priceRow = makeElement('div', 'watch-card-price');
      priceRow.append(makeElement('span', '', quote.last == null ? '—' : price(quote.last)));
      priceRow.append(makeElement('small', '', item.spreadPrice == null ? 'spread —' : `spread ${price(item.spreadPrice)}`));
      const meta = makeElement('div', 'watch-card-meta', `${item.source ?? 'none'} · observed ${timeOf(quote.observedAt)} · M15 ${item.lastClosedCandleAt ? timeOf(item.lastClosedCandleAt) : '—'}`);
      card.append(top, priceRow, meta);
      container.append(card);
    }
  }

  function renderDashboard(data, audit, mtf) {
    dashboardState = data;
    const trading = data.trading ?? {};
    const broker = data.broker ?? {};
    const risk = data.risk ?? {};
    const account = data.account ?? {};
    const counts = data.counts ?? {};
    const control = data.control ?? {};
    const telegram = data.telegram ?? {};
    setText('#apiStatusLabel', 'SERVICE ONLINE');
    setText('#telegramStatus', 'Telegram: ' + (telegram.enabled ? telegram.status ?? 'starting' : 'disabled'));
    if ($('#telegramStatus')) $('#telegramStatus').title = telegram.lastErrorCode
      ?? (telegram.notificationsEnabled ? String(telegram.pendingNotifications ?? 0) + ' queued notification(s).' : telegram.configured ? 'Bot configured; command access is allowlisted.' : 'No Telegram connection is enabled.');
    setText('#sidebarStatus', data.worker?.running ? 'Worker running · feed offline' : 'Worker heartbeat unavailable');
    setText('#buildInfo', `BUILD ${data.app?.buildId ?? '—'} · SCHEMA ${data.app?.schemaVersion ?? '—'}`);
    setText('#serverClock', timeOf(data.generatedAt));
    setText('#liveBadge', trading.liveTradingEnabled ? 'LIVE ROUTE ERROR' : 'LIVE DISABLED');
    setText('#botState', trading.state ?? 'BROKER OFFLINE');
    const paperModeState = trading.paperModeState
      ?? (trading.paperMode === true ? 'PAPER MODE ENABLED' : trading.paperMode === false ? 'PAPER OFF' : 'PAPER MODE UNKNOWN');
    setText('#paperModeState', paperModeState === 'PAPER OFF' ? 'PAPER OFF · MONITORING ONLY' : paperModeState);
    if ($('#paperModeState')) $('#paperModeState').title = trading.paperMode === true
      ? 'Paper mode is enabled; the engine status still determines whether new entries are allowed.'
      : trading.paperMode === false ? 'Paper execution is off; only read-only monitoring remains.' : 'Paper mode could not be confirmed.';
    setText('#engineCoreState', trading.entriesAllowed ? 'READY' : 'BLOCKED');
    setText('#workerState', data.worker?.running ? 'Worker heartbeat current' : 'Worker not ready');
    setText('#workerHeartbeat', timeOf(data.worker?.heartbeatAt));
    const lastTick = data.worker?.lastTick;
    const tickDuration = Number.isFinite(lastTick?.durationMs) ? `${lastTick.durationMs} ms` : 'Duration unavailable';
    setText('#workerLatency', lastTick
      ? `${tickDuration} · ${lastTick.errorClass ? lastTick.errorClass : 'cycle completed'}`
      : data.worker?.heartbeatAt ? 'Not reported by this build' : 'Awaiting first cycle');
    const workerTrend = data.worker?.telemetryLastHour;
    if (!workerTrend || !Number.isInteger(workerTrend.sampleCount)) {
      setText('#workerTrend', 'Retained metrics unavailable');
    } else if (!workerTrend.sampleCount) {
      setText('#workerTrend', 'No cycles recorded in the last hour');
    } else {
      const p95 = Number.isFinite(workerTrend.durationMs?.p95) ? `${workerTrend.durationMs.p95.toFixed(1)} ms` : '—';
      setText('#workerTrend', `n=${workerTrend.sampleCount} · p95 ${p95} · errors ${workerTrend.failedCycles ?? 0}`);
      if ($('#workerTrend')) $('#workerTrend').title = workerTrend.truncated
        ? 'Local SQLite worker-cycle history; this window is capped at the most recent 6,000 samples.'
        : 'Local SQLite worker-cycle history for the last hour; diagnostic latency, not broker execution evidence.';
    }
    setText('#brokerHealth', broker.status ?? 'OFFLINE');
    setText('#newsHealth', data.news?.status === 'HEALTHY' ? 'HEALTHY' : `${data.news?.status ?? 'UNKNOWN'} · ENTRY BLOCKED`);
    setText('#scanStatus', data.lastScan ? `${data.lastScan.status} · ${timeOf(data.lastScan.completed_at)}` : 'Waiting for verified data');
    setText('#pendingSetups', counts.pendingOrders ?? 0);
    setText('#pendingCount', `${counts.pendingOrders ?? 0} pending orders`);
    setText('#operatorAuthStatus', control.operatorAuthenticated ? 'UNLOCKED · MEMORY ONLY'
      : control.authConfigured ? 'LOCKED · ENTER LOCAL TOKEN' : 'SET NEXORA_CONTROL_TOKEN IN .env');
    const operatorInput = $('#operatorToken');
    const operatorButton = $('#operatorAuthButton');
    if (operatorInput) operatorInput.disabled = !control.authConfigured;
    if (operatorButton) {
      operatorButton.disabled = !control.authConfigured;
      operatorButton.textContent = control.operatorAuthenticated ? 'Lock controls' : 'Unlock controls';
    }
    const paperButton = $('#paperModeButton');
    if (paperButton) {
      paperButton.textContent = control.operatorAuthenticated
        ? data.trading?.paperMode ? 'Turn paper mode OFF' : 'Turn paper mode ON'
        : `Paper mode: ${data.trading?.paperMode ? 'ON' : 'OFF'}`;
      paperButton.disabled = !control.operatorAuthenticated;
      paperButton.title = data.trading?.paperMode
        ? 'Turning paper mode off pauses new entries; monitoring stays read-only.'
        : 'Turning paper mode on does not resume entries; readiness and a separate operator resume are required.';
    }
    const scanButton = $('#scanButton');
    if (scanButton) scanButton.disabled = !control.operatorAuthenticated;
    const researchButton = $('#researchButton');
    const researchDatasetName = $('#researchDatasetName');
    if (researchButton) researchButton.disabled = !control.operatorAuthenticated;
    if (researchDatasetName) researchDatasetName.disabled = !control.operatorAuthenticated;
    const forwardTrades = Number(counts.forwardPaperTrades ?? 0);
    const forwardRequired = Number(counts.forwardPaperTradesRequired ?? 100);
    setText('#forwardEvidenceSummary', `${forwardTrades} / ${forwardRequired} closed broker-fed paper trades · operational milestone only, not strategy validation.`);
    setText('#forwardEvidenceStatus', forwardTrades >= forwardRequired ? 'MILESTONE MET' : 'INCOMPLETE');
    setText('#safetyMessage', 'No live-order adapter is installed. This workspace is paper-only.');
    setText('#safetyState', trading.entriesAllowed ? 'PAPER GUARDS ACTIVE' : 'FAIL-CLOSED');
    setText('#accountCurrencyKicker', account.currency ?? '—');
    setText('[data-metric="balance"]', account.balance == null || !account.currency ? '—' : money(account.balance, account.currency));
    setText('[data-metric="daily-pnl"]', account.dailyPnl == null || !account.currency ? '—' : money(account.dailyPnl, account.currency));
    setText('[data-metric="drawdown"]', percent(risk.drawdownPct));
    setText('[data-metric="positions"]', counts.openPositions ?? 0);
    setText('#riskPerTrade', percent(risk.limits?.riskPerTradePct));
    setText('#maxTotalRisk', percent(risk.limits?.maxTotalOpenRiskPct));
    setText('#maxDrawdown', percent(risk.limits?.drawdownPausePct));
    setText('#drawdownWarningThreshold', `WARNING ${percent(risk.limits?.drawdownWarningPct)}`);
    setText('#dailyRiskUsed', `${risk.dailyLossR == null ? '—' : Number(risk.dailyLossR).toFixed(2)}R / ${Number(risk.limits?.dailyLossLimitR ?? 3).toFixed(2)}R`);
    setText('#openRisk', percent(risk.openRiskPct));
    setText('#riskState', risk.status ?? 'ENTRY BLOCKED');
    setText('#riskFreshness', `Risk data ${risk.freshness ?? 'UNAVAILABLE'} · observed ${timeOf(risk.updatedAt)}`);
    setText('#dailyLossGuard', risk.dailyLossR == null ? 'UNKNOWN' : Number(risk.dailyLossR) < Number(risk.limits?.dailyLossLimitR ?? 3) ? 'WITHIN LIMIT' : 'PAUSED');
    setText('#drawdownGuard', risk.drawdownPct == null ? 'UNKNOWN' : Number(risk.drawdownPct) < Number(risk.limits?.drawdownPausePct ?? 10) ? 'WITHIN LIMIT' : 'PAUSED');
    setText('#gateReason', trading.stateReason ?? 'No complete, fresh candle set');
    setText('#dataGate', data.market?.dataFreshness ?? 'Data unavailable');
    setText('#newsGate', 'News unknown');
    setText('#riskGate', risk.freshness !== 'FRESH' ? `Risk ${String(risk.freshness ?? 'unavailable').toLowerCase()}`
      : risk.reasons?.length ? `Risk blocked · ${risk.reasons.join(', ')}`
        : trading.entriesAllowed ? 'Risk checks active' : 'Risk gate clear · other checks required');
    setText('#gateResult', trading.entriesAllowed ? 'CHECKS REQUIRED' : 'ENTRY BLOCKED');
    setText('#gateDirection', 'NO BIAS');
    setText('#gateCount', '0 of 4 timeframes available');
    setText('#confluenceScore', '—/100');
    renderMarket(data.market);
    renderWatchlist(data.markets);
    renderMtf(mtf, data);
    renderPositions(data.positions, data.orders, Boolean(data.control?.operatorAuthenticated), data.market?.dataFreshness === 'FRESH');
    renderAudit(audit);
    renderJournal(data.statistics, counts.closedTrades ?? 0);
    const online = broker.connected === true;
    for (const selector of ['#apiStatusDot', '#sidebarStatusDot', '#workerDot']) {
      $(selector)?.classList.toggle('green', online && data.worker?.running === true);
      $(selector)?.classList.toggle('amber', !(online && data.worker?.running === true));
    }
    const pauseButton = $('#pauseButton');
    if (pauseButton) {
      pauseButton.classList.toggle('paused', Boolean(trading.entryPaused));
      const readinessReasons = [];
      if (!data.worker?.running) readinessReasons.push('worker not ready');
      if (!broker.connected) readinessReasons.push('broker offline');
      if (data.market?.dataFreshness !== 'FRESH') readinessReasons.push('fresh broker quote unavailable');
      if (data.news?.status !== 'HEALTHY') readinessReasons.push('news calendar unavailable or stale');
      if (risk.freshness !== 'FRESH') readinessReasons.push('risk state unavailable or stale');
      else if (risk.reasons?.length) readinessReasons.push(...risk.reasons.map((reason) => reason.toLowerCase().replaceAll('_', ' ')));
      const canResume = readinessReasons.length === 0;
      const label = trading.entryPaused ? canResume ? 'Resume entries' : 'Waiting for readiness' : 'Pause entries';
      pauseButton.replaceChildren(makeElement('span', 'pause-icon', trading.entryPaused ? '▶' : 'Ⅱ'), document.createTextNode(` ${label}`));
      pauseButton.disabled = !control.operatorAuthenticated || Boolean(trading.entryPaused && !canResume);
      pauseButton.title = trading.entryPaused && !canResume ? `Resume blocked: ${readinessReasons.join(', ')}.` : trading.stateReason ?? '';
    }
  }

  async function loadDashboard() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const [dashboard, audit, mtf, candles] = await Promise.all([
        request('/api/dashboard'),
        request('/api/audit?limit=8'),
        request('/api/mtf/latest').catch(() => null),
        request(`/api/market/candles?timeframe=${encodeURIComponent(selectedTimeframe)}`).catch(() => null),
      ]);
      if (!dashboard.response.ok || !audit.response.ok) throw new Error('Local API request failed.');
      renderDashboard(dashboard.body, audit.body, mtf?.response.ok ? mtf.body : null);
      renderCandles(candles?.response.ok ? candles.body : null);
    } catch (error) {
      renderOffline(error?.name === 'TimeoutError' ? error.message : undefined);
      renderMtf(null, null);
      renderCandles(null);
    } finally {
      refreshInFlight = false;
    }
  }

  async function performAction(action, successMessage) {
    const button = $('#pauseButton');
    if (button) button.disabled = true;
    try {
      const { response, body } = await request(`/api/actions/${action}`, { method: 'POST', body: '{}' });
      if (!response.ok) throw new Error(body.error ?? 'Action was blocked by the safety policy.');
      showToast(successMessage);
    } catch (error) {
      showToast(error.message || 'Action unavailable; entries remain blocked.');
    } finally {
      if (button) button.disabled = false;
      await loadDashboard();
    }
  }

  const titleMap = { overview: 'Overview', signals: 'Signal Lab', journal: 'Trade Journal', risk: 'Risk & Guards' };
  $$('.nav-item[data-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.section;
      $$('.nav-item[data-section]').forEach((item) => item.classList.toggle('active', item === button));
      setText('#pageTitle', titleMap[section] ?? 'Overview');
      $$('.secondary-section').forEach((panel) => panel.classList.toggle('active', panel.dataset.sectionPanel === section));
      $$('[data-section-panel="overview"]').forEach((panel) => { panel.style.display = section === 'overview' ? '' : 'none'; });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  $$('.chart-tab').forEach((button) => button.addEventListener('click', () => {
    $$('.chart-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    selectedTimeframe = button.dataset.timeframe;
    void loadCandles();
  }));

  $('#pauseButton')?.addEventListener('click', () => {
    const action = dashboardState?.trading?.entryPaused ? 'resume' : 'pause';
    void performAction(action, action === 'pause' ? 'New paper entries paused.' : 'Paper entry state updated.');
  });

  $('#scanButton')?.addEventListener('click', async () => {
    const button = $('#scanButton');
    if (button) button.disabled = true;
    try {
      const { response, body } = await request('/api/actions/scan', { method: 'POST', body: '{}' });
      if (response.status === 409 && body.status === 'BLOCKED') {
        showToast(`Scan held: ${(body.reasons ?? []).join(', ')}`);
      } else if (!response.ok) {
        throw new Error(body.error ?? 'Scan failed safely.');
      }
    } catch (error) {
      showToast(error.message || 'Scan unavailable; no order was created.');
    } finally {
      if (button) button.disabled = false;
      await loadDashboard();
    }
  });

  $('#paperModeButton')?.addEventListener('click', async () => {
    const button = $('#paperModeButton');
    if (!dashboardState?.control?.operatorAuthenticated) return;
    const enabled = !dashboardState.trading?.paperMode;
    if (button) button.disabled = true;
    try {
      const { response, body } = await request('/api/actions/paper', {
        method: 'POST', body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(body.error ?? 'Paper mode change was blocked.');
      showToast(enabled ? 'Paper mode enabled; entries remain paused.' : 'Paper mode disabled; monitoring only.');
    } catch (error) {
      showToast(error.message || 'Paper mode unchanged.');
    } finally {
      await loadDashboard();
    }
  });

  $('#researchButton')?.addEventListener('click', async () => {
    const button = $('#researchButton');
    const datasetName = $('#researchDatasetName')?.value.trim() ?? '';
    if (!dashboardState?.control?.operatorAuthenticated) {
      showToast('Unlock local controls before running research.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(datasetName)) {
      setText('#researchResult', 'Enter one .json filename. Folder paths and uploads are not accepted.');
      return;
    }
    if (button) button.disabled = true;
    setText('#researchResult', 'Running offline walk-forward replay. No order can be sent.');
    try {
      const { response, body } = await request('/api/actions/research', {
        method: 'POST', body: JSON.stringify({ datasetName }),
      });
      if (!response.ok) {
        const messages = {
          RESEARCH_DATASET_NOT_FOUND: 'Dataset not found. Put the verified JSON file in data/research-datasets and retry.',
          RESEARCH_DATASET_JSON_INVALID: 'The selected dataset is not valid JSON.',
          RESEARCH_DATASET_NAME_INVALID: 'Use a single .json filename, not a folder path.',
        };
        throw new Error(messages[body.error] ?? `Research stopped safely (${body.error ?? 'service unavailable'}).`);
      }
      renderResearchResult(body);
      showToast(body.idempotentReplay ? 'Existing research result restored.' : 'Historical replay completed and saved locally.');
    } catch (error) {
      setText('#researchResult', error.message || 'Research stopped safely; no order was sent.');
      showToast(error.message || 'Research stopped safely.');
    } finally {
      if (button) button.disabled = !dashboardState?.control?.operatorAuthenticated;
    }
  });

  $('#refreshButton')?.addEventListener('click', () => void loadDashboard());
  $('#operatorAuthButton')?.addEventListener('click', async () => {
    const input = $('#operatorToken');
    if (operatorToken) {
      operatorToken = '';
      await loadDashboard();
      showToast('Local controls locked.');
      return;
    }
    const candidate = input?.value ?? '';
    if (input) input.value = '';
    if (!candidate) {
      showToast('Enter the locally configured control token.');
      return;
    }
    operatorToken = candidate;
    try {
      const { response, body } = await request('/api/dashboard');
      if (!response.ok || body.control?.operatorAuthenticated !== true) {
        operatorToken = '';
        showToast('Control token was not accepted.');
        await loadDashboard();
        return;
      }
      showToast('Controls unlocked in memory for this page session.');
      await loadDashboard();
    } catch {
      operatorToken = '';
      showToast('Local authorization could not be checked.');
    }
  });
  void loadDashboard();
  setInterval(() => void loadDashboard(), 15_000);
})();
