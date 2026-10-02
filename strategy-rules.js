/*
 * GoldTrack visual-rule evaluation foundation.
 * Pure functions only: accepts caller-supplied arrays and never fetches data,
 * reads browser storage, executes strategy-authored code, or places orders.
 */
(function attachGoldTrackRuleEvaluator(root) {
  "use strict";

  const SUPPORTED_RULES = new Set(["ema-cross", "price-ema", "rsi-level", "rsi-cross"]);

  function finiteSeries(series) {
    return Array.isArray(series);
  }

  function finiteAt(series, index) {
    return typeof series[index] === "number" && Number.isFinite(series[index]);
  }

  function validateRule(rule) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "Condition must be an object.";
    if (!SUPPORTED_RULES.has(rule.type)) return "Condition type is unsupported.";

    if (rule.type === "ema-cross") {
      if (!Number.isInteger(rule.fast) || rule.fast < 1 || !Number.isInteger(rule.slow) || rule.slow < 1) return "EMA periods must be positive integers.";
      if (rule.fast === rule.slow) return "Fast and slow EMA periods must be different.";
      if (!["above", "below"].includes(rule.crossing)) return "EMA crossover direction must be above or below.";
      return "";
    }

    if (!Number.isInteger(rule.period) || rule.period < 1) return "Indicator period must be a positive integer.";
    if (rule.type === "price-ema" && !["above", "below"].includes(rule.relation)) return "Price-to-EMA relation must be above or below.";
    if (rule.type === "rsi-level" && !["above", "below"].includes(rule.relation)) return "RSI relation must be above or below.";
    if (rule.type === "rsi-cross" && !["above", "below"].includes(rule.crossing)) return "RSI crossing direction must be above or below.";
    if (rule.type === "rsi-level" || rule.type === "rsi-cross") {
      if (typeof rule.value !== "number" || !Number.isFinite(rule.value) || rule.value < 0 || rule.value > 100) return "RSI threshold must be a number from 0 to 100.";
    }
    return "";
  }

  function unavailable(message) {
    return { valid: true, available: false, matches: null, error: message };
  }

  function evaluationIndex(data, seriesLength) {
    const index = Number.isInteger(data.index) ? data.index : seriesLength - 1;
    if (index < 0 || index >= seriesLength) return null;
    return index;
  }

  function compareCross(previousLeft, currentLeft, previousRight, currentRight, direction) {
    if (direction === "above") return previousLeft <= previousRight && currentLeft > currentRight;
    return previousLeft >= previousRight && currentLeft < currentRight;
  }

  function evaluateRule(rule, data) {
    const validationError = validateRule(rule);
    if (validationError) return { valid: false, available: false, matches: null, error: validationError };
    if (!data || typeof data !== "object" || Array.isArray(data)) return unavailable("Price and indicator data were not supplied.");

    const emaSeries = data.ema && typeof data.ema === "object" && !Array.isArray(data.ema) ? data.ema : {};
    const rsiSeries = data.rsi && typeof data.rsi === "object" && !Array.isArray(data.rsi) ? data.rsi : {};

    if (rule.type === "ema-cross") {
      const fast = emaSeries[String(rule.fast)];
      const slow = emaSeries[String(rule.slow)];
      if (!finiteSeries(fast) || !finiteSeries(slow)) return unavailable("EMA series is missing or contains invalid values.");
      if (fast.length !== slow.length) return unavailable("Fast and slow EMA series must have the same length.");
      const end = evaluationIndex(data, fast.length);
      if (end === null || end < 1) return unavailable("EMA crossover needs at least two values through the requested candle index.");
      if (![fast, slow].every((series) => finiteAt(series, end - 1) && finiteAt(series, end))) return unavailable("EMA values are not initialized at the requested candle index.");
      return { valid: true, available: true, matches: compareCross(fast[end - 1], fast[end], slow[end - 1], slow[end], rule.crossing), error: "" };
    }

    if (rule.type === "price-ema") {
      const prices = data.close;
      const ema = emaSeries[String(rule.period)];
      if (!finiteSeries(prices) || !finiteSeries(ema)) return unavailable("Close-price or EMA series is missing or contains invalid values.");
      if (prices.length < 1 || prices.length !== ema.length) return unavailable("Close-price and EMA series must be non-empty and aligned.");
      const index = evaluationIndex(data, prices.length);
      if (index === null) return unavailable("Price-to-EMA data does not include the requested candle index.");
      if (!finiteAt(prices, index) || !finiteAt(ema, index)) return unavailable("Close or EMA value is not initialized at the requested candle index.");
      const close = prices[index];
      const average = ema[index];
      return { valid: true, available: true, matches: rule.relation === "above" ? close > average : close < average, error: "" };
    }

    const rsi = rsiSeries[String(rule.period)];
    if (!finiteSeries(rsi)) return unavailable("RSI series is missing or contains invalid values.");
    if (rule.type === "rsi-level") {
      const index = evaluationIndex(data, rsi.length);
      if (index === null) return unavailable("RSI data does not include the requested candle index.");
      if (!finiteAt(rsi, index)) return unavailable("RSI value is not initialized at the requested candle index.");
      const current = rsi[index];
      return { valid: true, available: true, matches: rule.relation === "above" ? current > rule.value : current < rule.value, error: "" };
    }
    const index = evaluationIndex(data, rsi.length);
    if (index === null || index < 1) return unavailable("RSI crossing needs at least two values through the requested candle index.");
    if (!finiteAt(rsi, index - 1) || !finiteAt(rsi, index)) return unavailable("RSI crossing values are not initialized at the requested candle index.");
    const previous = rsi[index - 1];
    const current = rsi[index];
    return { valid: true, available: true, matches: compareCross(previous, current, rule.value, rule.value, rule.crossing), error: "" };
  }

  function evaluateGroup(rules, data) {
    if (!Array.isArray(rules)) return { valid: false, available: false, matches: null, error: "Condition group must be a list." };
    if (!rules.length) return { valid: true, available: true, matches: false, error: "" };
    let result = null;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const evaluated = evaluateRule(rule, data);
      if (!evaluated.valid) return evaluated;
      if (!evaluated.available) return evaluated;
      if (index === 0) {
        result = evaluated.matches;
        continue;
      }
      const join = rule.join;
      if (join !== "AND" && join !== "OR") return { valid: false, available: false, matches: null, error: `Condition ${index + 1} must use AND or OR.` };
      result = join === "AND" ? result && evaluated.matches : result || evaluated.matches;
    }
    return { valid: true, available: true, matches: Boolean(result), error: "" };
  }

  function evaluateStrategy(strategy, data) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
      return { valid: false, available: false, error: "Strategy definition must be an object.", buy: null, sell: null };
    }
    const buy = evaluateGroup(strategy.buyRules, data);
    const sell = evaluateGroup(strategy.sellRules, data);
    const invalid = !buy.valid ? buy : !sell.valid ? sell : null;
    const unavailable = !buy.available ? buy : !sell.available ? sell : null;
    return {
      valid: !invalid,
      available: !unavailable,
      error: invalid?.error || unavailable?.error || "",
      buy,
      sell
    };
  }

  function runSyntheticTests() {
    const tests = [];
    function check(name, actual, expected) {
      const passed = actual.valid === expected.valid && actual.available === expected.available && actual.matches === expected.matches;
      tests.push({ name, passed, actual, expected });
    }

    check("EMA crosses above", evaluateRule(
      { type: "ema-cross", fast: 5, slow: 10, crossing: "above" },
      { ema: { "5": [9, 11], "10": [10, 10] } }
    ), { valid: true, available: true, matches: true });

    check("EMA crosses below", evaluateRule(
      { type: "ema-cross", fast: 5, slow: 10, crossing: "below" },
      { ema: { "5": [11, 9], "10": [10, 10] } }
    ), { valid: true, available: true, matches: true });

    check("Price above EMA", evaluateRule(
      { type: "price-ema", period: 20, relation: "above" },
      { close: [105], ema: { "20": [100] } }
    ), { valid: true, available: true, matches: true });

    check("Price below EMA", evaluateRule(
      { type: "price-ema", period: 20, relation: "below" },
      { close: [95], ema: { "20": [100] } }
    ), { valid: true, available: true, matches: true });

    check("RSI below threshold", evaluateRule(
      { type: "rsi-level", period: 14, relation: "below", value: 30 },
      { rsi: { "14": [29] } }
    ), { valid: true, available: true, matches: true });

    check("RSI crosses above threshold", evaluateRule(
      { type: "rsi-cross", period: 14, crossing: "above", value: 30 },
      { rsi: { "14": [29, 31] } }
    ), { valid: true, available: true, matches: true });

    check("RSI crosses below threshold", evaluateRule(
      { type: "rsi-cross", period: 14, crossing: "below", value: 70 },
      { rsi: { "14": [71, 69] } }
    ), { valid: true, available: true, matches: true });

    const missing = evaluateRule({ type: "rsi-level", period: 14, relation: "above", value: 50 }, { rsi: {} });
    check("Missing RSI data is unavailable", missing, { valid: true, available: false, matches: null });

    const invalid = evaluateRule({ type: "rsi-level", period: 14, relation: "above", value: 101 }, { rsi: { "14": [99] } });
    check("Invalid RSI threshold is rejected", invalid, { valid: false, available: false, matches: null });

    const missingEma = evaluateRule({ type: "ema-cross", fast: 9, slow: 9, crossing: "above" }, { ema: {} });
    check("Invalid EMA periods are rejected", missingEma, { valid: false, available: false, matches: null });

    const combined = evaluateGroup([
      { type: "rsi-level", period: 14, relation: "below", value: 30, join: "AND" },
      { type: "price-ema", period: 20, relation: "above", join: "OR" }
    ], { rsi: { "14": [25] }, close: [105], ema: { "20": [100] } });
    check("OR combines supplied synthetic conditions", combined, { valid: true, available: true, matches: true });

    const combinedAnd = evaluateGroup([
      { type: "rsi-level", period: 14, relation: "below", value: 30, join: "AND" },
      { type: "price-ema", period: 20, relation: "above", join: "AND" }
    ], { rsi: { "14": [25] }, close: [105], ema: { "20": [100] } });
    check("AND combines supplied synthetic conditions", combinedAnd, { valid: true, available: true, matches: true });
    return { passed: tests.filter((test) => test.passed).length, total: tests.length, tests };
  }

  root.GoldTrackRuleEvaluator = Object.freeze({ validateRule, evaluateRule, evaluateGroup, evaluateStrategy, runSyntheticTests });
})(typeof window !== "undefined" ? window : globalThis);
