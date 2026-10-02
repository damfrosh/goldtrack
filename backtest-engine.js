/* GoldTrack historical backtest engine. No network, storage, dynamic code, or orders. */
(function attachGoldTrackBacktestEngine(root) {
  "use strict";

  const MAX_BARS = 100000;
  const MAX_CSV_BYTES = 25 * 1024 * 1024;
  const requiredColumns = ["timestamp", "open", "high", "low", "close"];

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === "") quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push(field); field = "";
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
      } else field += char;
    }
    if (quoted) throw new Error("CSV contains an unfinished quoted field.");
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    if (rows.length < 2) throw new Error("CSV needs a header and at least one candle row.");
    return rows;
  }

  function timestampHeaderIndex(headers) {
    const accepted = ["timestamp", "datetime", "date_time", "date", "time"];
    return headers.findIndex((header) => accepted.includes(header));
  }

  function parseCandlesCsv(text, byteLength = 0) {
    if (typeof text !== "string" || !text.trim()) throw new Error("The CSV file is empty.");
    if (byteLength > MAX_CSV_BYTES) throw new Error("CSV files must be 25 MB or smaller.");
    const rows = parseCsvRows(text);
    const headers = rows[0].map((cell) => cell.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
    const timeIndex = timestampHeaderIndex(headers);
    const indexes = { timestamp: timeIndex, open: headers.indexOf("open"), high: headers.indexOf("high"), low: headers.indexOf("low"), close: headers.indexOf("close") };
    const missing = requiredColumns.filter((column) => indexes[column] < 0);
    if (missing.length) throw new Error(`CSV is missing required column(s): ${missing.join(", ")}. Required headers: timestamp (or datetime/date/time), open, high, low, close.`);
    const candles = [];
    let previousTime = -Infinity;
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      if (candles.length >= MAX_BARS) throw new Error(`CSV is limited to ${MAX_BARS.toLocaleString()} candles.`);
      const cells = rows[rowIndex];
      const timeRaw = (cells[indexes.timestamp] || "").trim();
      const time = Date.parse(timeRaw);
      if (!timeRaw || !Number.isFinite(time)) throw new Error(`CSV row ${rowIndex + 1}: invalid timestamp. ISO 8601 with timezone is recommended.`);
      if (time <= previousTime) throw new Error(`CSV row ${rowIndex + 1}: candles must be in strictly increasing timestamp order with no duplicates.`);
      previousTime = time;
      const candle = { timestamp: time, timestampText: timeRaw };
      for (const column of ["open", "high", "low", "close"]) {
        const raw = (cells[indexes[column]] || "").trim();
        const number = Number(raw);
        if (!raw || !Number.isFinite(number) || number <= 0) throw new Error(`CSV row ${rowIndex + 1}: ${column} must be a positive finite number.`);
        candle[column] = number;
      }
      if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) {
        throw new Error(`CSV row ${rowIndex + 1}: OHLC values are inconsistent (high/low must contain open and close).`);
      }
      candle.volume = headers.includes("volume") && Number.isFinite(Number(cells[headers.indexOf("volume")])) ? Number(cells[headers.indexOf("volume")]) : null;
      candles.push(candle);
    }
    if (!candles.length) throw new Error("No candle rows were found in the CSV.");
    return candles;
  }

  function simpleEma(values, period) {
    const output = Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1) return output;
    if (values.length < period) return output;
    let seed = 0;
    for (let i = 0; i < period; i += 1) seed += values[i];
    let previous = seed / period;
    output[period - 1] = previous;
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) {
      previous = (values[i] - previous) * alpha + previous;
      output[i] = previous;
    }
    return output;
  }

  function wilderRsi(values, period) {
    const output = Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length <= period) return output;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
      const change = values[i] - values[i - 1];
      if (change > 0) gain += change;
      else loss -= change;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    output[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i += 1) {
      const change = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
      output[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return output;
  }

  function indicatorPeriods(strategy) {
    const ema = new Set();
    const rsi = new Set();
    for (const rule of [...(strategy.buyRules || []), ...(strategy.sellRules || [])]) {
      if (rule.type === "ema-cross") { ema.add(rule.fast); ema.add(rule.slow); }
      if (rule.type === "price-ema") ema.add(rule.period);
      if (rule.type === "rsi-level" || rule.type === "rsi-cross") rsi.add(rule.period);
    }
    return { ema: [...ema], rsi: [...rsi] };
  }

  function buildIndicators(candles, strategy) {
    const closes = candles.map((candle) => candle.close);
    const periods = indicatorPeriods(strategy);
    const ema = {};
    const rsi = {};
    periods.ema.forEach((period) => { ema[String(period)] = simpleEma(closes, period); });
    periods.rsi.forEach((period) => { rsi[String(period)] = wilderRsi(closes, period); });
    return { close: closes, ema, rsi };
  }

  function validateSettings(strategy, candles, settings) {
    if (!strategy || typeof strategy !== "object") return "Select a valid saved strategy.";
    if (!Array.isArray(strategy.buyRules) || !Array.isArray(strategy.sellRules) || (!strategy.buyRules.length && !strategy.sellRules.length)) return "The selected strategy has no valid Buy or Sell rules.";
    const evaluator = root.GoldTrackRuleEvaluator;
    if (!evaluator) return "The strategy rule evaluator did not load.";
    for (const rule of [...strategy.buyRules, ...strategy.sellRules]) {
      const error = evaluator.validateRule(rule);
      if (error) return `Saved strategy contains an invalid rule: ${error}`;
    }
    if (!Array.isArray(candles) || !candles.length) return "Load a valid historical candle dataset first.";
    if (!Number.isFinite(settings.startingBalance) || settings.startingBalance <= 0) return "Starting balance must be greater than zero.";
    if (!Number.isFinite(settings.pointValue) || settings.pointValue <= 0) return "Enter the verified account-currency value per 1.0 price move per position unit.";
    if (!Number.isFinite(settings.spread) || settings.spread < 0) return "Spread must be zero or greater.";
    if (!Number.isFinite(settings.commissionPerUnitSide) || settings.commissionPerUnitSide < 0) return "Commission must be zero or greater.";
    if (!Number.isFinite(settings.slippage) || settings.slippage < 0) return "Slippage must be zero or greater.";
    if (settings.sizingMode === "fixed" && (!Number.isFinite(settings.fixedUnits) || settings.fixedUnits <= 0)) return "Fixed position units must be greater than zero.";
    if (settings.sizingMode === "risk" && (!Number.isFinite(settings.riskPercent) || settings.riskPercent <= 0 || settings.riskPercent > 100)) return "Risk percentage must be greater than 0 and no more than 100.";
    if (settings.dateFrom && !Number.isFinite(Date.parse(settings.dateFrom))) return "From date is invalid.";
    if (settings.dateTo && !Number.isFinite(Date.parse(`${settings.dateTo}T23:59:59.999Z`))) return "To date is invalid.";
    if (settings.dateFrom && settings.dateTo && settings.dateFrom > settings.dateTo) return "From date must not be after To date.";
    const stopType = strategy.stopLoss?.type || "none";
    const targetType = strategy.takeProfit?.type || "none";
    if (stopType !== "none" && (!Number.isFinite(Number(strategy.stopLoss.value)) || Number(strategy.stopLoss.value) <= 0)) return "Strategy stop-loss setting is invalid.";
    if (targetType !== "none" && (!Number.isFinite(Number(strategy.takeProfit.value)) || Number(strategy.takeProfit.value) <= 0)) return "Strategy take-profit setting is invalid.";
    if (settings.sizingMode === "risk" && stopType === "none") return "Risk-percentage sizing requires a strategy stop-loss distance.";
    return "";
  }

  function dateBounds(settings) {
    return {
      from: settings.dateFrom ? Date.parse(`${settings.dateFrom}T00:00:00.000Z`) : -Infinity,
      to: settings.dateTo ? Date.parse(`${settings.dateTo}T23:59:59.999Z`) : Infinity
    };
  }

  function strategySignal(strategy, indicators, index) {
    // Give the rule evaluator only the history available at this bar's close;
    // later candles cannot be observed even accidentally by a future rule.
    const asOf = {
      close: indicators.close.slice(0, index + 1),
      ema: Object.fromEntries(Object.entries(indicators.ema).map(([period, values]) => [period, values.slice(0, index + 1)])),
      rsi: Object.fromEntries(Object.entries(indicators.rsi).map(([period, values]) => [period, values.slice(0, index + 1)])),
      index
    };
    const evaluated = root.GoldTrackRuleEvaluator.evaluateStrategy(strategy, asOf);
    if (!evaluated.valid) return { error: evaluated.error };
    if (!evaluated.available) return { unavailable: evaluated.error };
    const buy = evaluated.buy.matches;
    const sell = evaluated.sell.matches;
    if (buy && sell) return { conflict: true };
    return { side: buy ? "long" : sell ? "short" : null };
  }

  function computeExitLevels(strategy, direction, entryFill) {
    const sign = direction === "long" ? 1 : -1;
    const stopType = strategy.stopLoss?.type || "none";
    const stopValue = Number(strategy.stopLoss?.value);
    let stop = null;
    if (stopType === "price-distance") stop = entryFill - sign * stopValue;
    else if (stopType === "percentage") stop = entryFill * (1 - sign * stopValue / 100);
    const targetType = strategy.takeProfit?.type || "none";
    const targetValue = Number(strategy.takeProfit?.value);
    let target = null;
    if (targetType === "price-distance") target = entryFill + sign * targetValue;
    else if (targetType === "percentage") target = entryFill * (1 + sign * targetValue / 100);
    else if (targetType === "risk-reward" && stop !== null) target = entryFill + sign * Math.abs(entryFill - stop) * targetValue;
    return { stop, target };
  }

  function positionUnits(settings, stopDistance) {
    if (settings.sizingMode === "fixed") return settings.fixedUnits;
    const riskBudget = settings.startingBalance * settings.riskPercent / 100;
    const perUnitRisk = stopDistance * settings.pointValue + settings.spread * settings.pointValue + settings.slippage * 2 * settings.pointValue + settings.commissionPerUnitSide * 2;
    if (!(Number.isFinite(perUnitRisk) && perUnitRisk > 0)) return null;
    return riskBudget / perUnitRisk;
  }

  function adversePrice(price, direction, isEntry, settings) {
    const directionSign = direction === "long" ? 1 : -1;
    const entrySign = isEntry ? 1 : -1;
    return price + directionSign * entrySign * (settings.spread / 2 + settings.slippage);
  }

  function findExit(position, candle, settings) {
    const isLong = position.direction === "long";
    const stopHit = position.stop !== null && (isLong ? candle.low <= position.stop : candle.high >= position.stop);
    const targetHit = position.target !== null && (isLong ? candle.high >= position.target : candle.low <= position.target);
    if (stopHit && targetHit) {
      const gapPrice = isLong ? (candle.open < position.stop ? candle.open : position.stop) : (candle.open > position.stop ? candle.open : position.stop);
      return { reference: gapPrice, reason: "Stop (both hit; conservative stop-first assumption)", ambiguous: true };
    }
    if (stopHit) {
      const gapPrice = isLong ? (candle.open < position.stop ? candle.open : position.stop) : (candle.open > position.stop ? candle.open : position.stop);
      return { reference: gapPrice, reason: candle.open !== gapPrice && candle.open !== position.stop ? "Stop (gap-through fill at open)" : "Stop-loss", ambiguous: false };
    }
    if (targetHit) {
      const favorableGap = isLong ? candle.open > position.target : candle.open < position.target;
      return { reference: favorableGap ? candle.open : position.target, reason: favorableGap ? "Take-profit (favorable gap at open)" : "Take-profit", ambiguous: false };
    }
    return null;
  }

  function closePosition(position, candle, referenceExit, reason, ambiguous, settings) {
    const exitFill = adversePrice(referenceExit, position.direction, false, settings);
    const directionSign = position.direction === "long" ? 1 : -1;
    const grossPnl = (referenceExit - position.referenceEntry) * directionSign * position.units * settings.pointValue;
    const priceCosts = (settings.spread + settings.slippage * 2) * position.units * settings.pointValue;
    const commission = settings.commissionPerUnitSide * position.units * 2;
    const costs = priceCosts + commission;
    const netPnl = grossPnl - costs;
    return {
      direction: position.direction === "long" ? "Buy" : "Sell",
      entryTime: position.entryTime,
      exitTime: candle.timestamp,
      entryFill: position.entryFill,
      exitFill,
      units: position.units,
      grossPnl,
      priceCosts,
      commission,
      totalCosts: costs,
      netPnl,
      exitReason: reason,
      ambiguous
    };
  }

  function runBacktest(strategy, candles, settings) {
    const settingsError = validateSettings(strategy, candles, settings || {});
    if (settingsError) throw new Error(settingsError);
    const evaluator = root.GoldTrackRuleEvaluator;
    const indicators = buildIndicators(candles, strategy);
    const bounds = dateBounds(settings);
    const eligible = candles.map((candle, index) => ({ candle, index })).filter(({ candle }) => candle.timestamp >= bounds.from && candle.timestamp <= bounds.to);
    if (!eligible.length) throw new Error("No candles fall inside the selected date range.");
    const startIndex = eligible[0].index;
    const endIndex = eligible[eligible.length - 1].index;
    let position = null;
    let pending = null;
    let skippedAtEnd = 0;
    let unavailableSignals = 0;
    let conflictingSignals = 0;
    const trades = [];
    const equity = [{ timestamp: candles[startIndex].timestamp, balance: settings.startingBalance }];
    let balance = settings.startingBalance;

    for (let index = startIndex; index <= endIndex; index += 1) {
      const candle = candles[index];
      if (pending && pending.entryIndex === index) {
        const direction = pending.direction;
        const rawEntry = candle.open;
        const entryFill = adversePrice(rawEntry, direction, true, settings);
        const levels = computeExitLevels(strategy, direction, entryFill);
        if (levels.stop !== null && ((direction === "long" && levels.stop >= entryFill) || (direction === "short" && levels.stop <= entryFill))) {
          pending = null;
        } else {
          const stopDistance = levels.stop === null ? null : Math.abs(entryFill - levels.stop);
          const units = positionUnits(settings, stopDistance);
          if (Number.isFinite(units) && units > 0) {
            position = { direction, entryIndex: index, entryTime: candle.timestamp, referenceEntry: rawEntry, entryFill, units, stop: levels.stop, target: levels.target };
          }
          pending = null;
        }
      }

      if (position) {
        const exit = findExit(position, candle, settings);
        if (exit) {
          const trade = closePosition(position, candle, exit.reference, exit.reason, exit.ambiguous, settings);
          trades.push(trade);
          balance += trade.netPnl;
          equity.push({ timestamp: candle.timestamp, balance });
          position = null;
        }
      }

      if (!position && !pending && index < endIndex) {
        const signal = strategySignal(strategy, indicators, index);
        if (signal.unavailable) unavailableSignals += 1;
        else if (signal.conflict) conflictingSignals += 1;
        else if (signal.side) pending = { direction: signal.side, entryIndex: index + 1 };
      } else if (!position && !pending && index === endIndex) {
        const signal = strategySignal(strategy, indicators, index);
        if (signal.side) skippedAtEnd += 1;
        if (signal.unavailable) unavailableSignals += 1;
      }
    }

    if (position) {
      const finalCandle = candles[endIndex];
      const trade = closePosition(position, finalCandle, finalCandle.close, "End of selected data", false, settings);
      trades.push(trade);
      balance += trade.netPnl;
      equity.push({ timestamp: finalCandle.timestamp, balance });
    }

    const wins = trades.filter((trade) => trade.netPnl > 0);
    const losses = trades.filter((trade) => trade.netPnl < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
    let peak = settings.startingBalance;
    let maxDrawdown = 0;
    equity.forEach((point) => {
      peak = Math.max(peak, point.balance);
      maxDrawdown = Math.max(maxDrawdown, peak - point.balance);
    });
    const totalCosts = trades.reduce((sum, trade) => sum + trade.totalCosts, 0);
    return {
      trades,
      equity,
      startingBalance: settings.startingBalance,
      endingBalance: balance,
      netPnl: balance - settings.startingBalance,
      closedTradeCount: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: trades.length - wins.length - losses.length,
      winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) * 100 : null,
      grossProfit,
      grossLoss,
      averageWin: wins.length ? grossProfit / wins.length : null,
      averageLoss: losses.length ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdown,
      totalCosts,
      skippedAtEnd,
      unavailableSignals,
      conflictingSignals,
      candleCount: endIndex - startIndex + 1,
      firstTimestamp: candles[startIndex].timestamp,
      lastTimestamp: candles[endIndex].timestamp,
      assumptions: { shortSelling: "Symmetric linear short positions; no borrow/funding fees.", ambiguousCandle: "When stop and target both touch within one OHLC candle, stop is assumed first.", entry: "Signal at candle close; entry at next candle open with configured adverse spread/slippage." }
    };
  }

  function runSyntheticTests() {
    const tests = [];
    const assert = (name, condition, details = "") => tests.push({ name, passed: Boolean(condition), details: condition ? "" : details });
    const closes = [10, 11, 12, 11, 10, 9, 11, 13, 12, 14, 15, 14, 16, 18, 17, 19, 20, 19, 21, 22, 23, 22, 24, 25, 24, 26, 28, 27, 29, 30, 29, 31, 32, 31, 33, 34, 33, 35, 36, 35];
    const ema = simpleEma(closes, 5);
    const rsi = wilderRsi(closes, 5);
    assert("EMA SMA seed and finite continuation", Number.isFinite(ema[4]) && ema.slice(4).every(Number.isFinite), "EMA failed to initialize/continue.");
    assert("RSI warmup then bounded values", rsi.slice(0, 5).every((value) => value === null) && rsi.slice(5).every((value) => Number.isFinite(value) && value >= 0 && value <= 100), "RSI warmup or range is incorrect.");
    assert("RSI flat series is neutral", wilderRsi(Array(8).fill(5), 3)[3] === 50, "Flat RSI should initialize to 50.");

    const evaluator = root.GoldTrackRuleEvaluator;
    const base = { startingBalance: 10000, sizingMode: "fixed", fixedUnits: 1, riskPercent: 1, pointValue: 1, spread: 0, commissionPerUnitSide: 0, slippage: 0, dateFrom: "", dateTo: "" };
    const syntheticBars = (prices) => prices.map((close, index) => ({ timestamp: Date.UTC(2024, 0, index + 1), timestampText: `2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 }));
    function testStrategy(rules, exit = { type: "none", value: null }, target = { type: "none", value: null }) {
      return { symbol: "TEST", timeframe: "1D", buyRules: rules.buy || [], sellRules: rules.sell || [], stopLoss: exit, takeProfit: target };
    }
    function backtest(name, strategy, candles, settings, assertion) {
      try { const result = runBacktest(strategy, candles, settings); assert(name, assertion(result), JSON.stringify({ trades: result.trades, netPnl: result.netPnl })); }
      catch (error) { assert(name, false, error.message); }
    }

    const buyStrat = testStrategy({ buy: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "above" }] });
    const risingCross = syntheticBars([3, 3, 1, 3, 4]);
    backtest("Buy entry executes at next candle open", buyStrat, risingCross, base, (result) => result.trades.length === 1 && result.trades[0].direction === "Buy" && result.trades[0].entryTime === Date.UTC(2024, 0, 5) && result.trades[0].entryFill === 4);
    const sellStrat = testStrategy({ sell: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "below" }] });
    backtest("Sell entry follows sell rule", sellStrat, syntheticBars([1, 1, 3, 1, 1]), base, (result) => result.trades.length === 1 && result.trades[0].direction === "Sell");
    const stopBars = syntheticBars([3, 3, 1, 3, 4, 3]);
    stopBars[5].high = 4.2; stopBars[5].low = 2.8;
    backtest("Stop-loss exit", testStrategy({ buy: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "above" }] }, { type: "price-distance", value: 1 }), stopBars, base, (result) => result.trades.length === 1 && result.trades[0].exitReason.includes("Stop"));
    const targetBars = syntheticBars([3, 3, 1, 3, 4, 5]);
    targetBars[5].high = 5.2; targetBars[5].low = 3.8;
    backtest("Take-profit exit", testStrategy({ buy: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "above" }] }, { type: "none", value: null }, { type: "price-distance", value: 1 }), targetBars, base, (result) => result.trades.length === 1 && result.trades[0].exitReason.includes("Take-profit"));
    const costBase = { ...base, spread: 0.2, commissionPerUnitSide: 0.1, slippage: 0.1 };
    backtest("Spread, commission, and slippage reduce net", buyStrat, syntheticBars([3, 2, 3, 4]), costBase, (result) => result.trades.length === 1 && result.trades[0].totalCosts > 0 && result.netPnl < result.trades[0].grossPnl);
    backtest("No signals returns no trades", testStrategy({ buy: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "above" }] }), syntheticBars([1, 2, 3, 4]), base, (result) => result.trades.length === 0);
    let invalidCaught = false;
    try { runBacktest(buyStrat, syntheticBars([3, 2, 3]), { ...base, spread: -1 }); } catch (_) { invalidCaught = true; }
    assert("Invalid assumptions are rejected", invalidCaught);
    const drawdownResult = runBacktest(buyStrat, syntheticBars([3, 2, 4, 2, 1]), base);
    assert("Drawdown and profit factor are computed", Number.isFinite(drawdownResult.maxDrawdown) && drawdownResult.maxDrawdown >= 0 && (drawdownResult.profitFactor === null || Number.isFinite(drawdownResult.profitFactor)));
    const endResult = runBacktest(buyStrat, syntheticBars([3, 3, 1, 3]), base);
    assert("End-of-data signal is skipped, not filled from future", endResult.skippedAtEnd >= 1 && endResult.trades.length === 0);
    const bothTouchedStrategy = testStrategy({ buy: [{ type: "ema-cross", fast: 1, slow: 2, crossing: "above" }] }, { type: "price-distance", value: 1 }, { type: "price-distance", value: 1 });
    const bothTouchedBars = syntheticBars([3, 3, 1, 3, 4, 4]);
    bothTouchedBars[5].high = 5.5; bothTouchedBars[5].low = 2.5;
    const bothTouched = runBacktest(bothTouchedStrategy, bothTouchedBars, base);
    assert("Same-candle stop and target uses conservative stop first", bothTouched.trades.length === 1 && bothTouched.trades[0].ambiguous && bothTouched.trades[0].exitReason.includes("stop-first"));
    const insufficient = runBacktest(testStrategy({ buy: [{ type: "rsi-level", period: 14, relation: "below", value: 30 }] }), syntheticBars([1, 2, 3, 4]), base);
    assert("Insufficient RSI history creates no trades", insufficient.trades.length === 0 && insufficient.unavailableSignals > 0);
    return { passed: tests.filter((test) => test.passed).length, total: tests.length, tests };
  }

  root.GoldTrackBacktestEngine = Object.freeze({
    MAX_BARS,
    MAX_CSV_BYTES,
    parseCandlesCsv,
    simpleEma,
    wilderRsi,
    buildIndicators,
    validateSettings,
    runBacktest,
    runSyntheticTests
  });
})(typeof window !== "undefined" ? window : globalThis);
