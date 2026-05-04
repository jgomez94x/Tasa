const fs = require("fs/promises");
const path = require("path");

main().catch(error => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const [bcvResult, binanceResult] = await Promise.allSettled([
    getBCVRate(),
    getBinanceRates()
  ]);

  const bcv = bcvResult.status === "fulfilled" ? bcvResult.value : null;
  const binance = binanceResult.status === "fulfilled" ? binanceResult.value.rates : null;
  const binanceDiagnostics = binanceResult.status === "fulfilled" ? binanceResult.value.diagnostics : null;

  if (!bcv && !hasAnyBinanceRate(binance)) {
    throw new Error(JSON.stringify({
      bcv: bcvResult.reason?.message || "Sin respuesta BCV",
      binance: binanceResult.reason?.message || "Sin respuesta Binance"
    }, null, 2));
  }

  const rates = {
    bcv,
    binance,
    warnings: {
      bcv: bcvResult.status === "rejected" ? bcvResult.reason?.message : null,
      binance: binanceResult.status === "rejected" ? binanceResult.reason?.message : null
    },
    diagnostics: {
      binance: binanceDiagnostics
    },
    updatedAt: new Date().toISOString()
  };

  const outputPath = path.join(__dirname, "..", "data", "rates.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(rates, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(rates, null, 2));
}

function hasAnyBinanceRate(rates) {
  return Boolean(rates?.compra || rates?.venta || rates?.promedio);
}

async function getBCVRate() {
  const sources = [
    {
      name: "bcv-api",
      url: "https://bcv-api.rafnixg.dev/rates/",
      parse: extractBCVNumber
    },
    {
      name: "dolarapi",
      url: "https://ve.dolarapi.com/v1/dolares/oficial",
      parse: data => data?.promedio || data?.venta || data?.compra
    },
    {
      name: "dolarflow",
      url: "https://dolarflow.com/api/oficial",
      parse: data => data?.precio
    }
  ];

  const errors = [];

  for (const source of sources) {
    try {
      const data = await fetchJson(source.url, undefined, source.name);
      const rate = source.parse(data);

      if (isValidRate(rate)) {
        return Number(Number(rate).toFixed(2));
      }

      errors.push(`${source.name}: respuesta sin tasa BCV`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

function extractBCVNumber(data) {
  const possibleKeys = [
    "usd",
    "USD",
    "dollar",
    "dolar",
    "DOLAR",
    "Dólar",
    "dólar",
    "rate",
    "value",
    "promedio",
    "price",
    "precio",
    "venta",
    "compra"
  ];

  function walk(obj) {
    if (obj === null || obj === undefined) return null;

    if (typeof obj === "number") {
      if (isValidRate(obj)) return obj;
    }

    if (typeof obj === "string") {
      const num = parseVenezuelanNumber(obj);
      if (isValidRate(num)) return num;
    }

    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        const lowerKey = key.toLowerCase();

        if (possibleKeys.some(k => lowerKey.includes(k.toLowerCase()))) {
          const found = walk(obj[key]);
          if (found) return found;
        }
      }

      for (const key of Object.keys(obj)) {
        const found = walk(obj[key]);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(data);
}

async function getBinanceRates() {
  const [compraResult, ventaResult] = await Promise.allSettled([
    getBinanceP2P("BUY"),
    getBinanceP2P("SELL")
  ]);

  const compraData = compraResult.status === "fulfilled" ? compraResult.value : null;
  const ventaData = ventaResult.status === "fulfilled" ? ventaResult.value : null;
  const compra = compraData?.rate || null;
  const venta = ventaData?.rate || null;
  const valores = [compra, venta].filter(Boolean);

  if (!valores.length) {
    throw new Error([
      compraResult.reason?.message || "Compra P2P sin respuesta",
      ventaResult.reason?.message || "Venta P2P sin respuesta"
    ].join(" | "));
  }

  const promedio = valores.reduce((a, b) => a + b, 0) / valores.length;

  return {
    rates: {
      compra,
      venta,
      promedio: Number(promedio.toFixed(2))
    },
    diagnostics: {
      compra: compraData?.diagnostics || null,
      venta: ventaData?.diagnostics || null
    }
  };
}

async function getBinanceP2P(tradeType) {
  const sourceFns = [
    () => getBinanceP2POld(tradeType),
    () => getBinanceP2PQuote(tradeType),
    () => getBinanceP2PAds(tradeType, "price_asc"),
    () => getBinanceP2PAds(tradeType, "price_desc")
  ];

  const results = [];
  const errors = [];

  for (const source of sourceFns) {
    try {
      const result = await source();
      if (isValidRate(result?.rate)) {
        results.push(result);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!results.length) {
    throw new Error(`Binance P2P ${tradeType}: ${errors.join(" | ")}`);
  }

  const selected = selectConsensusRate(results, tradeType);

  return {
    rate: selected.rate,
    diagnostics: {
      tradeType,
      selectedSource: selected.source,
      selectedMethod: selected.method,
      sourceRates: results.map(result => ({
        source: result.source,
        method: result.method,
        rate: result.rate,
        sampleSize: result.sampleSize,
        samplePrices: result.samplePrices
      })),
      errors
    }
  };
}

async function getBinanceP2POld(tradeType) {
  const url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  const body = {
    page: 1,
    rows: 20,
    payTypes: [],
    asset: "USDT",
    fiat: "VES",
    tradeType,
    publisherType: null
  };

  const data = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(body)
  }, `binance-old-${tradeType}`);

  const prices = (data.data || [])
    .map(item => Number(item?.adv?.price))
    .filter(isValidRate);

  return buildP2PResult(`binance-old-${tradeType}`, tradeType, prices);
}

async function getBinanceP2PQuote(tradeType) {
  const url = `https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price?fiat=VES&asset=USDT&tradeType=${tradeType}`;
  const data = await fetchJson(url, undefined, `binance-quote-${tradeType}`);
  const prices = collectPriceNumbers(data);

  return buildP2PResult(`binance-quote-${tradeType}`, tradeType, prices);
}

async function getBinanceP2PAds(tradeType, order) {
  const url = `https://www.binance.com/bapi/c2c/v1/public/c2c/agent/ad-list?fiat=VES&asset=USDT&tradeType=${tradeType}&limit=20&order=${order}`;
  const data = await fetchJson(url, undefined, `binance-ads-${tradeType}-${order}`);
  const prices = collectPriceNumbers(data);

  return buildP2PResult(`binance-ads-${tradeType}-${order}`, tradeType, prices);
}

function buildP2PResult(source, tradeType, prices) {
  const validPrices = prices.filter(isValidRate);

  if (!validPrices.length) {
    return { source, tradeType, rate: null, method: "no-valid-prices", sampleSize: 0, samplePrices: [] };
  }

  const sorted = [...validPrices].sort((a, b) => a - b);

  // BUY = referencia de compra de USDT con VES: toma el extremo bajo real del mercado.
  // SELL = referencia de venta de USDT por VES: toma el extremo alto real del mercado.
  const marketSidePrices = tradeType === "SELL"
    ? sorted.slice(-5).reverse()
    : sorted.slice(0, 5);

  const rate = average(marketSidePrices);

  return {
    source,
    tradeType,
    rate: Number(rate.toFixed(2)),
    method: tradeType === "SELL" ? "average-highest-5" : "average-lowest-5",
    sampleSize: validPrices.length,
    samplePrices: marketSidePrices.map(price => Number(Number(price).toFixed(2)))
  };
}

function selectConsensusRate(results, tradeType) {
  const validResults = results
    .filter(result => isValidRate(result.rate))
    .sort((a, b) => a.rate - b.rate);

  if (validResults.length === 1) return validResults[0];

  const rates = validResults.map(result => result.rate);
  const median = getMedian(rates);

  // Evita quedarse con una sola fuente desfasada: elige la tasa mas cercana a la mediana.
  const selected = validResults
    .map(result => ({
      ...result,
      distanceFromMedian: Math.abs(result.rate - median)
    }))
    .sort((a, b) => a.distanceFromMedian - b.distanceFromMedian)[0];

  return {
    ...selected,
    method: `${selected.method}-consensus-median-${tradeType}`
  };
}

async function fetchJson(url, options = {}, sourceName = "fuente") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Origin": "https://www.binance.com",
        "Referer": "https://www.binance.com/es-LA/p2p",
        ...(options.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`${sourceName} HTTP ${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function collectPriceNumbers(data) {
  const prices = [];

  function walk(obj, parentKey = "") {
    if (obj === null || obj === undefined) return;

    if (typeof obj === "number" || typeof obj === "string") {
      const lowerKey = parentKey.toLowerCase();
      const num = typeof obj === "number" ? obj : parseVenezuelanNumber(obj);

      if ((lowerKey.includes("price") || lowerKey.includes("precio")) && isValidRate(num)) {
        prices.push(num);
      }

      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, parentKey));
      return;
    }

    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        walk(obj[key], key);
      }
    }
  }

  walk(data);
  return prices.sort((a, b) => a - b);
}

function average(numbers) {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function getMedian(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) return sorted[middle];

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseVenezuelanNumber(value) {
  if (typeof value !== "string") return Number(value);

  const cleaned = value.replace(/[^\d.,]/g, "");

  if (cleaned.includes(",") && cleaned.includes(".")) {
    return Number(cleaned.replace(/\./g, "").replace(",", "."));
  }

  if (cleaned.includes(",")) {
    return Number(cleaned.replace(",", "."));
  }

  return Number(cleaned);
}

function isValidRate(rate) {
  const num = Number(rate);
  return Number.isFinite(num) && num > 10 && num < 10000;
}
