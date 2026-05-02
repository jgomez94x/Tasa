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
  const binance = binanceResult.status === "fulfilled" ? binanceResult.value : null;

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

  const compra = compraResult.status === "fulfilled" ? compraResult.value : null;
  const venta = ventaResult.status === "fulfilled" ? ventaResult.value : null;
  const valores = [compra, venta].filter(Boolean);

  if (!valores.length) {
    throw new Error([
      compraResult.reason?.message || "Compra P2P sin respuesta",
      ventaResult.reason?.message || "Venta P2P sin respuesta"
    ].join(" | "));
  }

  const promedio = valores.reduce((a, b) => a + b, 0) / valores.length;

  return {
    compra,
    venta,
    promedio: Number(promedio.toFixed(2))
  };
}

async function getBinanceP2P(tradeType) {
  const errors = [];
  const sources = [
    () => getBinanceP2POld(tradeType),
    () => getBinanceP2PQuote(tradeType),
    () => getBinanceP2PAds(tradeType)
  ];

  for (const source of sources) {
    try {
      const rate = await source();
      if (isValidRate(rate)) return Number(Number(rate).toFixed(2));
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`Binance P2P ${tradeType}: ${errors.join(" | ")}`);
}

async function getBinanceP2POld(tradeType) {
  const url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  const body = {
    page: 1,
    rows: 10,
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
    .filter(isValidRate)
    .sort((a, b) => a - b);

  return averageTopPrices(prices);
}

async function getBinanceP2PQuote(tradeType) {
  const url = `https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price?fiat=VES&asset=USDT&tradeType=${tradeType}`;
  const data = await fetchJson(url, undefined, `binance-quote-${tradeType}`);
  const prices = collectPriceNumbers(data);

  return averageTopPrices(prices);
}

async function getBinanceP2PAds(tradeType) {
  const url = `https://www.binance.com/bapi/c2c/v1/public/c2c/agent/ad-list?fiat=VES&asset=USDT&tradeType=${tradeType}&limit=10&order=price_asc`;
  const data = await fetchJson(url, undefined, `binance-ads-${tradeType}`);
  const prices = collectPriceNumbers(data);

  return averageTopPrices(prices);
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
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://www.binance.com",
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

function averageTopPrices(prices) {
  const validPrices = prices.filter(isValidRate).sort((a, b) => a - b);
  if (!validPrices.length) return null;

  const topPrices = validPrices.slice(0, 5);
  const average = topPrices.reduce((a, b) => a + b, 0) / topPrices.length;

  return Number(average.toFixed(2));
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
