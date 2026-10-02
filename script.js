/* GoldTrack Stage 1: dashboard metrics and the TradingView chart. */
(function () {
  "use strict";

  const TRADES_KEY = "goldtrack.trades.v1";
  const PREFERENCES_KEY = "goldtrack.preferences.v1";
  const RISK_PLANS_KEY = "goldtrack.riskPlans.v1";
  const STRATEGIES_KEY = "goldtrack.strategies.v1";
  const DEFAULT_PREFERENCES = { accountName: "My Trading Account", currency: "USD" };
  const DEFAULT_RISK_SETTINGS = { accountBalance: "", currency: "USD", maximumRiskPercent: "", maximumDailyLoss: "", defaultSymbol: "XAUUSD", brokerSpecifications: {} };
  const $ = (selector) => document.querySelector(selector);
  const moneyFormatterCache = new Map();
  let toastTimer;
  let chartLoadTimer;
  let chartObserver;
  let chartGeneration = 0;
  let chartRequested = false;
  let editingRiskPlanId = "";
  let riskPlansStorageError = false;
  let editingStrategyId = "";
  let strategiesStorageError = false;
  let backtestCandles = null;
  let backtestLastResult = null;

  function readStoredArray(key) {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error("Saved journal data is not a list.");
      return parsed.filter((record) => record && typeof record === "object" && !Array.isArray(record));
    } catch (error) {
      showToast("Saved journal data could not be read. It has not been changed.");
      console.error("GoldTrack storage read failed:", error);
      return [];
    }
  }

  function readPreferences() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
      return { ...DEFAULT_PREFERENCES, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch (error) {
      console.error("GoldTrack preferences could not be read:", error);
      return { ...DEFAULT_PREFERENCES };
    }
  }

  function currentTrades() {
    return readStoredArray(TRADES_KEY);
  }

  function currencyCode() {
    const value = String(readPreferences().currency || "USD").trim().toUpperCase();
    return /^[A-Z]{3}$/.test(value) ? value : "USD";
  }

  function formatMoneyInCurrency(value, currency, options = {}) {
    const safeCurrency = /^[A-Z]{3}$/.test(String(currency || "")) ? String(currency) : "USD";
    const cacheKey = `${safeCurrency}:${options.compact ? "compact" : "full"}`;
    if (!moneyFormatterCache.has(cacheKey)) {
      try {
        moneyFormatterCache.set(cacheKey, new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: safeCurrency,
          notation: options.compact ? "compact" : "standard",
          maximumFractionDigits: options.compact ? 1 : 2,
          minimumFractionDigits: options.compact ? 0 : 2
        }));
      } catch (_) {
        moneyFormatterCache.set(cacheKey, new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }));
      }
    }
    return moneyFormatterCache.get(cacheKey).format(Number.isFinite(value) ? value : 0);
  }

  function formatMoney(value, options = {}) {
    return formatMoneyInCurrency(value, currencyCode(), options);
  }

  function tradeCurrency(trade) {
    const code = String(trade.currency || currencyCode()).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : currencyCode();
  }

  function formatTradeMoney(value, trade, options = {}) {
    return formatMoneyInCurrency(value, tradeCurrency(trade), options);
  }

  function tradeProfitLoss(trade) {
    const value = Number(trade.profitLoss);
    return trade.profitLoss !== "" && trade.profitLoss !== null && trade.profitLoss !== undefined && Number.isFinite(value) ? value : null;
  }

  function isOpenTrade(trade) {
    return String(trade.outcome || "").trim().toLowerCase() === "open";
  }

  function tradeDate(trade) {
    const raw = trade.dateTime || trade.date || trade.createdAt || "";
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function displayDate(value, options = { month: "short", day: "numeric" }) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function safeText(value, fallback = "—") {
    if (value === null || value === undefined || String(value).trim() === "") return fallback;
    return String(value).trim();
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function updateHeader() {
    const preferences = readPreferences();
    setText("#account-name", safeText(preferences.accountName, "My Trading Account"));
    setText("#today-label", displayDate(new Date(), { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
  }

  function closedTrades(trades) {
    return trades
      .filter((trade) => !isOpenTrade(trade) && tradeProfitLoss(trade) !== null)
      .map((trade) => ({ trade, pnl: tradeProfitLoss(trade), date: tradeDate(trade) }));
  }

  function updateMetrics(trades) {
    const closed = closedTrades(trades);
    const wins = closed.filter((item) => item.pnl > 0);
    const losses = closed.filter((item) => item.pnl < 0);
    const grossProfit = wins.reduce((sum, item) => sum + item.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, item) => sum + item.pnl, 0));
    const net = closed.reduce((sum, item) => sum + item.pnl, 0);
    const currencies = new Set(closed.map((item) => tradeCurrency(item.trade)));
    const mixedCurrencies = currencies.size > 1;
    const breakevenCount = closed.length - wins.length - losses.length;
    const best = closed.length ? closed.reduce((a, b) => b.pnl > a.pnl ? b : a) : null;
    const worst = closed.length ? closed.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;

    setText("#total-trades", String(trades.length));
    setText("#closed-trades-label", `${closed.length} closed trade${closed.length === 1 ? "" : "s"}`);
    const netElement = $("#net-pnl");
    if (netElement) {
      netElement.textContent = closed.length ? mixedCurrencies ? "Mixed currencies" : formatMoneyInCurrency(net, currencies.values().next().value) : "—";
      netElement.classList.toggle("positive", !mixedCurrencies && net > 0);
      netElement.classList.toggle("negative", !mixedCurrencies && net < 0);
    }
    setText("#win-rate", closed.length ? `${((wins.length / closed.length) * 100).toFixed(1)}%` : "0%");
    setText("#win-loss-count", `${wins.length} win${wins.length === 1 ? "" : "s"} · ${losses.length} loss${losses.length === 1 ? "" : "es"}${breakevenCount ? ` · ${breakevenCount} breakeven` : ""}`);
    setText("#average-win", wins.length ? mixedCurrencies ? "Mixed currencies" : formatMoneyInCurrency(grossProfit / wins.length, currencies.values().next().value) : "—");
    setText("#average-loss", losses.length ? mixedCurrencies ? "Mixed currencies" : formatMoneyInCurrency(losses.reduce((sum, item) => sum + item.pnl, 0) / losses.length, currencies.values().next().value) : "—");
    setText("#profit-factor", mixedCurrencies ? "—" : grossLoss ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? "∞" : "—"));
    setText("#best-trade", best ? mixedCurrencies ? "Mixed currencies" : formatTradeMoney(best.pnl, best.trade) : "—");
    setText("#best-trade-date", best ? mixedCurrencies ? "Cannot compare different currencies" : `${safeText(best.trade.symbol, "Trade")} · ${best.date ? displayDate(best.date) : "Date not set"}` : "No closed trades");
    setText("#worst-trade", worst ? mixedCurrencies ? "Mixed currencies" : formatTradeMoney(worst.pnl, worst.trade) : "—");
    setText("#worst-trade-date", worst ? mixedCurrencies ? "Cannot compare different currencies" : `${safeText(worst.trade.symbol, "Trade")} · ${worst.date ? displayDate(worst.date) : "Date not set"}` : "No closed trades");
    $("#empty-banner").hidden = trades.length > 0;
  }

  function escapeSvgText(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
  }

  function renderEmptyChart(container, message) {
    container.innerHTML = `<div class="chart-empty">${escapeSvgText(message)}</div>`;
  }

  function renderEquityChart(closed) {
    const container = $("#equity-chart");
    if (!container) return;
    if (!closed.length) {
      renderEmptyChart(container, "Your equity curve will appear after closed trades are saved.");
      return;
    }
    if (new Set(closed.map((item) => tradeCurrency(item.trade))).size > 1) {
      renderEmptyChart(container, "Equity curve needs one currency at a time. Saved closed trades contain multiple currencies, which are not converted.");
      return;
    }
    const dated = closed.filter((item) => item.date).sort((a, b) => a.date - b.date);
    if (!dated.length) {
      renderEmptyChart(container, "Add trade dates to see your equity curve.");
      return;
    }
    let running = 0;
    const points = dated.map((item) => ({ date: item.date, value: running += item.pnl }));
    if (points.length === 1) points.unshift({ date: points[0].date, value: 0 });
    const width = 760;
    const height = 190;
    const left = 63;
    const right = 12;
    const top = 13;
    const bottom = 25;
    const values = points.map((point) => point.value);
    const minValue = Math.min(0, ...values);
    const maxValue = Math.max(0, ...values);
    const span = maxValue - minValue || 1;
    const padding = span * 0.12;
    const low = minValue - padding;
    const high = maxValue + padding;
    const x = (index) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
    const y = (value) => top + ((high - value) / (high - low)) * (height - top - bottom);
    const linePoints = points.map((point, index) => `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const zeroY = y(0);
    const grid = Array.from({ length: 4 }, (_, index) => {
      const value = high - ((high - low) * index / 3);
      const gridY = y(value);
      return `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" stroke="#25344a" stroke-width="1"/><text x="${left - 9}" y="${(gridY + 3).toFixed(1)}" fill="#718099" font-size="9" text-anchor="end">${escapeSvgText(formatMoneyInCurrency(value, tradeCurrency(dated[0].trade), { compact: true }))}</text>`;
    }).join("");
    const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    const dateLabels = labelIndices.map((index) => `<text x="${x(index).toFixed(1)}" y="${height - 5}" fill="#718099" font-size="9" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}">${escapeSvgText(displayDate(points[index].date, { month: "short", year: "2-digit" }))}</text>`).join("");
    const last = points[points.length - 1];
    const stroke = last.value >= 0 ? "#42c997" : "#f17478";
    const area = `${left},${zeroY.toFixed(1)} ${linePoints} ${width - right},${zeroY.toFixed(1)}`;
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Cumulative realized profit and loss equity curve"><defs><linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${stroke}" stop-opacity=".20"/><stop offset="100%" stop-color="${stroke}" stop-opacity=".01"/></linearGradient></defs>${grid}<line x1="${left}" y1="${zeroY.toFixed(1)}" x2="${width - right}" y2="${zeroY.toFixed(1)}" stroke="#6e7a8e" stroke-dasharray="3 4" stroke-width="1"/><polygon points="${area}" fill="url(#equity-fill)"/><polyline points="${linePoints}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dateLabels}</svg>`;
  }

  function renderMonthlyChart(closed) {
    const container = $("#monthly-chart");
    if (!container) return;
    const now = new Date();
    const months = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      months.push({ year: date.getFullYear(), month: date.getMonth(), label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date), value: 0, count: 0 });
    }
    closed.forEach((item) => {
      if (!item.date) return;
      const month = months.find((candidate) => candidate.year === item.date.getFullYear() && candidate.month === item.date.getMonth());
      if (month) { month.value += item.pnl; month.count += 1; }
    });
    if (!closed.length) {
      renderEmptyChart(container, "Monthly results will appear after closed trades are saved.");
      return;
    }
    if (new Set(closed.map((item) => tradeCurrency(item.trade))).size > 1) {
      renderEmptyChart(container, "Monthly performance needs one currency at a time. Saved closed trades contain multiple currencies, which are not converted.");
      return;
    }
    const width = 460;
    const height = 190;
    const top = 12;
    const bottom = 28;
    const baseline = top + (height - top - bottom) / 2;
    const maxAbs = Math.max(1, ...months.map((month) => Math.abs(month.value)));
    const maxBarHeight = (height - top - bottom) * .42;
    const barWidth = 27;
    const gap = 30;
    const startX = (width - (months.length * barWidth + (months.length - 1) * gap)) / 2;
    const bars = months.map((month, index) => {
      const barHeight = month.value === 0 ? 2 : Math.max(3, Math.abs(month.value) / maxAbs * maxBarHeight);
      const x = startX + index * (barWidth + gap);
      const y = month.value >= 0 ? baseline - barHeight : baseline;
      const color = month.value > 0 ? "#42c997" : month.value < 0 ? "#f17478" : "#39485e";
      return `<rect x="${x}" y="${y.toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" rx="4" fill="${color}" opacity="${month.count ? ".92" : ".48"}"><title>${escapeSvgText(month.label)}: ${escapeSvgText(formatMoneyInCurrency(month.value, tradeCurrency(closed[0].trade)))} (${month.count} trades)</title></rect><text x="${x + barWidth / 2}" y="${height - 6}" fill="#718099" font-size="9" text-anchor="middle">${escapeSvgText(month.label)}</text>`;
    }).join("");
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Monthly realized profit and loss for the last six calendar months"><line x1="17" y1="${baseline.toFixed(1)}" x2="${width - 8}" y2="${baseline.toFixed(1)}" stroke="#344257" stroke-width="1"/>${bars}</svg>`;
  }

  function renderRecentTrades(trades) {
    const body = $("#recent-trades");
    if (!body) return;
    body.replaceChildren();
    const latest = [...trades].sort((a, b) => (tradeDate(b)?.getTime() || 0) - (tradeDate(a)?.getTime() || 0)).slice(0, 5);
    if (!latest.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "table-empty";
      cell.textContent = "Your saved trades will appear here.";
      row.append(cell);
      body.append(row);
      return;
    }
    latest.forEach((trade) => {
      const row = document.createElement("tr");
      const symbolCell = document.createElement("td");
      symbolCell.className = "trade-symbol";
      symbolCell.textContent = safeText(trade.symbol, "Unknown symbol");
      const dateCell = document.createElement("td");
      dateCell.textContent = tradeDate(trade) ? displayDate(tradeDate(trade)) : "Date not set";
      const resultCell = document.createElement("td");
      const pnl = tradeProfitLoss(trade);
      resultCell.textContent = pnl === null ? "—" : formatTradeMoney(pnl, trade);
      if (pnl !== null) resultCell.className = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "";
      const outcomeCell = document.createElement("td");
      const pill = document.createElement("span");
      const outcome = safeText(trade.outcome, pnl === null ? "Open" : pnl > 0 ? "Win" : pnl < 0 ? "Loss" : "Breakeven");
      pill.className = `outcome-pill${outcome.toLowerCase() === "win" ? " win" : outcome.toLowerCase() === "loss" ? " loss" : ""}`;
      pill.textContent = outcome;
      outcomeCell.append(pill);
      row.append(symbolCell, dateCell, resultCell, outcomeCell);
      body.append(row);
    });
  }

  function renderActivity(trades) {
    const list = $("#activity-list");
    if (!list) return;
    list.replaceChildren();
    const counts = new Map();
    trades.forEach((trade) => {
      const date = tradeDate(trade);
      if (!date) return;
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const today = new Date();
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      return { date, count: counts.get(key) || 0 };
    });
    const maxCount = Math.max(1, ...days.map((day) => day.count));
    if (!days.some((day) => day.count)) {
      const empty = document.createElement("p");
      empty.className = "activity-empty";
      empty.textContent = trades.length ? "No dated entries in the last 7 days." : "Activity will appear after you add trades.";
      list.append(empty);
      return;
    }
    days.forEach((day) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const date = document.createElement("span");
      date.textContent = displayDate(day.date, { weekday: "short", month: "short", day: "numeric" });
      const track = document.createElement("span");
      track.className = "activity-bar-track";
      const bar = document.createElement("span");
      bar.className = "activity-bar";
      bar.style.display = "block";
      bar.style.width = `${day.count ? Math.max(7, (day.count / maxCount) * 100) : 0}%`;
      track.append(bar);
      const count = document.createElement("span");
      count.className = "activity-count";
      count.textContent = String(day.count);
      row.append(date, track, count);
      list.append(row);
    });
  }

  function renderDashboard() {
    const trades = currentTrades();
    const closed = closedTrades(trades);
    updateHeader();
    updateMetrics(trades);
    renderEquityChart(closed);
    renderMonthlyChart(closed);
    renderRecentTrades(trades);
    renderActivity(trades);
  }

  const TRADE_FIELDS = [
    "dateTime", "symbol", "direction", "entryPrice", "exitPrice", "stopLoss", "takeProfit",
    "lotSize", "currency", "profitLoss", "outcome", "session", "strategy", "setup",
    "entryReason", "exitReason", "emotions", "mistakes", "lessons"
  ];
  const VALID_OUTCOMES = ["Open", "Win", "Loss", "Breakeven"];
  let journalStorageError = false;
  let viewingTradeId = null;

  function createTradeId() {
    return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `trade-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function readJournalTrades() {
    journalStorageError = false;
    let parsed;
    try {
      const stored = localStorage.getItem(TRADES_KEY);
      parsed = stored ? JSON.parse(stored) : [];
    } catch (error) {
      journalStorageError = true;
      console.error("GoldTrack could not read the saved trade records:", error);
      return { trades: [], changed: false, invalidCount: 0 };
    }
    if (!Array.isArray(parsed)) {
      journalStorageError = true;
      return { trades: [], changed: false, invalidCount: 1 };
    }
    let changed = false;
    let invalidCount = 0;
    const usedIds = new Set();
    const trades = parsed.map((trade, index) => {
      if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
        invalidCount += 1;
        return null;
      }
      const normalized = { ...trade };
      if (!normalized.id || usedIds.has(String(normalized.id))) {
        normalized.id = createTradeId();
        changed = true;
      }
      normalized.id = String(normalized.id);
      usedIds.add(normalized.id);
      // Preserve legacy records and all unknown fields; only add the stable ID
      // the journal needs for safe edit and delete operations.
      return normalized;
    }).filter(Boolean);
    if (invalidCount) {
      // Do not write back a filtered list: that could destroy unrecognized saved data.
      journalStorageError = true;
      return { trades, changed: false, invalidCount };
    }
    if (changed) {
      try {
        localStorage.setItem(TRADES_KEY, JSON.stringify(trades));
      } catch (error) {
        journalStorageError = true;
        console.error("GoldTrack could not add identifiers to older journal records:", error);
      }
    }
    return { trades, changed, invalidCount };
  }

  function persistJournalTrades(trades) {
    if (journalStorageError) {
      showToast("Journal storage has invalid or unreadable records. Export or inspect your browser data before changing it.");
      return false;
    }
    try {
      localStorage.setItem(TRADES_KEY, JSON.stringify(trades));
      setText("#save-status", "Saved locally");
      renderDashboard();
      renderJournal();
      renderAnalytics();
      updateDailyRiskStatus();
      return true;
    } catch (error) {
      console.error("GoldTrack could not save journal changes:", error);
      setText("#save-status", "Save failed");
      showToast(error && error.name === "QuotaExceededError"
        ? "Browser storage is full. Remove a screenshot or export and delete old records before saving."
        : "Could not save this change in browser storage. Your previous records were kept.");
      return false;
    }
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function formatPrice(value) {
    const number = Number(value);
    return value !== "" && value !== null && value !== undefined && Number.isFinite(number)
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(number)
      : "—";
  }

  function tradeSearchText(trade) {
    return [trade.symbol, trade.strategy, trade.setup, trade.session, trade.entryReason, trade.exitReason, trade.emotions, trade.mistakes, trade.lessons]
      .map((value) => String(value || "").toLowerCase()).join(" ");
  }

  function getFilteredTrades(trades) {
    const query = $("#trade-search").value.trim().toLowerCase();
    const from = $("#filter-date-from").value;
    const to = $("#filter-date-to").value;
    const direction = $("#filter-direction").value;
    const status = $("#filter-status").value;
    const strategy = $("#filter-strategy").value;
    const sort = $("#trade-sort").value;
    const filtered = trades.filter((trade) => {
      const dateKey = String(trade.dateTime || trade.date || "").slice(0, 10);
      const outcome = safeText(trade.outcome, tradeProfitLoss(trade) === null ? "Open" : tradeProfitLoss(trade) > 0 ? "Win" : tradeProfitLoss(trade) < 0 ? "Loss" : "Breakeven");
      return (!query || tradeSearchText(trade).includes(query))
        && (!from || (dateKey && dateKey >= from))
        && (!to || (dateKey && dateKey <= to))
        && (!direction || String(trade.direction || "").toLowerCase() === direction.toLowerCase())
        && (!status || outcome.toLowerCase() === status.toLowerCase())
        && (!strategy || String(trade.strategy || "") === strategy);
    });
    filtered.sort((a, b) => {
      if (sort.startsWith("pnl")) {
        const left = tradeProfitLoss(a);
        const right = tradeProfitLoss(b);
        const leftValue = left === null ? (sort === "pnl-asc" ? Infinity : -Infinity) : left;
        const rightValue = right === null ? (sort === "pnl-asc" ? Infinity : -Infinity) : right;
        return sort === "pnl-asc" ? leftValue - rightValue : rightValue - leftValue;
      }
      const dateDifference = (tradeDate(a)?.getTime() || 0) - (tradeDate(b)?.getTime() || 0);
      return sort === "date-asc" ? dateDifference : -dateDifference;
    });
    return filtered;
  }

  function appendCell(row, value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    row.append(cell);
    return cell;
  }

  function actionButton(label, action, tradeId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "table-action";
    button.dataset.tradeAction = action;
    button.dataset.tradeId = tradeId;
    button.textContent = label;
    button.setAttribute("aria-label", `${label} trade`);
    return button;
  }

  function updateStrategyFilter(trades) {
    const select = $("#filter-strategy");
    const selected = select.value;
    const strategies = [...new Set(trades.map((trade) => String(trade.strategy || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.replaceChildren(new Option("All strategies", ""));
    strategies.forEach((strategy) => select.add(new Option(strategy, strategy)));
    if (strategies.includes(selected)) select.value = selected;
  }

  function renderJournal() {
    const { trades } = readJournalTrades();
    updateStrategyFilter(trades);
    const filtered = getFilteredTrades(trades);
    const body = $("#trade-history-body");
    body.replaceChildren();
    filtered.forEach((trade) => {
      const row = document.createElement("tr");
      const outcome = safeText(trade.outcome, tradeProfitLoss(trade) === null ? "Open" : tradeProfitLoss(trade) > 0 ? "Win" : tradeProfitLoss(trade) < 0 ? "Loss" : "Breakeven");
      appendCell(row, tradeDate(trade) ? displayDate(tradeDate(trade), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Date not set");
      appendCell(row, safeText(trade.symbol, "—"), "trade-symbol");
      appendCell(row, safeText(trade.direction, "—"), String(trade.direction).toLowerCase() === "sell" ? "negative" : "");
      appendCell(row, formatPrice(trade.entryPrice));
      appendCell(row, formatPrice(trade.exitPrice));
      appendCell(row, formatPrice(trade.stopLoss));
      appendCell(row, formatPrice(trade.takeProfit));
      appendCell(row, formatPrice(trade.lotSize));
      const statusCell = document.createElement("td");
      const status = document.createElement("span");
      status.className = `outcome-pill${outcome.toLowerCase() === "win" ? " win" : outcome.toLowerCase() === "loss" ? " loss" : ""}`;
      status.textContent = outcome;
      statusCell.append(status);
      row.append(statusCell);
      const pnl = tradeProfitLoss(trade);
      appendCell(row, pnl === null ? "—" : formatTradeMoney(pnl, trade), pnl === null ? "" : pnl > 0 ? "positive" : pnl < 0 ? "negative" : "");
      const actions = document.createElement("td");
      actions.className = "table-actions-cell";
      actions.append(actionButton("View", "view", trade.id), actionButton("Edit", "edit", trade.id), actionButton("Delete", "delete", trade.id));
      row.append(actions);
      body.append(row);
    });
    $("#journal-count").textContent = `${trades.length} record${trades.length === 1 ? "" : "s"}`;
    $("#shown-trades-label").textContent = `Showing ${filtered.length} of ${trades.length} trade${trades.length === 1 ? "" : "s"}`;
    const empty = $("#journal-empty");
    empty.hidden = filtered.length > 0;
    $("#journal-empty-title").textContent = trades.length ? "No trades match these filters" : "No trades recorded yet";
    $("#journal-empty-message").textContent = trades.length
      ? "Try changing your search or filters to see saved records."
      : "Start your journal with a trade record. Your dashboard will update from saved closed trades.";
    const invalid = journalStorageError;
    if (invalid) {
      setText("#save-status", "Check local data");
      showToast("Some saved journal data is unreadable. The original stored value has not been overwritten.");
    }
  }

  function toggleTradeForm(show) {
    const editor = $("#trade-editor");
    editor.hidden = !show;
    if (show) {
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => $("#trade-date").focus(), 150);
    }
  }

  function setTradeCurrency(value) {
    const select = $("#trade-currency");
    const code = String(value || "USD").trim().toUpperCase();
    if (!Array.from(select.options).some((option) => option.value === code) && /^[A-Z]{3}$/.test(code)) {
      select.add(new Option(`${code} — custom`, code));
    }
    select.value = /^[A-Z]{3}$/.test(code) ? code : "USD";
  }

  function resetTradeForm() {
    $("#trade-form").reset();
    $("#trade-id").value = "";
    $("#trade-symbol").value = "XAUUSD";
    $("#trade-direction").value = "Buy";
    $("#trade-outcome").value = "Open";
    setTradeCurrency(currencyCode());
    $("#trade-date").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $("#trade-screenshot").value = "";
    $("#existing-attachment").hidden = true;
    $("#remove-attachment-wrap").hidden = true;
    $("#remove-attachment").checked = false;
    $("#trade-form-error").hidden = true;
    $("#trade-form-title").textContent = "Add a trade";
    $("#save-trade-button").textContent = "Save trade";
  }

  function openNewTradeForm() {
    resetTradeForm();
    toggleTradeForm(true);
  }

  function editTrade(trade) {
    resetTradeForm();
    $("#trade-id").value = trade.id;
    $("#trade-date").value = String(trade.dateTime || "").slice(0, 16);
    $("#trade-symbol").value = safeText(trade.symbol, "XAUUSD");
    $("#trade-direction").value = trade.direction === "Sell" ? "Sell" : "Buy";
    $("#trade-outcome").value = VALID_OUTCOMES.includes(trade.outcome) ? trade.outcome : "Open";
    $("#trade-entry").value = valueOrEmpty(trade.entryPrice);
    $("#trade-exit").value = valueOrEmpty(trade.exitPrice);
    $("#trade-stop").value = valueOrEmpty(trade.stopLoss);
    $("#trade-target").value = valueOrEmpty(trade.takeProfit);
    $("#trade-lots").value = valueOrEmpty(trade.lotSize);
    setTradeCurrency(safeText(trade.currency, currencyCode()));
    $("#trade-pnl").value = valueOrEmpty(trade.profitLoss);
    $("#trade-session").value = valueOrEmpty(trade.session);
    $("#trade-strategy").value = valueOrEmpty(trade.strategy);
    $("#trade-setup").value = valueOrEmpty(trade.setup);
    $("#trade-entry-reason").value = valueOrEmpty(trade.entryReason);
    $("#trade-exit-reason").value = valueOrEmpty(trade.exitReason);
    $("#trade-emotions").value = valueOrEmpty(trade.emotions);
    $("#trade-mistakes").value = valueOrEmpty(trade.mistakes);
    $("#trade-lessons").value = valueOrEmpty(trade.lessons);
    const hasScreenshot = Boolean(trade.screenshotData);
    $("#existing-attachment").hidden = !hasScreenshot;
    $("#remove-attachment-wrap").hidden = !hasScreenshot;
    $("#trade-form-title").textContent = "Edit trade";
    $("#save-trade-button").textContent = "Save changes";
    toggleTradeForm(true);
  }

  function validateTrade(trade) {
    if (!trade.dateTime || Number.isNaN(new Date(trade.dateTime).getTime())) return "Enter a valid trade date and time.";
    if (!trade.symbol || trade.symbol.length > 30) return "Enter a symbol of 1–30 characters.";
    if (!["Buy", "Sell"].includes(trade.direction)) return "Choose Buy or Sell.";
    if (!VALID_OUTCOMES.includes(trade.outcome)) return "Choose a valid trade status.";
    if (!Number.isFinite(Number(trade.entryPrice)) || Number(trade.entryPrice) <= 0) return "Entry price must be greater than zero.";
    if (!Number.isFinite(Number(trade.lotSize)) || Number(trade.lotSize) <= 0) return "Lot size must be greater than zero.";
    for (const field of ["exitPrice", "stopLoss", "takeProfit"]) {
      if (trade[field] !== "" && (!Number.isFinite(Number(trade[field])) || Number(trade[field]) <= 0)) return `${field === "exitPrice" ? "Exit price" : field === "stopLoss" ? "Stop-loss" : "Take-profit"} must be greater than zero.`;
    }
    if (trade.outcome !== "Open" && (trade.profitLoss === "" || !Number.isFinite(Number(trade.profitLoss)))) return "Enter the actual profit or loss for a closed trade.";
    if (!/^[A-Z]{3}$/.test(trade.currency)) return "Select a valid three-letter account currency.";
    return "";
  }

  function compressScreenshot(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("Choose a valid image file for the screenshot."));
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        reject(new Error("The selected image is over 12 MB. Choose a smaller image."));
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const maxDimension = 1400;
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) { reject(new Error("This browser could not prepare the screenshot.")); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.72);
        if (data.length > 550000) {
          reject(new Error("Compressed screenshot is still too large. Choose a smaller or simpler image."));
          return;
        }
        resolve({ screenshotData: data, screenshotName: file.name.slice(0, 120), screenshotType: "image/jpeg" });
      };
      image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("The selected image could not be opened.")); };
      image.src = objectUrl;
    });
  }

  async function saveTradeFromForm(event) {
    event.preventDefault();
    const errorElement = $("#trade-form-error");
    errorElement.hidden = true;
    const formData = new FormData($("#trade-form"));
    const id = String(formData.get("id") || createTradeId());
    const oldRecord = readJournalTrades().trades.find((trade) => trade.id === id);
    const trade = { ...(oldRecord || {}), id };
    TRADE_FIELDS.forEach((field) => {
      const raw = formData.get(field);
      if (["entryPrice", "exitPrice", "stopLoss", "takeProfit", "lotSize", "profitLoss"].includes(field)) {
        trade[field] = raw === "" ? "" : Number(raw);
      } else {
        trade[field] = String(raw || "").trim();
      }
    });
    if (trade.outcome === "Open") trade.profitLoss = trade.profitLoss === "" ? "" : trade.profitLoss;
    const validation = validateTrade(trade);
    if (validation) { errorElement.textContent = validation; errorElement.hidden = false; return; }
    const screenshotFile = $("#trade-screenshot").files[0];
    try {
      if (screenshotFile) Object.assign(trade, await compressScreenshot(screenshotFile));
      else if ($("#remove-attachment").checked) {
        delete trade.screenshotData;
        delete trade.screenshotName;
        delete trade.screenshotType;
      }
    } catch (error) {
      errorElement.textContent = error.message || "Could not prepare this screenshot.";
      errorElement.hidden = false;
      return;
    }
    const { trades } = readJournalTrades();
    if (journalStorageError) {
      errorElement.textContent = "Saved data could not safely be updated. No changes were made.";
      errorElement.hidden = false;
      return;
    }
    const existingIndex = trades.findIndex((record) => record.id === id);
    if (existingIndex >= 0) trades[existingIndex] = trade;
    else trades.push(trade);
    if (persistJournalTrades(trades)) {
      toggleTradeForm(false);
      resetTradeForm();
      showToast(existingIndex >= 0 ? "Trade changes saved." : "Trade saved to this browser.");
    }
  }

  function fillDetailField(container, label, value) {
    const item = document.createElement("div");
    item.className = "detail-item";
    const title = document.createElement("span");
    title.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value || "—";
    item.append(title, content);
    container.append(item);
  }

  function viewTrade(trade) {
    viewingTradeId = trade.id;
    const content = $("#trade-detail-content");
    content.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    const values = [
      ["Date and time", tradeDate(trade) ? displayDate(tradeDate(trade), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"],
      ["Symbol", safeText(trade.symbol)], ["Direction", safeText(trade.direction)], ["Status", safeText(trade.outcome)],
      ["Entry", formatPrice(trade.entryPrice)], ["Exit", formatPrice(trade.exitPrice)], ["Stop-loss", formatPrice(trade.stopLoss)],
      ["Take-profit", formatPrice(trade.takeProfit)], ["Lot size", formatPrice(trade.lotSize)], ["Account currency", safeText(trade.currency, "USD")],
      ["Actual P/L", tradeProfitLoss(trade) === null ? "—" : formatTradeMoney(tradeProfitLoss(trade), trade)], ["Session", safeText(trade.session)],
      ["Strategy", safeText(trade.strategy)], ["Setup", safeText(trade.setup)], ["Entry reason", safeText(trade.entryReason)],
      ["Exit reason", safeText(trade.exitReason)], ["Emotions", safeText(trade.emotions)], ["Mistakes", safeText(trade.mistakes)],
      ["Lessons learned", safeText(trade.lessons)]
    ];
    values.forEach(([label, value]) => fillDetailField(grid, label, value));
    content.append(grid);
    if (trade.screenshotData && /^data:image\/(jpeg|png|webp);base64,/i.test(String(trade.screenshotData))) {
      const figure = document.createElement("figure");
      figure.className = "detail-screenshot";
      const caption = document.createElement("figcaption");
      caption.textContent = safeText(trade.screenshotName, "Trade screenshot");
      const image = document.createElement("img");
      image.src = trade.screenshotData;
      image.alt = "Attached trade screenshot";
      figure.append(caption, image);
      content.append(figure);
    }
    $("#trade-detail-dialog").showModal();
  }

  function findTrade(id) {
    return readJournalTrades().trades.find((trade) => trade.id === id);
  }

  function handleTradeAction(event) {
    const button = event.target.closest("button[data-trade-action]");
    if (!button) return;
    const trade = findTrade(button.dataset.tradeId);
    if (!trade) { showToast("That trade record could not be found."); renderJournal(); return; }
    if (button.dataset.tradeAction === "view") viewTrade(trade);
    if (button.dataset.tradeAction === "edit") editTrade(trade);
    if (button.dataset.tradeAction === "delete") {
      if (!window.confirm(`Delete the ${safeText(trade.symbol, "selected")} trade from ${tradeDate(trade) ? displayDate(tradeDate(trade)) : "an unknown date"}? This cannot be undone.`)) return;
      const { trades } = readJournalTrades();
      if (persistJournalTrades(trades.filter((record) => record.id !== trade.id))) showToast("Trade deleted.");
    }
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // Keep the object URL alive long enough for the browser to start saving it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    // Prevent spreadsheet apps from evaluating user-entered notes as formulas.
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const { trades } = readJournalTrades();
    if (journalStorageError) { showToast("Cannot export while saved journal data is unreadable."); return; }
    const headers = ["id", ...TRADE_FIELDS];
    const rows = [headers, ...trades.map((trade) => headers.map((field) => trade[field] ?? ""))];
    downloadFile(`goldtrack-trades-${new Date().toISOString().slice(0, 10)}.csv`, `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
    showToast("CSV export downloaded. Screenshot images are not included in CSV.");
  }

  function exportJson() {
    const { trades } = readJournalTrades();
    if (journalStorageError) { showToast("Cannot create a backup while saved journal data is unreadable."); return; }
    downloadFile(`goldtrack-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "GoldTrack", version: 1, exportedAt: new Date().toISOString(), trades }, null, 2), "application/json;charset=utf-8");
    showToast("JSON backup downloaded, including compressed screenshots when present.");
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else field += character;
      } else if (character === '"' && field === "") quoted = true;
      else if (character === ",") { row.push(field); field = ""; }
      else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field); field = "";
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
      } else field += character;
    }
    if (quoted) throw new Error("CSV has an unclosed quoted field.");
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    if (rows.length < 2) throw new Error("CSV must include a header and at least one trade row.");
    const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").trim());
    return rows.map((cells, index) => {
      const record = {};
      headers.forEach((header, column) => { record[header] = cells[column] ?? ""; });
      record._rowNumber = index + 2;
      return record;
    });
  }

  function stableImportId(record) {
    const signature = TRADE_FIELDS.map((field) => String(record[field] ?? "")).join("\u001f");
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < signature.length; index += 1) {
      const code = signature.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489917);
    }
    return `import-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}-${signature.length.toString(16)}`;
  }

  function validateImportedTrade(record, rowNumber) {
    const trade = { ...record };
    delete trade._rowNumber;
    trade.id = String(trade.id || stableImportId(trade));
    trade.symbol = String(trade.symbol || "").trim().toUpperCase();
    trade.direction = String(trade.direction || "").trim();
    trade.outcome = String(trade.outcome || "").trim();
    trade.currency = String(trade.currency || "USD").trim().toUpperCase();
    trade.dateTime = String(trade.dateTime || trade.date || "").trim();
    if (!trade.dateTime || Number.isNaN(new Date(trade.dateTime).getTime())) throw new Error(`Row ${rowNumber}: invalid or missing dateTime.`);
    if (!trade.symbol || trade.symbol.length > 30) throw new Error(`Row ${rowNumber}: invalid or missing symbol.`);
    if (!["Buy", "Sell"].includes(trade.direction)) throw new Error(`Row ${rowNumber}: direction must be Buy or Sell.`);
    if (!VALID_OUTCOMES.includes(trade.outcome)) throw new Error(`Row ${rowNumber}: status must be Open, Win, Loss, or Breakeven.`);
    for (const field of ["entryPrice", "lotSize"]) {
      if (trade[field] === "" || !Number.isFinite(Number(trade[field])) || Number(trade[field]) <= 0) throw new Error(`Row ${rowNumber}: ${field} must be greater than zero.`);
      trade[field] = Number(trade[field]);
    }
    for (const field of ["exitPrice", "stopLoss", "takeProfit", "profitLoss"]) {
      if (trade[field] === "" || trade[field] === null || trade[field] === undefined) trade[field] = "";
      else if (!Number.isFinite(Number(trade[field]))) throw new Error(`Row ${rowNumber}: ${field} must be a number.`);
      else trade[field] = Number(trade[field]);
    }
    if (trade.outcome !== "Open" && trade.profitLoss === "") throw new Error(`Row ${rowNumber}: closed trades require manually entered actual profitLoss.`);
    if (!/^[A-Z]{3}$/.test(trade.currency)) throw new Error(`Row ${rowNumber}: currency must be a three-letter currency code.`);
    if (trade.screenshotData !== undefined && trade.screenshotData !== "") {
      if (typeof trade.screenshotData !== "string" || trade.screenshotData.length > 550000 || !/^data:image\/(jpeg|png|webp);base64,/i.test(trade.screenshotData)) {
        throw new Error(`Row ${rowNumber}: screenshot must be a supported, compressed image smaller than 550 KB.`);
      }
    }
    TRADE_FIELDS.forEach((field) => {
      if (!(field in trade)) trade[field] = "";
    });
    return trade;
  }

  async function handleImport(file, kind) {
    if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("Import files must be smaller than 15 MB.");
      const text = await file.text();
      let records;
      if (kind === "csv") records = parseCsv(text);
      else {
        const parsed = JSON.parse(text);
        records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.trades) ? parsed.trades : null;
        if (!records) throw new Error("JSON backup must be a trade array or an object containing a trades array.");
        if (!records.length) throw new Error("This backup contains no trade records.");
      }
      if (records.length > 10000) throw new Error("Import is limited to 10,000 trade rows at a time.");
      const validated = records.map((record, index) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Row ${index + 2}: record must be an object.`);
        return validateImportedTrade(record, record._rowNumber || index + 2);
      });
      if (!window.confirm(`Import ${validated.length} validated trade record(s)? Matching IDs and repeated rows without IDs will be skipped. Existing records will not be replaced.`)) return;
      const { trades: current } = readJournalTrades();
      if (journalStorageError) throw new Error("Current saved data is unreadable, so it cannot safely be merged.");
      const ids = new Set(current.map((trade) => String(trade.id)));
      const unique = validated.filter((trade) => {
        if (ids.has(trade.id)) return false;
        ids.add(trade.id);
        return true;
      });
      if (!unique.length) { showToast("No new records imported; all IDs already exist."); return; }
      if (persistJournalTrades([...current, ...unique])) showToast(`Imported ${unique.length} record(s); ${validated.length - unique.length} duplicate(s) skipped.`);
    } catch (error) {
      console.error("GoldTrack import failed:", error);
      showToast(error.message || "Could not import this file. Check its format and values.");
    } finally {
      $(kind === "csv" ? "#csv-file-input" : "#json-file-input").value = "";
    }
  }

  function bindJournalEvents() {
    $("#new-trade-button").addEventListener("click", openNewTradeForm);
    $("#empty-add-trade").addEventListener("click", openNewTradeForm);
    $("#close-trade-form").addEventListener("click", () => toggleTradeForm(false));
    $("#cancel-trade-button").addEventListener("click", () => { toggleTradeForm(false); resetTradeForm(); });
    $("#trade-form").addEventListener("submit", saveTradeFromForm);
    $("#trade-history-body").addEventListener("click", handleTradeAction);
    ["#trade-search", "#filter-date-from", "#filter-date-to", "#filter-direction", "#filter-status", "#filter-strategy", "#trade-sort"].forEach((selector) => {
      $(selector).addEventListener(selector === "#trade-search" ? "input" : "change", renderJournal);
    });
    $("#clear-trade-filters").addEventListener("click", () => {
      $("#trade-search").value = "";
      $("#filter-date-from").value = "";
      $("#filter-date-to").value = "";
      $("#filter-direction").value = "";
      $("#filter-status").value = "";
      $("#filter-strategy").value = "";
      $("#trade-sort").value = "date-desc";
      renderJournal();
    });
    $("#export-csv-button").addEventListener("click", exportCsv);
    $("#export-json-button").addEventListener("click", exportJson);
    $("#import-csv-button").addEventListener("click", () => $("#csv-file-input").click());
    $("#restore-json-button").addEventListener("click", () => $("#json-file-input").click());
    $("#csv-file-input").addEventListener("change", (event) => handleImport(event.target.files[0], "csv"));
    $("#json-file-input").addEventListener("change", (event) => handleImport(event.target.files[0], "json"));
    $("#close-detail-dialog").addEventListener("click", () => $("#trade-detail-dialog").close());
    $("#detail-close-button").addEventListener("click", () => $("#trade-detail-dialog").close());
    $("#detail-edit-button").addEventListener("click", () => {
      const trade = findTrade(viewingTradeId);
      $("#trade-detail-dialog").close();
      if (trade) editTrade(trade);
    });
    $("#trade-screenshot").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file && file.size > 12 * 1024 * 1024) {
        event.target.value = "";
        showToast("Choose a screenshot under 12 MB before compression.");
      }
    });
  }

  function analyticsPnl(trade) {
    if (!trade || (typeof trade.profitLoss !== "number" && typeof trade.profitLoss !== "string")) return null;
    if (typeof trade.profitLoss === "string" && trade.profitLoss.trim() === "") return null;
    const value = Number(trade.profitLoss);
    return Number.isFinite(value) ? value : null;
  }

  function analyticsCurrency(trade) {
    const code = String(trade.currency || currencyCode()).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : currencyCode();
  }

  function analyticsClosedRecords(trades) {
    let invalidResults = 0;
    const allowed = new Set(["open", "win", "loss", "breakeven"]);
    const closed = [];
    trades.forEach((trade, storageIndex) => {
      const outcome = String(trade.outcome || "").trim().toLowerCase();
      if (outcome === "open") return;
      if (!allowed.has(outcome)) { invalidResults += 1; return; }
      const pnl = analyticsPnl(trade);
      if (pnl === null) { invalidResults += 1; return; }
      closed.push({ trade, pnl, date: tradeDate(trade), storageIndex, currency: analyticsCurrency(trade) });
    });
    return { closed, invalidResults };
  }

  function localDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function updateAnalyticsOptions(trades, selector, property, allLabel, normalize = (value) => String(value || "").trim()) {
    const select = $(selector);
    const selected = select.value;
    const values = [...new Set(trades.map((trade) => normalize(trade[property])).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.replaceChildren(new Option(allLabel, ""));
    values.forEach((value) => select.add(new Option(value, value)));
    if (values.includes(selected)) select.value = selected;
  }

  function filterAnalyticsRecords(trades) {
    const from = $("#analytics-date-from").value;
    const to = $("#analytics-date-to").value;
    const symbol = $("#analytics-symbol").value;
    const direction = $("#analytics-direction").value;
    const strategy = $("#analytics-strategy").value;
    const session = $("#analytics-session").value;
    const currency = $("#analytics-currency").value;
    const invalidRange = Boolean(from && to && from > to);
    const filtered = invalidRange ? [] : trades.filter((trade) => {
      const dateKey = localDateKey(tradeDate(trade));
      return (!from || (dateKey && dateKey >= from))
        && (!to || (dateKey && dateKey <= to))
        && (!symbol || String(trade.symbol || "").trim().toUpperCase() === symbol)
        && (!direction || String(trade.direction || "").trim().toLowerCase() === direction.toLowerCase())
        && (!strategy || String(trade.strategy || "").trim() === strategy)
        && (!session || String(trade.session || "").trim() === session)
        && (!currency || analyticsCurrency(trade) === currency);
    });
    return { filtered, invalidRange };
  }

  function updateAnalyticsMetric(id, value, className = "") {
    const element = $(id);
    if (!element) return;
    element.textContent = value;
    element.classList.remove("positive", "negative");
    if (className) element.classList.add(className);
  }

  function analyticsCurrencyFor(values) {
    const currencies = new Set(values.map((item) => item.currency));
    return currencies.size === 1 ? currencies.values().next().value : null;
  }

  function calculateAnalytics(trades) {
    const { closed, invalidResults } = analyticsClosedRecords(trades);
    const wins = closed.filter((item) => item.pnl > 0);
    const losses = closed.filter((item) => item.pnl < 0);
    const breakevens = closed.filter((item) => item.pnl === 0);
    const grossProfit = wins.reduce((sum, item) => sum + item.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, item) => sum + item.pnl, 0));
    const currencies = new Set(closed.map((item) => item.currency));
    const singleCurrency = currencies.size === 1 ? currencies.values().next().value : null;
    const chronological = [...closed].filter((item) => item.date).sort((a, b) => a.date - b.date || a.storageIndex - b.storageIndex);
    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const equityPoints = chronological.map((item) => {
      running += item.pnl;
      peak = Math.max(peak, running);
      maxDrawdown = Math.max(maxDrawdown, peak - running);
      return { ...item, equity: running };
    });

    let currentType = "breakeven";
    let currentStreak = 0;
    let longestWin = 0;
    let longestLoss = 0;
    let runType = "";
    let runLength = 0;
    chronological.forEach((item) => {
      const type = item.pnl > 0 ? "win" : item.pnl < 0 ? "loss" : "breakeven";
      if (type === runType && type !== "breakeven") runLength += 1;
      else runLength = type === "breakeven" ? 0 : 1;
      runType = type;
      if (type === "win") longestWin = Math.max(longestWin, runLength);
      if (type === "loss") longestLoss = Math.max(longestLoss, runLength);
    });
    if (chronological.length) {
      currentType = chronological[chronological.length - 1].pnl > 0 ? "win" : chronological[chronological.length - 1].pnl < 0 ? "loss" : "breakeven";
      if (currentType !== "breakeven") {
        for (let index = chronological.length - 1; index >= 0; index -= 1) {
          const type = chronological[index].pnl > 0 ? "win" : chronological[index].pnl < 0 ? "loss" : "breakeven";
          if (type !== currentType) break;
          currentStreak += 1;
        }
      }
    }
    const largestWin = wins.length ? wins.reduce((best, item) => item.pnl > best.pnl ? item : best) : null;
    const largestLoss = losses.length ? losses.reduce((worst, item) => item.pnl < worst.pnl ? item : worst) : null;
    return { closed, wins, losses, breakevens, grossProfit, grossLoss, net: closed.reduce((sum, item) => sum + item.pnl, 0), singleCurrency, currencies, invalidResults, chronological, equityPoints, maxDrawdown, undatedCount: closed.length - chronological.length, longestWin, longestLoss, currentType, currentStreak, largestWin, largestLoss };
  }

  function analyticsEmpty(container, message) {
    container.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = message;
    container.append(empty);
  }

  function drawAnalyticsEquity(stats) {
    const container = $("#analytics-equity-chart");
    if (!stats.closed.length) { analyticsEmpty(container, "Closed trades with valid results will appear here."); return; }
    if (!stats.singleCurrency) { analyticsEmpty(container, "Select one account currency to plot equity. Currency amounts are not converted or added together."); return; }
    if (!stats.equityPoints.length) { analyticsEmpty(container, "Add dates to closed trades to see the chronological equity curve."); return; }
    const points = stats.equityPoints;
    const series = [{ date: points[0].date, equity: 0 }, ...points];
    const width = 900;
    const height = 220;
    const left = 72;
    const right = 16;
    const top = 15;
    const bottom = 27;
    const min = Math.min(0, ...series.map((point) => point.equity));
    const max = Math.max(0, ...series.map((point) => point.equity));
    const range = max - min || 1;
    const pad = range * .12;
    const low = min - pad;
    const high = max + pad;
    const x = (index) => left + index / Math.max(1, series.length - 1) * (width - left - right);
    const y = (value) => top + (high - value) / (high - low) * (height - top - bottom);
    const line = series.map((point, index) => `${x(index).toFixed(1)},${y(point.equity).toFixed(1)}`).join(" ");
    const zeroY = y(0);
    const grid = Array.from({ length: 4 }, (_, index) => {
      const value = high - (high - low) * index / 3;
      const gridY = y(value);
      return `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width-right}" y2="${gridY.toFixed(1)}" stroke="#25344a"/><text x="${left-9}" y="${(gridY+3).toFixed(1)}" fill="#718099" font-size="9" text-anchor="end">${escapeSvgText(formatMoneyInCurrency(value, stats.singleCurrency, { compact: true }))}</text>`;
    }).join("");
    const labelIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
    const labels = labelIndexes.map((index) => `<text x="${x(index).toFixed(1)}" y="${height - 5}" fill="#718099" font-size="9" text-anchor="${index === 0 ? "start" : index === series.length - 1 ? "end" : "middle"}">${escapeSvgText(displayDate(series[index].date, { month: "short", year: "2-digit" }))}</text>`).join("");
    const last = series[series.length - 1].equity;
    const color = last >= 0 ? "#42c997" : "#f17478";
    const area = `${left},${zeroY.toFixed(1)} ${line} ${width-right},${zeroY.toFixed(1)}`;
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Cumulative realized P/L equity curve; max drawdown ${escapeSvgText(formatMoneyInCurrency(stats.maxDrawdown, stats.singleCurrency))}"><defs><linearGradient id="analytics-equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".2"/><stop offset="100%" stop-color="${color}" stop-opacity=".01"/></linearGradient></defs>${grid}<line x1="${left}" y1="${zeroY.toFixed(1)}" x2="${width-right}" y2="${zeroY.toFixed(1)}" stroke="#6e7a8e" stroke-dasharray="3 4"/><polygon points="${area}" fill="url(#analytics-equity-fill)"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${labels}</svg>`;
  }

  function analyticsBucket(date, mode) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (mode === "weekly") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      return { key: localDateKey(start), label: `Week of ${displayDate(start, { month: "short", day: "numeric" })}` };
    }
    if (mode === "monthly") {
      start.setDate(1);
      return { key: `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}`, label: displayDate(start, { month: "short", year: "numeric" }) };
    }
    return { key: localDateKey(start), label: displayDate(start, { month: "short", day: "numeric" }) };
  }

  function drawAnalyticsPeriod(stats) {
    const container = $("#analytics-period-chart");
    if (!stats.closed.length) { analyticsEmpty(container, "Closed trade results will appear here."); return; }
    if (!stats.singleCurrency) { analyticsEmpty(container, "Select one account currency to chart P/L. Currency amounts are not converted or combined."); return; }
    const mode = $("#analytics-period").value;
    const groups = new Map();
    stats.closed.filter((item) => item.date).sort((a, b) => a.date - b.date || a.storageIndex - b.storageIndex).forEach((item) => {
      const bucket = analyticsBucket(item.date, mode);
      const group = groups.get(bucket.key) || { ...bucket, pnl: 0, count: 0 };
      group.pnl += item.pnl;
      group.count += 1;
      groups.set(bucket.key, group);
    });
    const buckets = [...groups.values()].slice(-30);
    if (!buckets.length) { analyticsEmpty(container, "Add dates to closed trades to see period results."); return; }
    const width = 680;
    const height = 205;
    const left = 24;
    const right = 12;
    const top = 13;
    const bottom = 36;
    const baseline = top + (height - top - bottom) / 2;
    const maxAbs = Math.max(1, ...buckets.map((group) => Math.abs(group.pnl)));
    const slot = (width - left - right) / buckets.length;
    const barWidth = Math.min(30, Math.max(5, slot * .52));
    const maxBar = (height - top - bottom) * .42;
    const bars = buckets.map((group, index) => {
      const barHeight = group.pnl === 0 ? 2 : Math.max(3, Math.abs(group.pnl) / maxAbs * maxBar);
      const barX = left + slot * index + (slot - barWidth) / 2;
      const barY = group.pnl >= 0 ? baseline - barHeight : baseline;
      const color = group.pnl > 0 ? "#42c997" : group.pnl < 0 ? "#f17478" : "#39485e";
      const stride = Math.max(1, Math.ceil(buckets.length / 8));
      const label = index % stride === 0 || index === buckets.length - 1
        ? `<text x="${(barX+barWidth/2).toFixed(1)}" y="${height-6}" fill="#718099" font-size="8" text-anchor="middle">${escapeSvgText(group.label)}</text>` : "";
      return `<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" fill="${color}"><title>${escapeSvgText(group.label)} · ${escapeSvgText(formatMoneyInCurrency(group.pnl, stats.singleCurrency))} · ${group.count} trades</title></rect>${label}`;
    }).join("");
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeSvgText(mode)} profit and loss for ${buckets.length} periods"><line x1="${left}" y1="${baseline.toFixed(1)}" x2="${width-right}" y2="${baseline.toFixed(1)}" stroke="#344257"/>${bars}</svg>`;
  }

  function drawDistribution(stats) {
    const container = $("#analytics-distribution-chart");
    const total = stats.closed.length;
    if (!total) { analyticsEmpty(container, "Outcome distribution appears after closed trades are recorded."); return; }
    const segments = [
      { label: "Wins", count: stats.wins.length, color: "#42c997" },
      { label: "Losses", count: stats.losses.length, color: "#f17478" },
      { label: "Breakeven", count: stats.breakevens.length, color: "#e5b95c" }
    ];
    const radius = 47;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    const circles = segments.map((segment) => {
      if (!segment.count) return "";
      const length = circumference * segment.count / total;
      const circle = `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="14" stroke-dasharray="${length.toFixed(2)} ${(circumference-length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"/>`;
      offset += length;
      return circle;
    }).join("");
    const legend = document.createElement("div");
    legend.className = "distribution-legend";
    segments.forEach((segment) => {
      const row = document.createElement("div");
      row.className = "distribution-legend-row";
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.background = segment.color;
      const label = document.createElement("span");
      label.textContent = segment.label;
      const count = document.createElement("strong");
      count.textContent = `${segment.count} · ${((segment.count / total) * 100).toFixed(0)}%`;
      row.append(dot, label, count);
      legend.append(row);
    });
    container.replaceChildren();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 160 160");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${stats.wins.length} wins, ${stats.losses.length} losses, ${stats.breakevens.length} breakeven trades`);
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("cx", "80"); track.setAttribute("cy", "80"); track.setAttribute("r", String(radius));
    track.setAttribute("fill", "none"); track.setAttribute("stroke", "#26354a"); track.setAttribute("stroke-width", "14");
    svg.append(track);
    // Segment attributes are numeric and colors are static constants.
    const segmentHolder = document.createElement("g");
    segmentHolder.innerHTML = circles;
    svg.append(segmentHolder);
    const centerCount = document.createElementNS("http://www.w3.org/2000/svg", "text");
    centerCount.setAttribute("x", "80"); centerCount.setAttribute("y", "77"); centerCount.setAttribute("fill", "#f2f5fa"); centerCount.setAttribute("font-size", "20"); centerCount.setAttribute("font-weight", "700"); centerCount.setAttribute("text-anchor", "middle"); centerCount.textContent = String(total);
    const centerLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    centerLabel.setAttribute("x", "80"); centerLabel.setAttribute("y", "94"); centerLabel.setAttribute("fill", "#8391a6"); centerLabel.setAttribute("font-size", "8"); centerLabel.setAttribute("text-anchor", "middle"); centerLabel.textContent = "CLOSED";
    svg.append(centerCount, centerLabel);
    container.append(svg, legend);
  }

  function drawGroupChart(container, trades, property, stats, emptyMessage) {
    const closed = analyticsClosedRecords(trades).closed;
    if (!closed.length) { analyticsEmpty(container, emptyMessage); return; }
    const groups = new Map();
    closed.forEach((item) => {
      const key = String(item.trade[property] || "").trim() || "Unspecified";
      const group = groups.get(key) || { label: key, pnl: 0, wins: 0, losses: 0, breakevens: 0, count: 0, currencies: new Set() };
      group.pnl += item.pnl;
      group.count += 1;
      group.currencies.add(item.currency);
      if (item.pnl > 0) group.wins += 1;
      else if (item.pnl < 0) group.losses += 1;
      else group.breakevens += 1;
      groups.set(key, group);
    });
    const all = [...groups.values()].sort((a, b) => stats.singleCurrency
      ? Math.abs(b.pnl) - Math.abs(a.pnl) || a.label.localeCompare(b.label)
      : b.count - a.count || a.label.localeCompare(b.label));
    const visible = all.slice(0, 8);
    const maxAbs = stats.singleCurrency
      ? Math.max(1, ...visible.map((group) => Math.abs(group.pnl)))
      : Math.max(1, ...visible.map((group) => group.count));
    const list = document.createElement("div");
    list.className = "group-bars";
    visible.forEach((group) => {
      const row = document.createElement("div");
      row.className = "group-bar-row";
      const name = document.createElement("span");
      name.className = "group-bar-name";
      name.textContent = group.label;
      name.title = group.label;
      const track = document.createElement("span");
      track.className = "group-bar-track";
      const fill = document.createElement("span");
      fill.className = `group-bar-fill ${group.pnl < 0 ? "negative-fill" : "positive-fill"}`;
      const barValue = stats.singleCurrency ? Math.abs(group.pnl) : group.count;
      fill.style.width = `${barValue === 0 ? 2 : Math.max(3, barValue / maxAbs * 100)}%`;
      track.append(fill);
      const value = document.createElement("span");
      value.className = "group-bar-value";
      value.textContent = stats.singleCurrency
        ? formatMoneyInCurrency(group.pnl, stats.singleCurrency)
        : `${group.count} trade${group.count === 1 ? "" : "s"}`;
      const meta = document.createElement("span");
      meta.className = "group-bar-meta";
      meta.textContent = `${group.count} trade${group.count === 1 ? "" : "s"} · ${group.wins}W / ${group.losses}L / ${group.breakevens}BE`;
      row.append(name, track, value, meta);
      list.append(row);
    });
    container.replaceChildren(list);
    if (all.length > visible.length) {
      const note = document.createElement("p");
      note.className = "group-chart-note";
      note.textContent = `Showing 8 of ${all.length} groups; all filtered groups are included in summary statistics.`;
      container.append(note);
    }
  }

  function renderAnalytics() {
    if (!$("#analytics-view")) return;
    const { trades } = readJournalTrades();
    updateAnalyticsOptions(trades, "#analytics-symbol", "symbol", "All symbols", (value) => String(value || "").trim().toUpperCase());
    updateAnalyticsOptions(trades, "#analytics-strategy", "strategy", "All strategies");
    updateAnalyticsOptions(trades, "#analytics-session", "session", "All sessions");
    const currencies = [...new Set(trades.map((trade) => analyticsCurrency(trade)))].sort();
    const currencySelect = $("#analytics-currency");
    const selectedCurrency = currencySelect.value;
    currencySelect.replaceChildren(new Option("All currencies", ""));
    currencies.forEach((currency) => currencySelect.add(new Option(currency, currency)));
    if (currencies.includes(selectedCurrency)) currencySelect.value = selectedCurrency;

    const { filtered, invalidRange } = filterAnalyticsRecords(trades);
    const stats = calculateAnalytics(filtered);
    const winRateDenominator = stats.wins.length + stats.losses.length;
    const money = (value) => stats.singleCurrency ? formatMoneyInCurrency(value, stats.singleCurrency) : "Unavailable";
    const mixedCurrency = stats.closed.length > 0 && !stats.singleCurrency;
    const notice = $("#analytics-notice");
    const noticeMessages = [];
    if (invalidRange) noticeMessages.push("The start date is later than the end date. Adjust the date range to see results.");
    if (journalStorageError) noticeMessages.push("Some journal data is unreadable or could not be safely updated. Analytics may be incomplete; GoldTrack has not erased or overwritten the original saved data.");
    if (mixedCurrency) noticeMessages.push("The current selection includes multiple account currencies. Select a currency above to view monetary totals and P/L charts; GoldTrack will not combine or convert different currencies.");
    if (stats.invalidResults) noticeMessages.push(`${stats.invalidResults} closed record(s) with missing or invalid status / P/L were excluded from performance calculations.`);
    if (stats.undatedCount) noticeMessages.push(`${stats.undatedCount} closed result(s) without a valid date are included in totals but excluded from time-based charts, drawdown, and streak ordering.`);
    notice.hidden = !noticeMessages.length;
    $("#analytics-notice-text").textContent = noticeMessages.join(" ");

    const closedCount = stats.closed.length;
    updateAnalyticsMetric("#analytics-net", closedCount ? mixedCurrency ? "Mixed currencies" : money(stats.net) : "—", !mixedCurrency && stats.net > 0 ? "positive" : !mixedCurrency && stats.net < 0 ? "negative" : "");
    setText("#analytics-net-foot", closedCount ? `${stats.singleCurrency || "multiple currencies"} · ${closedCount} closed result${closedCount === 1 ? "" : "s"}` : "No closed results");
    setText("#analytics-closed-count", String(closedCount));
    setText("#analytics-outcome-counts", `${stats.wins.length} win${stats.wins.length === 1 ? "" : "s"} · ${stats.losses.length} loss${stats.losses.length === 1 ? "" : "es"} · ${stats.breakevens.length} breakeven`);
    setText("#analytics-win-rate", winRateDenominator ? `${(stats.wins.length / winRateDenominator * 100).toFixed(1)}%` : "—");
    setText("#analytics-profit-factor", stats.singleCurrency && stats.grossLoss > 0 ? (stats.grossProfit / stats.grossLoss).toFixed(2) : "—");
    setText("#analytics-gross-profit", closedCount ? mixedCurrency ? "Mixed currencies" : money(stats.grossProfit) : "—");
    setText("#analytics-gross-loss", closedCount ? mixedCurrency ? "Mixed currencies" : money(stats.grossLoss) : "—");
    setText("#analytics-average-win", stats.wins.length ? mixedCurrency ? "Mixed currencies" : money(stats.grossProfit / stats.wins.length) : "—");
    setText("#analytics-average-loss", stats.losses.length ? mixedCurrency ? "Mixed currencies" : money(stats.losses.reduce((sum, item) => sum + item.pnl, 0) / stats.losses.length) : "—");
    setText("#analytics-largest-win", stats.largestWin ? mixedCurrency ? "Mixed currencies" : money(stats.largestWin.pnl) : "—");
    setText("#analytics-largest-win-label", stats.largestWin ? mixedCurrency ? "Cannot compare currencies" : safeText(stats.largestWin.trade.symbol) : "No winning trades");
    setText("#analytics-largest-loss", stats.largestLoss ? mixedCurrency ? "Mixed currencies" : money(stats.largestLoss.pnl) : "—");
    setText("#analytics-largest-loss-label", stats.largestLoss ? mixedCurrency ? "Cannot compare currencies" : safeText(stats.largestLoss.trade.symbol) : "No losing trades");
    setText("#analytics-drawdown", stats.equityPoints.length ? mixedCurrency ? "Mixed currencies" : money(stats.maxDrawdown) : "—");
    const currentStreakLabel = stats.currentType === "win"
      ? (stats.currentStreak === 1 ? "win" : "wins")
      : (stats.currentStreak === 1 ? "loss" : "losses");
    setText("#analytics-current-streak", !stats.chronological.length ? "—" : stats.currentType === "breakeven" ? "0 · Breakeven" : stats.currentStreak ? `${stats.currentStreak} ${currentStreakLabel}` : "—");
    setText("#analytics-longest-win", String(stats.longestWin));
    setText("#analytics-longest-loss", String(stats.longestLoss));
    setText("#analytics-scope-label", `${filtered.length} matching record${filtered.length === 1 ? "" : "s"} · ${closedCount} closed result${closedCount === 1 ? "" : "s"}`);

    const chartStats = stats.singleCurrency ? stats : { ...stats, singleCurrency: null };
    drawAnalyticsEquity(chartStats);
    drawAnalyticsPeriod(chartStats);
    drawDistribution(stats);
    drawGroupChart($("#analytics-direction-chart"), filtered.filter((trade) => ["buy", "sell"].includes(String(trade.direction || "").toLowerCase())), "direction", stats, "Buy and Sell results appear after closed trades are recorded.");
    // Render each direction as Buy/Sell rather than displaying legacy casing.
    drawGroupChart($("#analytics-strategy-chart"), filtered, "strategy", stats, "Strategy results appear after closed trades are recorded.");
    drawGroupChart($("#analytics-session-chart"), filtered, "session", stats, "Session results appear after closed trades are recorded.");
  }

  function exportAnalyticsCsv() {
    const { trades } = readJournalTrades();
    if (journalStorageError) { showToast("Cannot export while saved journal data is unreadable."); return; }
    const { filtered, invalidRange } = filterAnalyticsRecords(trades);
    if (invalidRange) { showToast("Fix the analytics date range before exporting."); return; }
    const headers = ["id", ...TRADE_FIELDS];
    const rows = [headers, ...filtered.map((trade) => headers.map((field) => trade[field] ?? ""))];
    downloadFile(`goldtrack-analytics-filtered-${new Date().toISOString().slice(0, 10)}.csv`, `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
    showToast(`Exported ${filtered.length} trade record(s) matching the analytics filters. Screenshots are not included in CSV.`);
  }

  function bindAnalyticsEvents() {
    ["#analytics-date-from", "#analytics-date-to", "#analytics-symbol", "#analytics-direction", "#analytics-strategy", "#analytics-session", "#analytics-currency", "#analytics-period"].forEach((selector) => {
      $(selector).addEventListener("change", renderAnalytics);
    });
    $("#clear-analytics-filters").addEventListener("click", () => {
      ["#analytics-date-from", "#analytics-date-to", "#analytics-symbol", "#analytics-direction", "#analytics-strategy", "#analytics-session", "#analytics-currency"].forEach((selector) => { $(selector).value = ""; });
      $("#analytics-period").value = "monthly";
      renderAnalytics();
    });
    $("#export-analytics-csv").addEventListener("click", exportAnalyticsCsv);
  }

  function readRiskSettings() {
    const preferences = readPreferences();
    const stored = preferences.riskManagement && typeof preferences.riskManagement === "object" && !Array.isArray(preferences.riskManagement)
      ? preferences.riskManagement : {};
    return {
      ...DEFAULT_RISK_SETTINGS,
      ...stored,
      currency: String(stored.currency || preferences.currency || DEFAULT_RISK_SETTINGS.currency).toUpperCase(),
      defaultSymbol: String(stored.defaultSymbol || DEFAULT_RISK_SETTINGS.defaultSymbol),
      brokerSpecifications: stored.brokerSpecifications && typeof stored.brokerSpecifications === "object" && !Array.isArray(stored.brokerSpecifications)
        ? stored.brokerSpecifications : {}
    };
  }

  function addCurrencyOption(select, currency) {
    const code = String(currency || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && !Array.from(select.options).some((option) => option.value === code)) {
      select.add(new Option(`${code} — custom`, code));
    }
    if (/^[A-Z]{3}$/.test(code)) select.value = code;
  }

  function setOptionalNumberInput(selector, value) {
    $(selector).value = value === null || value === undefined || value === "" ? "" : String(value);
  }

  function populateRiskSettings() {
    const settings = readRiskSettings();
    setOptionalNumberInput("#risk-setting-balance", settings.accountBalance);
    addCurrencyOption($("#risk-setting-currency"), settings.currency);
    setOptionalNumberInput("#risk-setting-limit", settings.maximumRiskPercent);
    setOptionalNumberInput("#risk-setting-daily-limit", settings.maximumDailyLoss);
    $("#risk-setting-symbol").value = settings.defaultSymbol;
    const specs = settings.brokerSpecifications;
    setOptionalNumberInput("#risk-spec-contract", specs.contractSize);
    setOptionalNumberInput("#risk-spec-tick-size", specs.tickSize);
    setOptionalNumberInput("#risk-spec-tick-value", specs.tickValue);
    const tickCurrency = $("#risk-spec-value-currency");
    if (specs.tickValueCurrency) addCurrencyOption(tickCurrency, specs.tickValueCurrency);
    else tickCurrency.value = "";
    setOptionalNumberInput("#risk-spec-min-lot", specs.minimumLot);
    setOptionalNumberInput("#risk-spec-lot-step", specs.lotStep);
    setOptionalNumberInput("#risk-spec-conversion", specs.conversionRate);
  }

  function riskSettingsNumber(value, label, { optional = false, maximum = Infinity } = {}) {
    if (value === "" || value === null || value === undefined) return optional ? null : NaN;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= maximum ? number : NaN;
  }

  function saveRiskSettings(event) {
    event.preventDefault();
    const error = $("#risk-settings-error");
    error.hidden = true;
    const balance = riskSettingsNumber($("#risk-setting-balance").value, "balance");
    const riskLimit = riskSettingsNumber($("#risk-setting-limit").value, "risk limit", { maximum: 100 });
    const dailyInput = $("#risk-setting-daily-limit").value.trim();
    const dailyLimit = dailyInput === "" ? null : Number(dailyInput);
    const currency = $("#risk-setting-currency").value.trim().toUpperCase();
    const defaultSymbol = $("#risk-setting-symbol").value.trim().toUpperCase();
    const specsInput = {
      contractSize: $("#risk-spec-contract").value,
      tickSize: $("#risk-spec-tick-size").value,
      tickValue: $("#risk-spec-tick-value").value,
      minimumLot: $("#risk-spec-min-lot").value,
      lotStep: $("#risk-spec-lot-step").value,
      conversionRate: $("#risk-spec-conversion").value
    };
    if (!Number.isFinite(balance)) error.textContent = "Enter an account balance greater than zero.";
    else if (!Number.isFinite(riskLimit)) error.textContent = "Maximum planned risk must be greater than 0 and no more than 100 percent.";
    else if (dailyLimit !== null && (!Number.isFinite(dailyLimit) || dailyLimit <= 0)) error.textContent = "Maximum daily loss must be blank or greater than zero.";
    else if (!/^[A-Z]{3}$/.test(currency)) error.textContent = "Choose a valid three-letter account currency.";
    else if (!defaultSymbol || defaultSymbol.length > 30) error.textContent = "Enter a default symbol of 1–30 characters.";
    else {
      const invalidSpec = Object.entries(specsInput).find(([, value]) => value.trim() !== "" && (!Number.isFinite(Number(value)) || Number(value) <= 0));
      if (invalidSpec) error.textContent = `Broker specification “${invalidSpec[0]}” must be blank or greater than zero.`;
      else if ($("#risk-spec-value-currency").value && !/^[A-Z]{3}$/.test($("#risk-spec-value-currency").value)) error.textContent = "Tick-value currency must be a three-letter currency code.";
      else error.textContent = "";
    }
    if (error.textContent) { error.hidden = false; return; }

    let existing;
    try {
      const raw = localStorage.getItem(PREFERENCES_KEY);
      existing = raw ? JSON.parse(raw) : {};
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("Saved preferences are not an object.");
    } catch (storageError) {
      console.error("GoldTrack could not safely update risk preferences:", storageError);
      error.textContent = "Saved preferences could not be read safely. No settings were changed.";
      error.hidden = false;
      return;
    }
    const priorRisk = existing.riskManagement && typeof existing.riskManagement === "object" && !Array.isArray(existing.riskManagement)
      ? existing.riskManagement : {};
    const priorSpecs = priorRisk.brokerSpecifications && typeof priorRisk.brokerSpecifications === "object" && !Array.isArray(priorRisk.brokerSpecifications)
      ? priorRisk.brokerSpecifications : {};
    const brokerSpecifications = { ...priorSpecs };
    Object.entries(specsInput).forEach(([key, value]) => { brokerSpecifications[key] = value.trim() === "" ? "" : Number(value); });
    brokerSpecifications.tickValueCurrency = $("#risk-spec-value-currency").value || "";
    const nextPreferences = {
      ...existing,
      currency,
      riskManagement: {
        ...priorRisk,
        accountBalance: balance,
        currency,
        maximumRiskPercent: riskLimit,
        maximumDailyLoss: dailyLimit,
        defaultSymbol,
        brokerSpecifications
      }
    };
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(nextPreferences));
      setText("#save-status", "Saved locally");
      updateHeader();
      renderDashboard();
      renderAnalytics();
      calculateRiskPlan();
      updateDailyRiskStatus();
      showToast("Risk settings saved in this browser.");
    } catch (storageError) {
      console.error("GoldTrack could not save risk preferences:", storageError);
      error.textContent = storageError && storageError.name === "QuotaExceededError"
        ? "Browser storage is full. Risk settings were not saved."
        : "Risk settings could not be saved. Your previous preferences were kept.";
      error.hidden = false;
    }
  }

  function readRiskPlans() {
    riskPlansStorageError = false;
    let parsed;
    try {
      const raw = localStorage.getItem(RISK_PLANS_KEY);
      parsed = raw ? JSON.parse(raw) : [];
    } catch (error) {
      riskPlansStorageError = true;
      console.error("GoldTrack could not read saved risk plans:", error);
      return [];
    }
    if (!Array.isArray(parsed) || parsed.some((plan) => !plan || typeof plan !== "object" || Array.isArray(plan) || !plan.id)) {
      riskPlansStorageError = true;
      return [];
    }
    return parsed;
  }

  function persistRiskPlans(plans) {
    if (riskPlansStorageError) {
      showToast("Saved risk plans are unreadable; no risk plan was changed.");
      return false;
    }
    try {
      localStorage.setItem(RISK_PLANS_KEY, JSON.stringify(plans));
      renderRiskPlans();
      return true;
    } catch (error) {
      console.error("GoldTrack could not save risk plans:", error);
      showToast(error && error.name === "QuotaExceededError"
        ? "Browser storage is full. This risk plan was not saved."
        : "Could not save this risk plan. Existing plans were preserved.");
      return false;
    }
  }

  function riskPlanId() {
    return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `risk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function readRiskCalculatorInputs() {
    return {
      balance: riskSettingsNumber($("#risk-calc-balance").value, "account balance"),
      riskPercent: riskSettingsNumber($("#risk-calc-percent").value, "risk percentage", { maximum: 100 }),
      symbol: $("#risk-calc-symbol").value.trim().toUpperCase(),
      direction: $("#risk-calc-direction").value,
      entry: riskSettingsNumber($("#risk-calc-entry").value, "entry price"),
      stop: riskSettingsNumber($("#risk-calc-stop").value, "stop-loss"),
      target: riskSettingsNumber($("#risk-calc-target").value, "take-profit"),
      lots: riskSettingsNumber($("#risk-calc-lots").value, "lot size", { optional: true })
    };
  }

  function isValidRiskPrice(value) {
    return Number.isFinite(value) && value > 0;
  }

  function riskDirectionChecks(inputs) {
    const entryValid = isValidRiskPrice(inputs.entry);
    const stopValid = isValidRiskPrice(inputs.stop);
    const targetValid = isValidRiskPrice(inputs.target);
    const stopCorrect = entryValid && stopValid && (inputs.direction === "Buy" ? inputs.stop < inputs.entry : inputs.stop > inputs.entry);
    const targetCorrect = entryValid && targetValid && (inputs.direction === "Buy" ? inputs.target > inputs.entry : inputs.target < inputs.entry);
    const stopDistance = entryValid && stopValid ? Math.abs(inputs.entry - inputs.stop) : null;
    const targetDistance = entryValid && targetValid ? Math.abs(inputs.target - inputs.entry) : null;
    const riskReward = stopCorrect && targetCorrect && stopDistance > 0 ? targetDistance / stopDistance : null;
    return { entryValid, stopValid, targetValid, stopCorrect, targetCorrect, stopDistance, targetDistance, riskReward };
  }

  function estimateMoneyForLots(distance, lots, settings) {
    if (!(Number.isFinite(distance) && distance >= 0 && Number.isFinite(lots) && lots > 0)) return { value: null, reason: "Enter a valid lot size." };
    const specs = settings.brokerSpecifications || {};
    const tickSize = Number(specs.tickSize);
    const tickValue = Number(specs.tickValue);
    const conversion = Number(specs.conversionRate);
    const accountCurrency = settings.currency;
    const valueCurrency = String(specs.tickValueCurrency || accountCurrency).toUpperCase();
    const currencyFactor = valueCurrency === accountCurrency ? 1 : Number.isFinite(conversion) && conversion > 0 ? conversion : null;
    const minimumLot = Number(specs.minimumLot);
    const lotStep = Number(specs.lotStep);
    if (!(Number.isFinite(minimumLot) && minimumLot > 0 && Number.isFinite(lotStep) && lotStep > 0)) {
      return { value: null, reason: "Verified broker minimum lot size and lot step are also required." };
    }
    if (lots < minimumLot) return { value: null, reason: `Position size is below the configured minimum lot of ${minimumLot}.` };
    const stepCount = (lots - minimumLot) / lotStep;
    if (Math.abs(stepCount - Math.round(stepCount)) > 1e-7) return { value: null, reason: `Position size does not align with the configured lot step of ${lotStep}.` };
    if (Number.isFinite(tickSize) && tickSize > 0 && Number.isFinite(tickValue) && tickValue > 0) {
      if (currencyFactor === null) return { value: null, reason: `Enter a verified conversion rate from ${valueCurrency} to ${accountCurrency}.` };
      return { value: distance / tickSize * tickValue * currencyFactor * lots, reason: "Estimated using the configured tick size and tick value." };
    }
    const contractSize = Number(specs.contractSize);
    if (Number.isFinite(contractSize) && contractSize > 0 && currencyFactor !== null) {
      return { value: distance * contractSize * currencyFactor * lots, reason: "Estimated using the configured contract size and verified currency specification." };
    }
    if (Number.isFinite(contractSize) && contractSize > 0 && currencyFactor === null) return { value: null, reason: `Enter a verified conversion rate from ${valueCurrency} to ${accountCurrency}.` };
    return { value: null, reason: "Unavailable: verified tick/point value and size, or contract size and conversion, are required." };
  }

  function addRiskWarning(list, message) {
    if (!list.includes(message)) list.push(message);
  }

  function renderRiskWarnings(warnings, invalid = false) {
    const box = $("#risk-warning-box");
    const list = $("#risk-warning-list");
    list.replaceChildren();
    warnings.forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    });
    box.classList.toggle("has-warning", invalid || warnings.some((warning) => /exceed|wrong side|greater than zero|must be|reached|below the broker|lot step|conversion rate/i.test(warning)));
    box.classList.toggle("has-info", !invalid && warnings.length > 0 && !box.classList.contains("has-warning"));
    $("#risk-warning-title").textContent = invalid ? "Review this plan" : warnings.length ? "Risk checks" : "No input warnings";
    if (!warnings.length) {
      const item = document.createElement("li");
      item.textContent = "Enter and verify your inputs. This is a planning aid, not a safety guarantee.";
      list.append(item);
    }
  }

  function calculateRiskPlan() {
    if (!$("#risk-calc-balance")) return null;
    const inputs = readRiskCalculatorInputs();
    const settings = readRiskSettings();
    const checks = riskDirectionChecks(inputs);
    const currency = settings.currency;
    const plannedRisk = Number.isFinite(inputs.balance) && Number.isFinite(inputs.riskPercent)
      ? inputs.balance * inputs.riskPercent / 100 : null;
    const warnings = [];
    let invalid = false;
    if (!Number.isFinite(inputs.balance)) { addRiskWarning(warnings, "Account balance must be greater than zero."); invalid = true; }
    if (!Number.isFinite(inputs.riskPercent)) { addRiskWarning(warnings, "Enter a risk percentage greater than 0 and no more than 100."); invalid = true; }
    if (!inputs.symbol || inputs.symbol.length > 30) { addRiskWarning(warnings, "Enter a valid trading symbol (1–30 characters)."); invalid = true; }
    if (!checks.entryValid) { addRiskWarning(warnings, "Entry price must be greater than zero."); invalid = true; }
    if (!checks.stopValid) { addRiskWarning(warnings, "Stop-loss price must be greater than zero."); invalid = true; }
    if (!checks.targetValid) { addRiskWarning(warnings, "Take-profit price must be greater than zero."); invalid = true; }
    if (inputs.lots !== null && (!Number.isFinite(inputs.lots) || inputs.lots <= 0)) { addRiskWarning(warnings, "Position size must be greater than zero or left blank."); invalid = true; }
    if (checks.entryValid && checks.stopValid && !checks.stopCorrect) addRiskWarning(warnings, inputs.direction === "Buy" ? "For a Buy, stop-loss should be below entry." : "For a Sell, stop-loss should be above entry.");
    if (checks.entryValid && checks.targetValid && !checks.targetCorrect) addRiskWarning(warnings, inputs.direction === "Buy" ? "For a Buy, take-profit should be above entry." : "For a Sell, take-profit should be below entry.");
    const maximumRiskPercent = Number(settings.maximumRiskPercent);
    if (Number.isFinite(inputs.riskPercent) && Number.isFinite(maximumRiskPercent) && maximumRiskPercent > 0 && inputs.riskPercent > maximumRiskPercent) {
      addRiskWarning(warnings, `Planned risk ${inputs.riskPercent}% exceeds your configured ${maximumRiskPercent}% per-trade limit.`);
    }
    if (!Number.isFinite(maximumRiskPercent) || maximumRiskPercent <= 0) addRiskWarning(warnings, "Set a maximum planned risk percentage in Account & broker settings to enable your limit warning.");

    const validTradeSide = checks.stopCorrect && checks.targetCorrect;
    const riskEstimate = inputs.lots && validTradeSide ? estimateMoneyForLots(checks.stopDistance, inputs.lots, settings) : { value: null, reason: "Requires an entered lot size and verified broker specifications." };
    const rewardEstimate = inputs.lots && validTradeSide ? estimateMoneyForLots(checks.targetDistance, inputs.lots, settings) : { value: null, reason: "Requires an entered lot size and verified broker specifications." };
    const specs = settings.brokerSpecifications || {};
    const minimumLot = Number(specs.minimumLot);
    const lotStep = Number(specs.lotStep);
    if (inputs.lots && Number.isFinite(minimumLot) && minimumLot > 0 && inputs.lots < minimumLot) addRiskWarning(warnings, `Position size is below your configured broker minimum of ${minimumLot}.`);
    if (inputs.lots && Number.isFinite(lotStep) && lotStep > 0) {
      const base = Number.isFinite(minimumLot) && minimumLot > 0 ? minimumLot : 0;
      const steps = (inputs.lots - base) / lotStep;
      if (inputs.lots >= base && Math.abs(steps - Math.round(steps)) > 1e-7) addRiskWarning(warnings, `Position size does not align with the configured broker lot step of ${lotStep}.`);
    }
    if (inputs.lots && (riskEstimate.value === null || rewardEstimate.value === null)) addRiskWarning(warnings, `Position-size risk/reward unavailable: ${riskEstimate.reason}`);
    if (riskEstimate.value !== null && Number.isFinite(plannedRisk) && riskEstimate.value > plannedRisk) addRiskWarning(warnings, `Estimated risk for ${inputs.lots} lot(s) exceeds the planned ${formatMoneyInCurrency(plannedRisk, currency)} risk budget.`);
    if (riskEstimate.value !== null && Number.isFinite(maximumRiskPercent) && maximumRiskPercent > 0 && Number.isFinite(inputs.balance) && riskEstimate.value > inputs.balance * maximumRiskPercent / 100) {
      addRiskWarning(warnings, `Estimated risk for this position exceeds your configured ${maximumRiskPercent}% account risk limit.`);
    }

    $("#risk-output-budget").textContent = plannedRisk === null ? "—" : formatMoneyInCurrency(plannedRisk, currency);
    $("#risk-output-distance").textContent = checks.stopDistance === null || checks.targetDistance === null
      ? "—" : `${formatPrice(checks.stopDistance)} / ${formatPrice(checks.targetDistance)}`;
    $("#risk-output-distance-note").textContent = checks.stopDistance !== null && checks.targetDistance !== null
      ? `Stop distance / target distance · ${safeText(inputs.symbol, "symbol")}` : "Stop distance / target distance in price units";
    $("#risk-output-rr").textContent = checks.riskReward === null ? "Unavailable" : `1 : ${checks.riskReward.toFixed(2)}`;
    $("#risk-output-position-risk").textContent = riskEstimate.value === null ? "Unavailable" : formatMoneyInCurrency(riskEstimate.value, currency);
    $("#risk-output-position-risk-note").textContent = inputs.lots ? riskEstimate.reason : "Enter a lot size and verified broker specifications.";
    $("#risk-output-reward").textContent = rewardEstimate.value === null ? "Unavailable" : formatMoneyInCurrency(rewardEstimate.value, currency);
    $("#risk-output-reward-note").textContent = inputs.lots ? rewardEstimate.reason : "Enter a lot size and verified broker specifications.";
    const hasMeaningfulInput = ["#risk-calc-balance", "#risk-calc-percent", "#risk-calc-entry", "#risk-calc-stop", "#risk-calc-target", "#risk-calc-lots"]
      .some((selector) => $(selector).value.trim() !== "");
    const displayedWarnings = hasMeaningfulInput ? warnings : ["Enter the account balance, risk percentage, and prices to calculate a plan."];
    renderRiskWarnings(displayedWarnings, invalid && hasMeaningfulInput);
    updateDailyRiskStatus();
    return { inputs, checks, plannedRisk, riskEstimate, rewardEstimate, warnings, invalid };
  }

  function updateDailyRiskStatus() {
    const status = $("#daily-risk-status");
    if (!status) return;
    status.classList.remove("daily-limit-hit");
    const settings = readRiskSettings();
    const limit = Number(settings.maximumDailyLoss);
    if (!Number.isFinite(limit) || limit <= 0) {
      status.textContent = "Daily loss limit is not configured. Add one in Account & broker settings if you want a journal-based alert.";
      return;
    }
    const today = localDateKey(new Date());
    const currency = settings.currency;
    const matchingToday = currentTrades().filter((trade) => {
      const outcome = String(trade.outcome || "").trim().toLowerCase();
      const pnl = analyticsPnl(trade);
      return outcome !== "open" && ["win", "loss", "breakeven"].includes(outcome)
        && pnl !== null && localDateKey(tradeDate(trade)) === today && analyticsCurrency(trade) === currency;
    });
    const realizedNet = matchingToday.reduce((sum, trade) => sum + analyticsPnl(trade), 0);
    if (realizedNet <= -limit) {
      status.textContent = `Daily loss limit reached: today's journaled closed net result is ${formatMoneyInCurrency(realizedNet, currency)} against a ${formatMoneyInCurrency(limit, currency)} limit. This omits open trades and unrecorded costs/results.`;
      status.classList.add("daily-limit-hit");
    } else {
      status.textContent = `${matchingToday.length} same-currency closed journal result(s) today · realized net ${formatMoneyInCurrency(realizedNet, currency)} · daily limit ${formatMoneyInCurrency(limit, currency)}. Open/floating P/L is not included.`;
    }
  }

  function validateRiskPlanInputs(calculation) {
    if (calculation.invalid) return "Correct the invalid calculator inputs before saving this plan.";
    if (!calculation.checks.stopCorrect) return "Stop-loss is on the wrong side of entry for this direction.";
    if (!calculation.checks.targetCorrect) return "Take-profit is on the wrong side of entry for this direction.";
    if (!calculation.inputs.symbol) return "Enter a symbol before saving this plan.";
    return "";
  }

  function saveCurrentRiskPlan() {
    $("#risk-calculator-error").hidden = true;
    const calculation = calculateRiskPlan();
    const validation = validateRiskPlanInputs(calculation);
    if (validation) {
      $("#risk-calculator-error").textContent = validation;
      $("#risk-calculator-error").hidden = false;
      return;
    }
    const settings = readRiskSettings();
    const plans = readRiskPlans();
    if (riskPlansStorageError) {
      $("#risk-calculator-error").textContent = "Saved risk plans could not be read safely. No data was changed.";
      $("#risk-calculator-error").hidden = false;
      return;
    }
    const existingIndex = plans.findIndex((plan) => plan.id === editingRiskPlanId);
    const oldPlan = existingIndex >= 0 ? plans[existingIndex] : null;
    const plan = {
      ...(oldPlan || {}),
      id: oldPlan ? oldPlan.id : riskPlanId(),
      createdAt: oldPlan ? oldPlan.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      symbol: calculation.inputs.symbol,
      direction: calculation.inputs.direction,
      balance: calculation.inputs.balance,
      currency: settings.currency,
      riskPercent: calculation.inputs.riskPercent,
      entry: calculation.inputs.entry,
      stop: calculation.inputs.stop,
      target: calculation.inputs.target,
      lots: calculation.inputs.lots,
      plannedRisk: calculation.plannedRisk,
      stopDistance: calculation.checks.stopDistance,
      targetDistance: calculation.checks.targetDistance,
      riskReward: calculation.checks.riskReward,
      estimatedPositionRisk: calculation.riskEstimate.value,
      estimatedReward: calculation.rewardEstimate.value
    };
    if (existingIndex >= 0) plans[existingIndex] = plan;
    else plans.push(plan);
    if (persistRiskPlans(plans)) {
      editingRiskPlanId = "";
      $("#save-risk-plan").textContent = "Save risk plan";
      $("#risk-calculator-error").hidden = true;
      showToast(existingIndex >= 0 ? "Risk plan updated. Journal records were not changed." : "Risk plan saved separately from your journal.");
    }
  }

  function resetRiskCalculator() {
    editingRiskPlanId = "";
    const settings = readRiskSettings();
    setOptionalNumberInput("#risk-calc-balance", settings.accountBalance);
    setOptionalNumberInput("#risk-calc-percent", "");
    $("#risk-calc-symbol").value = settings.defaultSymbol || "XAUUSD";
    $("#risk-calc-direction").value = "Buy";
    ["#risk-calc-entry", "#risk-calc-stop", "#risk-calc-target", "#risk-calc-lots"].forEach((selector) => { $(selector).value = ""; });
    $("#save-risk-plan").textContent = "Save risk plan";
    $("#risk-calculator-error").hidden = true;
    calculateRiskPlan();
  }

  function setRiskCalculatorFromPreferences() {
    const settings = readRiskSettings();
    setOptionalNumberInput("#risk-calc-balance", settings.accountBalance);
    setOptionalNumberInput("#risk-calc-percent", "");
    $("#risk-calc-symbol").value = settings.defaultSymbol || "XAUUSD";
    $("#risk-calc-direction").value = "Buy";
    ["#risk-calc-entry", "#risk-calc-stop", "#risk-calc-target", "#risk-calc-lots"].forEach((selector) => { $(selector).value = ""; });
  }

  function editRiskPlan(plan) {
    editingRiskPlanId = plan.id;
    setOptionalNumberInput("#risk-calc-balance", plan.balance);
    setOptionalNumberInput("#risk-calc-percent", plan.riskPercent);
    $("#risk-calc-symbol").value = plan.symbol || "XAUUSD";
    $("#risk-calc-direction").value = plan.direction === "Sell" ? "Sell" : "Buy";
    setOptionalNumberInput("#risk-calc-entry", plan.entry);
    setOptionalNumberInput("#risk-calc-stop", plan.stop);
    setOptionalNumberInput("#risk-calc-target", plan.target);
    setOptionalNumberInput("#risk-calc-lots", plan.lots);
    $("#save-risk-plan").textContent = "Update risk plan";
    $("#risk-calculator-error").hidden = true;
    calculateRiskPlan();
    if (plan.currency && plan.currency !== readRiskSettings().currency) {
      showToast(`This plan was saved in ${plan.currency}; calculations now use your current ${readRiskSettings().currency} account currency.`);
    }
    $(".risk-calculator-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function appendRiskCell(row, value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    row.append(cell);
    return cell;
  }

  function renderRiskPlans() {
    const plans = readRiskPlans();
    const body = $("#risk-plans-body");
    body.replaceChildren();
    plans.slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).forEach((plan) => {
      const row = document.createElement("tr");
      const timestamp = new Date(plan.createdAt || plan.updatedAt || "");
      appendRiskCell(row, Number.isNaN(timestamp.getTime()) ? "Date not set" : displayDate(timestamp, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
      appendRiskCell(row, safeText(plan.symbol));
      appendRiskCell(row, safeText(plan.direction));
      appendRiskCell(row, formatPrice(plan.entry));
      appendRiskCell(row, formatPrice(plan.stop));
      appendRiskCell(row, formatPrice(plan.target));
      appendRiskCell(row, Number.isFinite(Number(plan.plannedRisk)) ? formatMoneyInCurrency(Number(plan.plannedRisk), plan.currency) : "—");
      appendRiskCell(row, Number.isFinite(Number(plan.riskReward)) ? `1 : ${Number(plan.riskReward).toFixed(2)}` : "—");
      const actionsCell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "risk-plan-actions-cell";
      [["Edit", "edit"], ["Delete", "delete"]].forEach(([label, action]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "risk-plan-action";
        button.dataset.planAction = action;
        button.dataset.planId = String(plan.id);
        button.textContent = label;
        button.setAttribute("aria-label", `${label} risk plan for ${safeText(plan.symbol, "symbol")}`);
        actions.append(button);
      });
      actionsCell.append(actions);
      row.append(actionsCell);
      body.append(row);
    });
    $("#risk-plan-count").textContent = riskPlansStorageError ? "Plan data unavailable" : `${plans.length} saved plan${plans.length === 1 ? "" : "s"}`;
    const empty = $("#risk-plans-empty");
    empty.hidden = plans.length > 0 && !riskPlansStorageError;
    const title = empty.querySelector("strong");
    const message = empty.querySelector("p");
    title.textContent = riskPlansStorageError ? "Saved risk plans could not be read" : "No saved risk plans yet";
    message.textContent = riskPlansStorageError
      ? "The saved plan data was not changed. Check browser storage before attempting to edit or delete plans."
      : "Calculate a setup, then save it here. Plans never become journal trades automatically.";
  }

  function renderRiskManagement(loadSettings = false) {
    if (!$("#risk-view")) return;
    if (loadSettings) {
      populateRiskSettings();
      setRiskCalculatorFromPreferences();
    }
    calculateRiskPlan();
    renderRiskPlans();
    updateDailyRiskStatus();
  }

  function handleRiskPlanAction(event) {
    const button = event.target.closest("button[data-plan-action]");
    if (!button) return;
    const plans = readRiskPlans();
    if (riskPlansStorageError) { showToast("Saved risk plans are unreadable; no data was changed."); return; }
    const plan = plans.find((item) => String(item.id) === button.dataset.planId);
    if (!plan) { showToast("That risk plan could not be found."); renderRiskPlans(); return; }
    if (button.dataset.planAction === "edit") editRiskPlan(plan);
    if (button.dataset.planAction === "delete") {
      if (!window.confirm(`Delete the saved ${safeText(plan.symbol, "selected symbol")} risk plan? Actual journal trades will not be affected.`)) return;
      if (persistRiskPlans(plans.filter((item) => String(item.id) !== button.dataset.planId))) showToast("Risk plan deleted. Journal records were not changed.");
    }
  }

  function bindRiskEvents() {
    $("#risk-settings-form").addEventListener("submit", saveRiskSettings);
    $("#risk-calculator-form").addEventListener("input", () => {
      $("#risk-calculator-error").hidden = true;
      calculateRiskPlan();
    });
    $("#risk-calculator-form").addEventListener("change", calculateRiskPlan);
    $("#save-risk-plan").addEventListener("click", saveCurrentRiskPlan);
    $("#reset-risk-calculator").addEventListener("click", resetRiskCalculator);
    $("#risk-plans-body").addEventListener("click", handleRiskPlanAction);
  }

  const RULE_TYPES = {
    "ema-cross": "EMA crossover",
    "price-ema": "Price vs EMA",
    "rsi-level": "RSI level",
    "rsi-cross": "RSI crossing level"
  };
  const TIMEFRAME_LABELS = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour", "4h": "4 hours", "1D": "1 day", "1W": "1 week", "1M": "1 month" };
  let strategyRules = { buy: [], sell: [] };

  function newRule(type = "ema-cross", join = "AND") {
    const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = { id, type, join };
    if (type === "ema-cross") return { ...base, fast: 9, slow: 21, crossing: "above" };
    if (type === "price-ema") return { ...base, period: 20, relation: "above" };
    if (type === "rsi-level") return { ...base, period: 14, relation: "above", value: 50 };
    return { ...base, period: 14, crossing: "above", value: 50 };
  }

  function readStrategyRecords() {
    strategiesStorageError = false;
    try {
      const raw = localStorage.getItem(STRATEGIES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item) || !item.id)) {
        strategiesStorageError = true;
        return [];
      }
      return parsed;
    } catch (error) {
      strategiesStorageError = true;
      console.error("GoldTrack could not read saved strategies:", error);
      return [];
    }
  }

  function persistStrategyRecords(records) {
    if (strategiesStorageError) {
      showToast("Saved strategies are unreadable. No strategy data was changed.");
      return false;
    }
    try {
      localStorage.setItem(STRATEGIES_KEY, JSON.stringify(records));
      renderStrategyLibrary();
      return true;
    } catch (error) {
      console.error("GoldTrack could not save strategies:", error);
      showToast(error && error.name === "QuotaExceededError"
        ? "Browser storage is full. The strategy was not saved."
        : "Could not save this strategy. Existing strategies were preserved.");
      return false;
    }
  }

  function strategyElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createSelect(options, selected, ariaLabel, onChange) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", ariaLabel);
    options.forEach(([value, label]) => select.add(new Option(label, value)));
    select.value = String(selected);
    if (onChange) select.addEventListener("change", onChange);
    return select;
  }

  function ruleNumberInput(rule, property, label, min, max, step = "1") {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    if (max !== null) input.max = String(max);
    input.step = step;
    input.inputMode = "decimal";
    input.value = rule[property] === undefined ? "" : String(rule[property]);
    input.setAttribute("aria-label", label);
    input.dataset.ruleProperty = property;
    return input;
  }

  function ruleField(label, control) {
    const wrapper = strategyElement("label", "strategy-rule-field");
    wrapper.append(strategyElement("span", "", label), control);
    return wrapper;
  }

  function renderRuleParameters(rule, parameterContainer) {
    parameterContainer.replaceChildren();
    const period = () => ruleField("Period", ruleNumberInput(rule, "period", "Indicator period", 1, 500));
    const level = () => ruleField("RSI level", ruleNumberInput(rule, "value", "RSI level from 0 to 100", 0, 100, "any"));
    if (rule.type === "ema-cross") {
      const crossover = ruleField("Crossover", createSelect([["above", "Crosses above"], ["below", "Crosses below"]], rule.crossing, "EMA crossover direction", () => {}));
      crossover.querySelector("select").dataset.ruleProperty = "crossing";
      parameterContainer.append(
        ruleField("Fast EMA", ruleNumberInput(rule, "fast", "Fast EMA period", 1, 500)),
        ruleField("Slow EMA", ruleNumberInput(rule, "slow", "Slow EMA period", 1, 500)),
        crossover
      );
      return;
    }
    if (rule.type === "price-ema") {
      parameterContainer.append(period(), ruleField("Price relation", createSelect([["above", "Price above EMA"], ["below", "Price below EMA"]], rule.relation, "Price relation to EMA", () => {})));
      parameterContainer.querySelectorAll("select").forEach((select) => { select.dataset.ruleProperty = "relation"; });
      return;
    }
    if (rule.type === "rsi-level") {
      parameterContainer.append(period(), ruleField("Condition", createSelect([["above", "RSI above level"], ["below", "RSI below level"]], rule.relation, "RSI level condition", () => {})), level());
      parameterContainer.querySelectorAll("select").forEach((select) => { select.dataset.ruleProperty = "relation"; });
      return;
    }
    parameterContainer.append(period(), ruleField("Crossing", createSelect([["above", "Crosses above level"], ["below", "Crosses below level"]], rule.crossing, "RSI crossing direction", () => {})), level());
    parameterContainer.querySelectorAll("select").forEach((select) => { select.dataset.ruleProperty = "crossing"; });
  }

  function renderRuleGroup(direction) {
    const list = $(`#${direction}-rule-list`);
    const empty = $(`#${direction}-rule-empty`);
    list.replaceChildren();
    empty.hidden = strategyRules[direction].length > 0;
    strategyRules[direction].forEach((rule, index) => {
      const card = strategyElement("div", "strategy-rule-card");
      card.dataset.ruleId = rule.id;
      const top = strategyElement("div", "strategy-rule-card-top");
      const tag = strategyElement("span", `rule-order-tag ${direction}-rule-tag`, `${direction === "buy" ? "BUY" : "SELL"} RULE ${index + 1}`);
      const remove = strategyElement("button", "strategy-remove-rule", "Remove");
      remove.type = "button";
      remove.dataset.removeRule = rule.id;
      remove.setAttribute("aria-label", `Remove ${direction} condition ${index + 1}`);
      top.append(tag);
      if (index > 0) {
        top.append(strategyFieldFromControl("Combine with previous", createSelect([["AND", "AND — all must match"], ["OR", "OR — either may match"]], rule.join || "AND", `${direction} condition ${index + 1} combination`, () => {}), "strategy-join-field"));
        const logic = top.querySelector(".strategy-join-field select:last-child");
        logic.dataset.ruleProperty = "join";
      } else {
        top.append(strategyElement("span", "first-rule-hint", "First rule in this group"));
      }
      top.append(remove);
      const controls = strategyElement("div", "strategy-rule-controls");
      const type = createSelect(Object.entries(RULE_TYPES), rule.type, `${direction} rule type`, () => {
        const newType = type.value;
        const join = rule.join || "AND";
        const id = rule.id;
        Object.keys(rule).forEach((key) => { delete rule[key]; });
        Object.assign(rule, newRule(newType, join), { id });
        renderRuleGroup(direction);
        updateStrategySummary();
      });
      const typeField = ruleField("Condition type", type);
      typeField.classList.add("rule-type-field");
      controls.append(typeField);
      const parameters = strategyElement("div", "strategy-rule-parameters");
      renderRuleParameters(rule, parameters);
      controls.append(parameters);
      card.append(top, controls);
      list.append(card);
    });
    updateStrategySummary();
  }

  function strategyFieldFromControl(label, control, className = "") {
    const field = strategyElement("label", `strategy-rule-field ${className}`.trim());
    field.append(strategyElement("span", "", label), control);
    return field;
  }

  function validateRule(rule, label) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return `${label}: condition must be an object.`;
    if (!Object.prototype.hasOwnProperty.call(RULE_TYPES, rule.type)) return `${label}: condition type is unsupported.`;
    const period = Number(rule.period);
    if (rule.type === "ema-cross") {
      const fast = Number(rule.fast);
      const slow = Number(rule.slow);
      if (!Number.isInteger(fast) || fast < 1 || fast > 500 || !Number.isInteger(slow) || slow < 1 || slow > 500 || fast === slow) return `${label}: fast and slow EMA periods must be different whole numbers from 1 to 500.`;
      if (!["above", "below"].includes(rule.crossing)) return `${label}: choose a valid EMA crossover direction.`;
    } else {
      if (!Number.isInteger(period) || period < 1 || period > 500) return `${label}: indicator period must be a whole number from 1 to 500.`;
      if (rule.type === "price-ema" && !["above", "below"].includes(rule.relation)) return `${label}: choose above or below for the EMA relation.`;
      if (rule.type === "rsi-level" && !["above", "below"].includes(rule.relation)) return `${label}: choose above or below for the RSI condition.`;
      if (rule.type === "rsi-cross" && !["above", "below"].includes(rule.crossing)) return `${label}: choose above or below for the RSI cross.`;
    }
    if (["rsi-level", "rsi-cross"].includes(rule.type)) {
      const value = Number(rule.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) return `${label}: RSI level must be from 0 to 100.`;
    }
    return "";
  }

  function describeStrategyRule(rule) {
    if (rule.type === "ema-cross") return `EMA ${rule.fast} crosses ${rule.crossing} EMA ${rule.slow}`;
    if (rule.type === "price-ema") return `Price is ${rule.relation} EMA ${rule.period}`;
    if (rule.type === "rsi-level") return `RSI ${rule.period} is ${rule.relation} ${rule.value}`;
    if (rule.type === "rsi-cross") return `RSI ${rule.period} crosses ${rule.crossing} ${rule.value}`;
    return "Unknown condition";
  }

  function describeStrategySide(rules) {
    if (!rules.length) return "No conditions defined";
    const joinedRules = rules.map((rule, index) => `${index ? `${rule.join || "AND"} ` : ""}${describeStrategyRule(rule)}`).join(" ");
    return rules.length > 1 ? `(${joinedRules}; evaluated left to right)` : joinedRules;
  }

  function updateStrategySummary() {
    if (!$("#strategy-summary-text")) return;
    const name = $("#strategy-name").value.trim() || "Untitled strategy";
    const symbol = $("#strategy-symbol").value.trim().toUpperCase() || "XAUUSD";
    const timeframe = TIMEFRAME_LABELS[$("#strategy-timeframe").value] || $("#strategy-timeframe").value;
    const stopType = $("#strategy-stop-type").value;
    const stopValue = $("#strategy-stop-value").value;
    const targetType = $("#strategy-target-type").value;
    const targetValue = $("#strategy-target-value").value;
    const risk = $("#strategy-risk-percent").value;
    const stop = stopType === "none" ? "Not specified" : `${stopType === "percentage" ? `${stopValue || "?"}% from entry` : `${stopValue || "?"} price units`}`;
    const targetLabels = { none: "Not specified", "price-distance": `${targetValue || "?"} price units`, percentage: `${targetValue || "?"}% from entry`, "risk-reward": `${targetValue || "?"}R` };
    const summary = `${name} · ${symbol} · ${timeframe}. Buy when: ${describeStrategySide(strategyRules.buy)}. Sell when: ${describeStrategySide(strategyRules.sell)}. Stop-loss: ${stop}. Take-profit: ${targetLabels[targetType] || "Not specified"}.${risk ? ` Planned risk: ${risk}%.` : ""}`;
    $("#strategy-summary-text").textContent = summary;
  }

  function syntheticDataForRule(rule) {
    if (rule.type === "ema-cross") {
      const fast = rule.crossing === "above" ? [99, 102] : [102, 99];
      const slow = [100, 100];
      return { ema: { [String(rule.fast)]: fast, [String(rule.slow)]: slow } };
    }
    if (rule.type === "price-ema") {
      const close = rule.relation === "above" ? 102 : 98;
      return { close: [close], ema: { [String(rule.period)]: [100] } };
    }
    if (rule.type === "rsi-level") {
      const value = rule.relation === "above" ? Math.min(100, Number(rule.value) + 1) : Math.max(0, Number(rule.value) - 1);
      return { rsi: { [String(rule.period)]: [value] } };
    }
    const threshold = Number(rule.value);
    const values = rule.crossing === "above"
      ? [Math.max(0, threshold - 1), Math.min(100, threshold + 1)]
      : [Math.min(100, threshold + 1), Math.max(0, threshold - 1)];
    return { rsi: { [String(rule.period)]: values } };
  }

  function runStrategyRulePreview() {
    const results = $("#strategy-preview-results");
    results.replaceChildren();
    const evaluator = window.GoldTrackRuleEvaluator;
    if (!evaluator || typeof evaluator.runSyntheticTests !== "function") {
      results.append(strategyElement("span", "preview-test-fail", "Rule evaluator could not be loaded. Check the strategy-rules.js file reference."));
      return;
    }

    const testRun = evaluator.runSyntheticTests();
    const testsHeading = strategyElement("div", `preview-suite-status ${testRun.passed === testRun.total ? "suite-passed" : "suite-failed"}`,
      `Synthetic evaluator checks: ${testRun.passed}/${testRun.total} passed`);
    results.append(testsHeading);
    const testList = strategyElement("ul", "preview-test-list");
    testRun.tests.forEach((test) => {
      const item = strategyElement("li", test.passed ? "preview-test-pass" : "preview-test-fail",
        `${test.passed ? "PASS" : "FAIL"} · ${test.name}${test.actual.error ? ` — ${test.actual.error}` : ""}`);
      testList.append(item);
    });
    results.append(testList);

    const draft = readStrategyForm();
    const validation = validateStrategy(draft);
    const draftStatus = strategyElement("p", validation ? "preview-draft-invalid" : "preview-draft-valid",
      validation ? `Current draft validation: ${validation}` : "Current draft validation: structure and selected rule settings are valid.");
    results.append(draftStatus);

    const describeSideEvaluation = (rules) => {
      if (!rules.length) return "No conditions to evaluate";
      const evaluations = rules.map((rule) => evaluator.evaluateRule(rule, syntheticDataForRule(rule)));
      const failed = evaluations.find((item) => !item.valid || !item.available);
      if (failed) return failed.error || "The rule could not be evaluated with the synthetic inputs.";
      let combined = evaluations[0].matches;
      for (let index = 1; index < evaluations.length; index += 1) {
        combined = rules[index].join === "OR" ? combined || evaluations[index].matches : combined && evaluations[index].matches;
      }
      return `Synthetic conditions ${combined ? "match" : "do not match"}.`;
    };
    const sampleHeading = strategyElement("p", "preview-sample-note", "Per-rule synthetic checks only; conditions are not evaluated on a shared price series.");
    const buyResult = strategyElement("p", "preview-sample-result buy-card-side", `BUY rules: ${describeSideEvaluation(strategyRules.buy)}`);
    const sellResult = strategyElement("p", "preview-sample-result sell-card-side", `SELL rules: ${describeSideEvaluation(strategyRules.sell)}`);
    results.append(sampleHeading, buyResult, sellResult);
  }

  function resetStrategyForm() {
    $("#strategy-form").reset();
    $("#strategy-id").value = "";
    $("#strategy-symbol").value = "XAUUSD";
    $("#strategy-timeframe").value = "1D";
    $("#strategy-stop-type").value = "none";
    $("#strategy-stop-value").value = "";
    $("#strategy-target-type").value = "none";
    $("#strategy-target-value").value = "";
    $("#strategy-stop-value").disabled = true;
    $("#strategy-target-value").disabled = true;
    $("#strategy-stop-value-label").textContent = "Stop-loss value";
    $("#strategy-target-value-label").textContent = "Take-profit value";
    $("#strategy-form-title").textContent = "Create a strategy";
    $("#save-strategy-button").textContent = "Save strategy";
    $("#strategy-form-error").hidden = true;
    $("#strategy-preview-results").replaceChildren(strategyElement("span", "", "Preview has not been run."));
    editingStrategyId = "";
    strategyRules = { buy: [], sell: [] };
    renderRuleGroup("buy");
    renderRuleGroup("sell");
    updateStrategyExitLabels();
  }

  function showStrategyEditor(show) {
    const editor = $("#strategy-editor");
    editor.hidden = !show;
    if (show) {
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => $("#strategy-name").focus(), 100);
    }
  }

  function openNewStrategy() {
    resetStrategyForm();
    showStrategyEditor(true);
  }

  function updateStrategyExitLabels() {
    const stopType = $("#strategy-stop-type").value;
    const targetType = $("#strategy-target-type").value;
    $("#strategy-stop-value").disabled = stopType === "none";
    $("#strategy-target-value").disabled = targetType === "none";
    $("#strategy-stop-value-label").textContent = stopType === "percentage" ? "Stop-loss distance (%)" : stopType === "price-distance" ? "Stop-loss distance (price units)" : "Stop-loss value";
    $("#strategy-target-value-label").textContent = targetType === "percentage" ? "Take-profit distance (%)" : targetType === "price-distance" ? "Take-profit distance (price units)" : targetType === "risk-reward" ? "Reward multiple (R)" : "Take-profit value";
    updateStrategySummary();
  }

  function readStrategyForm() {
    const normalizeRules = (rules) => rules.map((rule) => {
      const normalized = { ...rule };
      ["period", "fast", "slow", "value"].forEach((key) => {
        if (key in normalized) {
          normalized[key] = typeof normalized[key] === "string" && normalized[key].trim() === ""
            ? NaN : Number(normalized[key]);
        }
      });
      return normalized;
    });
    return {
      id: editingStrategyId || $("#strategy-id").value || "",
      name: $("#strategy-name").value.trim(),
      symbol: $("#strategy-symbol").value.trim().toUpperCase(),
      timeframe: $("#strategy-timeframe").value,
      description: $("#strategy-description").value.trim(),
      buyRules: normalizeRules(strategyRules.buy),
      sellRules: normalizeRules(strategyRules.sell),
      stopLoss: { type: $("#strategy-stop-type").value, value: $("#strategy-stop-type").value === "none" ? null : Number($("#strategy-stop-value").value) },
      takeProfit: { type: $("#strategy-target-type").value, value: $("#strategy-target-type").value === "none" ? null : Number($("#strategy-target-value").value) },
      riskPercent: $("#strategy-risk-percent").value.trim() === "" ? null : Number($("#strategy-risk-percent").value),
      updatedAt: new Date().toISOString()
    };
  }

  function validateStrategy(strategy) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return "Strategy data is invalid.";
    if (!strategy.name || strategy.name.length > 80) return "Enter a strategy name of 1–80 characters.";
    if (!strategy.symbol || strategy.symbol.length > 30 || !/^[A-Z0-9._-]+$/.test(strategy.symbol)) return "Enter a valid symbol using letters, numbers, dot, underscore, or hyphen (max 30 characters).";
    if (!Object.prototype.hasOwnProperty.call(TIMEFRAME_LABELS, strategy.timeframe)) return "Choose a valid timeframe.";
    if (strategy.description.length > 1000) return "Description must be 1,000 characters or fewer.";
    if (!strategy.stopLoss || typeof strategy.stopLoss !== "object" || Array.isArray(strategy.stopLoss)) return "Stop-loss settings are incomplete.";
    if (!strategy.takeProfit || typeof strategy.takeProfit !== "object" || Array.isArray(strategy.takeProfit)) return "Take-profit settings are incomplete.";
    if (!Array.isArray(strategy.buyRules) || !Array.isArray(strategy.sellRules)) return "Buy and Sell conditions must be valid rule lists.";
    if (!strategy.buyRules.length && !strategy.sellRules.length) return "Add at least one buy or sell condition before saving.";
    for (const [side, rules] of [["Buy", strategy.buyRules], ["Sell", strategy.sellRules]]) {
      for (let index = 0; index < rules.length; index += 1) {
        if (index > 0 && !["AND", "OR"].includes(rules[index].join)) return `${side} condition ${index + 1}: choose AND or OR.`;
        const error = validateRule(rules[index], `${side} condition ${index + 1}`);
        if (error) return error;
      }
    }
    if (!["none", "price-distance", "percentage"].includes(strategy.stopLoss.type)) return "Choose a valid stop-loss type.";
    if (strategy.stopLoss.type !== "none" && (!Number.isFinite(strategy.stopLoss.value) || strategy.stopLoss.value <= 0)) return "Stop-loss value must be greater than zero.";
    if (!["none", "price-distance", "percentage", "risk-reward"].includes(strategy.takeProfit.type)) return "Choose a valid take-profit type.";
    if (strategy.takeProfit.type !== "none" && (!Number.isFinite(strategy.takeProfit.value) || strategy.takeProfit.value <= 0)) return "Take-profit value must be greater than zero.";
    if (strategy.riskPercent !== null && (!Number.isFinite(strategy.riskPercent) || strategy.riskPercent < 0.01 || strategy.riskPercent > 100)) return "Optional risk percentage must be from 0.01 to 100, or left blank.";
    return "";
  }

  function saveStrategy(event) {
    event.preventDefault();
    const errorElement = $("#strategy-form-error");
    errorElement.hidden = true;
    const strategy = readStrategyForm();
    const validation = validateStrategy(strategy);
    if (validation) {
      errorElement.textContent = validation;
      errorElement.hidden = false;
      return;
    }
    const records = readStrategyRecords();
    if (strategiesStorageError) {
      errorElement.textContent = "Saved strategy data could not be read safely. No strategy changes were made.";
      errorElement.hidden = false;
      return;
    }
    const index = records.findIndex((record) => record.id === strategy.id);
    const existing = index >= 0 ? records[index] : null;
    strategy.id = existing ? existing.id : (strategy.id || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `strategy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`));
    strategy.createdAt = existing ? existing.createdAt : strategy.updatedAt;
    if (index >= 0) records[index] = strategy;
    else records.push(strategy);
    if (persistStrategyRecords(records)) {
      showStrategyEditor(false);
      showToast(index >= 0 ? "Strategy updated and saved locally." : "Strategy saved in this browser.");
      resetStrategyForm();
    }
  }

  function hydrateStrategyForm(strategy, { duplicate = false } = {}) {
    editingStrategyId = duplicate ? "" : strategy.id;
    $("#strategy-id").value = duplicate ? "" : strategy.id;
    $("#strategy-name").value = duplicate ? `${strategy.name} copy`.slice(0, 80) : strategy.name;
    $("#strategy-symbol").value = strategy.symbol || "XAUUSD";
    $("#strategy-timeframe").value = TIMEFRAME_LABELS[strategy.timeframe] ? strategy.timeframe : "1D";
    $("#strategy-description").value = strategy.description || "";
    $("#strategy-stop-type").value = strategy.stopLoss?.type || "none";
    $("#strategy-stop-value").value = strategy.stopLoss?.value ?? "";
    $("#strategy-target-type").value = strategy.takeProfit?.type || "none";
    $("#strategy-target-value").value = strategy.takeProfit?.value ?? "";
    $("#strategy-risk-percent").value = strategy.riskPercent ?? "";
    strategyRules = {
      buy: Array.isArray(strategy.buyRules) ? strategy.buyRules.map((rule) => ({ ...rule, id: rule.id || `rule-${Math.random().toString(36).slice(2, 9)}` })) : [],
      sell: Array.isArray(strategy.sellRules) ? strategy.sellRules.map((rule) => ({ ...rule, id: rule.id || `rule-${Math.random().toString(36).slice(2, 9)}` })) : []
    };
    $("#strategy-form-title").textContent = duplicate ? "Duplicate strategy" : "Edit strategy";
    $("#save-strategy-button").textContent = duplicate ? "Save duplicate" : "Save changes";
    $("#strategy-form-error").hidden = true;
    renderRuleGroup("buy");
    renderRuleGroup("sell");
    updateStrategyExitLabels();
    showStrategyEditor(true);
  }

  function strategyRuleSummary(strategy, side) {
    const rules = side === "buy" ? strategy.buyRules : strategy.sellRules;
    return rules.length ? describeStrategySide(rules) : "No conditions";
  }

  function renderStrategyLibrary() {
    if (!$("#strategy-card-list")) return;
    const strategies = readStrategyRecords();
    const list = $("#strategy-card-list");
    list.replaceChildren();
    strategies.slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).forEach((strategy) => {
      const card = strategyElement("article", "strategy-saved-card");
      const header = strategyElement("div", "strategy-saved-card-header");
      const titleGroup = strategyElement("div", "strategy-saved-title-group");
      const title = strategyElement("h3", "", strategy.name || "Untitled strategy");
      const meta = strategyElement("p", "strategy-card-meta", `${strategy.symbol || "XAUUSD"} · ${TIMEFRAME_LABELS[strategy.timeframe] || strategy.timeframe || "Timeframe not set"}`);
      titleGroup.append(title, meta);
      const actions = strategyElement("div", "strategy-card-actions");
      [["Edit", "edit"], ["Duplicate", "duplicate"], ["Delete", "delete"]].forEach(([label, action]) => {
        const button = strategyElement("button", `strategy-card-action${action === "delete" ? " delete-strategy-action" : ""}`, label);
        button.type = "button";
        button.dataset.strategyAction = action;
        button.dataset.strategyId = String(strategy.id);
        button.setAttribute("aria-label", `${label} strategy ${strategy.name || "Untitled strategy"}`);
        actions.append(button);
      });
      header.append(titleGroup, actions);
      const description = strategyElement("p", "strategy-card-description", strategy.description || "No description added.");
      const rules = strategyElement("div", "strategy-card-rules");
      const buy = strategyElement("p", "strategy-card-side buy-card-side");
      buy.append(strategyElement("strong", "", "BUY WHEN "), document.createTextNode(strategyRuleSummary(strategy, "buy")));
      const sell = strategyElement("p", "strategy-card-side sell-card-side");
      sell.append(strategyElement("strong", "", "SELL WHEN "), document.createTextNode(strategyRuleSummary(strategy, "sell")));
      rules.append(buy, sell);
      const exits = strategyElement("p", "strategy-card-exits", `Stop: ${strategy.stopLoss?.type === "none" ? "not specified" : `${strategy.stopLoss?.value} ${strategy.stopLoss?.type === "percentage" ? "%" : "price units"}`} · Target: ${strategy.takeProfit?.type === "none" ? "not specified" : `${strategy.takeProfit?.value} ${strategy.takeProfit?.type === "risk-reward" ? "R" : strategy.takeProfit?.type === "percentage" ? "%" : "price units"}`}${strategy.riskPercent !== null && strategy.riskPercent !== undefined ? ` · Risk ${strategy.riskPercent}%` : ""}`);
      card.append(header, description, rules, exits);
      list.append(card);
    });
    $("#strategy-count").textContent = strategiesStorageError ? "Strategy data unavailable" : `${strategies.length} saved strateg${strategies.length === 1 ? "y" : "ies"}`;
    $("#strategy-library-empty").hidden = strategies.length > 0 && !strategiesStorageError;
    if (strategiesStorageError) {
      $("#strategy-library-empty").querySelector("strong").textContent = "Saved strategies could not be read";
      $("#strategy-library-empty").querySelector("p").textContent = "GoldTrack has not replaced the unreadable strategy data. Check browser storage before continuing.";
      $("#empty-create-strategy").hidden = true;
    } else {
      $("#strategy-library-empty").querySelector("strong").textContent = "No strategies saved yet";
      $("#strategy-library-empty").querySelector("p").textContent = "Create a visual strategy definition and it will appear here. Saving one does not run it.";
      $("#empty-create-strategy").hidden = false;
    }
    renderBacktestStrategyOptions(strategies);
  }

  function handleStrategyCardAction(event) {
    const button = event.target.closest("button[data-strategy-action]");
    if (!button) return;
    const strategies = readStrategyRecords();
    if (strategiesStorageError) { showToast("Saved strategies are unreadable. No data was changed."); return; }
    const index = strategies.findIndex((strategy) => String(strategy.id) === button.dataset.strategyId);
    if (index < 0) { showToast("That strategy could not be found."); renderStrategyLibrary(); return; }
    const strategy = strategies[index];
    if (button.dataset.strategyAction === "edit") hydrateStrategyForm(strategy);
    if (button.dataset.strategyAction === "duplicate") hydrateStrategyForm(strategy, { duplicate: true });
    if (button.dataset.strategyAction === "delete") {
      if (!window.confirm(`Delete the “${strategy.name || "Untitled strategy"}” strategy? This does not delete journal trades.`)) return;
      if (persistStrategyRecords(strategies.filter((item) => String(item.id) !== button.dataset.strategyId))) showToast("Strategy deleted. Journal records were not changed.");
    }
  }

  function bindStrategyEvents() {
    $("#new-strategy-button").addEventListener("click", openNewStrategy);
    $("#empty-create-strategy").addEventListener("click", openNewStrategy);
    $("#close-strategy-editor").addEventListener("click", () => showStrategyEditor(false));
    $("#cancel-strategy-edit").addEventListener("click", () => { showStrategyEditor(false); resetStrategyForm(); });
    $("#strategy-form").addEventListener("submit", saveStrategy);
    $("#run-strategy-preview").addEventListener("click", runStrategyRulePreview);
    $("#add-buy-rule").addEventListener("click", () => { strategyRules.buy.push(newRule("ema-cross", strategyRules.buy.length ? "AND" : "AND")); renderRuleGroup("buy"); });
    $("#add-sell-rule").addEventListener("click", () => { strategyRules.sell.push(newRule("ema-cross", strategyRules.sell.length ? "AND" : "AND")); renderRuleGroup("sell"); });
    ["#strategy-name", "#strategy-symbol", "#strategy-description", "#strategy-risk-percent", "#strategy-stop-value", "#strategy-target-value"].forEach((selector) => $(selector).addEventListener("input", updateStrategySummary));
    $("#strategy-stop-type").addEventListener("change", updateStrategyExitLabels);
    $("#strategy-target-type").addEventListener("change", updateStrategyExitLabels);
    $("#strategy-timeframe").addEventListener("change", updateStrategySummary);
    $("#strategy-card-list").addEventListener("click", handleStrategyCardAction);
    ["buy", "sell"].forEach((side) => {
      $(`#${side}-rule-list`).addEventListener("input", (event) => {
        const control = event.target.closest("[data-rule-property]");
        if (!control) return;
        const row = control.closest(".strategy-rule-card");
        const rule = strategyRules[side].find((item) => item.id === row?.dataset.ruleId);
        if (!rule) return;
        rule[control.dataset.ruleProperty] = control.value;
        updateStrategySummary();
      });
      $(`#${side}-rule-list`).addEventListener("change", (event) => {
        const control = event.target.closest("[data-rule-property]");
        if (!control) return;
        const row = control.closest(".strategy-rule-card");
        const rule = strategyRules[side].find((item) => item.id === row?.dataset.ruleId);
        if (!rule) return;
        rule[control.dataset.ruleProperty] = control.value;
        updateStrategySummary();
      });
      $(`#${side}-rule-list`).addEventListener("click", (event) => {
        const button = event.target.closest("button[data-remove-rule]");
        if (!button) return;
        strategyRules[side] = strategyRules[side].filter((rule) => rule.id !== button.dataset.removeRule);
        renderRuleGroup(side);
      });
    });
  }

  function showView(name) {
    const validView = ["dashboard", "chart", "journal", "analytics", "risk", "strategy"].includes(name) ? name : "dashboard";
    const dashboardVisible = validView === "dashboard";
    $("#dashboard-view").hidden = validView !== "dashboard";
    $("#chart-view").hidden = validView !== "chart";
    $("#journal-view").hidden = validView !== "journal";
    $("#analytics-view").hidden = validView !== "analytics";
    $("#risk-view").hidden = validView !== "risk";
    $("#strategy-view").hidden = validView !== "strategy";
    $("#dashboard-view").classList.toggle("is-visible", validView === "dashboard");
    $("#chart-view").classList.toggle("is-visible", validView === "chart");
    $("#journal-view").classList.toggle("is-visible", validView === "journal");
    $("#analytics-view").classList.toggle("is-visible", validView === "analytics");
    $("#risk-view").classList.toggle("is-visible", validView === "risk");
    $("#strategy-view").classList.toggle("is-visible", validView === "strategy");
    document.querySelectorAll(".nav-link[data-view]").forEach((button) => {
      const active = button.dataset.view === validView;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    setText("#page-crumb", validView === "dashboard" ? "Dashboard" : validView === "chart" ? "Live Chart" : validView === "journal" ? "Trade Journal" : validView === "analytics" ? "Analytics" : validView === "risk" ? "Risk Management" : "Strategy Builder");
    if (validView === "chart") {
      if (!chartRequested) {
        chartRequested = true;
        loadTradingViewChart();
      }
      window.setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    }
    if (validView === "journal") renderJournal();
    if (validView === "analytics") renderAnalytics();
    if (validView === "risk") renderRiskManagement();
    if (validView === "strategy") renderStrategyLibrary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showChartFailure() {
    clearTimeout(chartLoadTimer);
    chartObserver?.disconnect();
    $("#load-chart-button").disabled = false;
    $("#chart-loading").classList.add("is-hidden");
    $("#tradingview-chart").hidden = true;
    $("#chart-fallback").hidden = false;
  }

  function markChartFrameLoaded(generation) {
    if (generation !== chartGeneration) return;
    clearTimeout(chartLoadTimer);
    chartObserver?.disconnect();
    $("#load-chart-button").disabled = false;
    $("#chart-loading").classList.add("is-hidden");
    $("#chart-fallback").hidden = true;
  }

  function loadTradingViewChart() {
    const fallback = $("#chart-fallback");
    const chartContainer = $("#tradingview-chart");
    const loading = $("#chart-loading");
    const symbolInput = $("#symbol-input");
    const enteredSymbol = safeText(symbolInput.value, "OANDA:XAUUSD").toUpperCase();
    const symbol = enteredSymbol.includes(":") ? enteredSymbol : `OANDA:${enteredSymbol}`;
    if (!/^[A-Z0-9._-]+:[A-Z0-9._-]+$/.test(symbol)) {
      showToast("Enter a valid symbol such as OANDA:XAUUSD.");
      symbolInput.focus();
      return;
    }
    symbolInput.value = symbol;

    const generation = ++chartGeneration;
    fallback.hidden = true;
    chartContainer.hidden = false;
    loading.classList.remove("is-hidden");
    $("#load-chart-button").disabled = true;
    chartContainer.replaceChildren();
    clearTimeout(chartLoadTimer);
    chartObserver?.disconnect();
    const interval = $("#timeframe-select").value;
    const widgetContainer = document.createElement("div");
    widgetContainer.className = "tradingview-widget-container";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widgetContainer.append(widget);

    // Use the official Advanced Chart embed format. Its configuration is read
    // from the contents of this script element by TradingView's embed loader.
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_volume: false,
      withdateranges: true,
      save_image: true,
      details: false,
      calendar: false,
      studies: [],
      support_host: "https://www.tradingview.com",
      backgroundColor: "#0b1220",
      gridColor: "rgba(46, 58, 75, 0.35)"
    });

    // Watch the new widget's iframe before inserting the loader, so its load
    // event cannot be missed. Each requested chart gets one fresh widget mount.
    chartObserver = new MutationObserver(() => {
      const iframe = widgetContainer.querySelector("iframe");
      if (!iframe || iframe.dataset.goldtrackObserved === "true") return;
      iframe.dataset.goldtrackObserved = "true";
      iframe.addEventListener("load", () => markChartFrameLoaded(generation), { once: true });
    });
    chartObserver.observe(widgetContainer, { childList: true, subtree: true });
    script.addEventListener("error", () => {
      if (generation === chartGeneration) showChartFailure();
    }, { once: true });
    widgetContainer.append(script);
    chartContainer.append(widgetContainer);

    // The cross-origin chart contents cannot be inspected by this page. Require
    // the embedded frame's load event; otherwise report a timeout, not success.
    chartLoadTimer = window.setTimeout(() => {
      if (generation === chartGeneration) showChartFailure();
    }, 25000);
  }

  function bindEvents() {
    document.querySelectorAll(".nav-link[data-view]").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.view));
    });
    $("#open-chart-button").addEventListener("click", () => showView("chart"));
    $("#load-chart-button").addEventListener("click", loadTradingViewChart);
    $("#retry-chart-button").addEventListener("click", loadTradingViewChart);
    $("#symbol-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadTradingViewChart();
    });
    bindJournalEvents();
    bindAnalyticsEvents();
    bindRiskEvents();
    bindStrategyEvents();
    window.addEventListener("storage", (event) => {
      if (event.key === STRATEGIES_KEY || event.key === null) renderStrategyLibrary();
      if (event.key === TRADES_KEY || event.key === PREFERENCES_KEY || event.key === null) {
        renderDashboard();
        renderJournal();
        renderAnalytics();
        updateDailyRiskStatus();
        if (event.key === PREFERENCES_KEY || event.key === null) {
          populateRiskSettings();
          setOptionalNumberInput("#risk-calc-balance", readRiskSettings().accountBalance);
          calculateRiskPlan();
        }
      }
      if (event.key === RISK_PLANS_KEY || event.key === null) renderRiskPlans();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        renderDashboard();
        renderJournal();
        renderAnalytics();
        updateDailyRiskStatus();
      }
    });
  }

  function init() {
    bindEvents();
    renderDashboard();
    resetTradeForm();
    renderJournal();
    renderAnalytics();
    populateRiskSettings();
    setRiskCalculatorFromPreferences();
    calculateRiskPlan();
    renderRiskPlans();
    renderStrategyLibrary();
    renderStrategyLibrary();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
