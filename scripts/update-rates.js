const fs = require("fs/promises");
const path = require("path");

const BINANCE_PAY_TYPE_GROUPS = [
  { label: "BBVA", payTypes: ["BBVA"] },
  { label: "Provincial", payTypes: ["Provincial"] },
  { label: "Banco Provincial", payTypes: ["Banco Provincial"] },
  { label: "Todos los bancos", payTypes: [] }
];

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
  const attempts = [];
  const errors = [];

  for (const group of BINANCE_PAY_TYPE_GROUPS) {
    try {
      const result = await getBinanceP2PAdsByPayType(tradeType, group);
      attempts.push(result);

      // Si BBVA/Provincial devuelve al menos 5 anuncios, usamos esa referencia y no seguimos probando.
      if (isValidRate(result.rate) && result.sampleSize >= 5 && group.payTypes.length) {
        return buildFinalP2PResponse(result, tradeType, attempts, errors);
      }

      // Fallback general si no encontramos banco especifico.
      if (isValidRate(result.rate) && result.sampleSize >= 5 && !group.payTypes.length) {
        return buildFinalP2PResponse(result, tradeType, attempts, errors);
      }
    } catch (error) {
      errors.push(`${group.label}: ${error.message}`);
    }
  }

  const validAttempts = attempts.filter(attempt => isValidRate(attempt.rate));
  if (validAttempts.length) {
    const selected = validAttempts.sort((a, b) => b.sampleSize - a.sampleSize)[0];
    return buildFinalP2PResponse(selected, tradeType, attempts, errors);
  }

  throw new Error(`Binance P2P ${tradeType}: ${errors.join(" | ")}`);
}

function buildFinalP2PResponse(selected, tradeType, attempts, errors) {
  return {
    rate: selected.rate,
    diagnostics: {
      tradeType,
      selectedBank: selected.bankLabel,
      selectedPayTypes: selected.payTypes,
      selectedMethod: selected.method,
      selectedSource: selected.source,
      sourceRates: attempts.map(result => ({
        source: result.source,
        bankLabel: result.bankLabel,
        payTypes: result.payTypes,
        method: result.method,
        rate: result.rate,
        sampleSize: result.sampleSize,
        rawSampleSize: result.rawSampleSize,
        samplePrices: result.samplePrices,
        ignoredOutliers: result.ignoredOutliers
      })),
      errors
    }
  };
}

async function getBinanceP2PAdsByPayType(tradeType, group) {
  const url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  const body = {
    page: 1,
    rows: 20,
    payTypes: group.payTypes,
    asset: "USDT",
    fiat: "VES",
    tradeType,
    publisherType: null
  };

  const data = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(body)
  }, `binance-p2p-${tradeType}-${group.label}`);

  const prices = (data.data || [])
    .map(item => Number(item?.adv?.price))
    .filter(isValidRate);

  return buildP2PResult({
    source: `binance-p2p-${tradeType}`,
    tradeType,
    prices,
    bankLabel: group.label,
    payTypes: group.payTypes
  });
}

function buildP2PResult({ source, tradeType, prices, bankLabel, payTypes }) {
  const validPrices = prices.filter(isValidRate).sort((a, b) => a - b);

  if (!validPrices.length) {
    return {
      source,
      tradeType,
      rate: null,
      method: "no-valid-prices",
      bankLabel,
      payTypes,
      sampleSize: 0,
      rawSampleSize: 0,
      samplePrices: [],
      ignoredOutliers: []
    };
  }

  const cleanedPrices = removeExtremeOutliers(validPrices);
  const workingPrices = cleanedPrices.kept.length >= 5 ? cleanedPrices.kept : validPrices;

  // BUY: promedio de los 5 primeros precios bajos.
  // SELL: promedio de los 5 precios altos, pero despues de quitar extremos raros.
  const selectedPrices = tradeType === "SELL"
    ? workingPrices.slice(-5).reverse()
    : workingPrices.slice(0, 5);

  const rate = average(selectedPrices);

  return {
    source,
    tradeType,
    rate: Number(rate.toFixed(2)),
    method: tradeType === "SELL" ? "avg-highest-5-filtered" : "avg-lowest-5-filtered",
    bankLabel,
    payTypes,
    sampleSize: workingPrices.length,
    rawSampleSize: validPrices.length,
    samplePrices: selectedPrices.map(price => Number(Number(price).toFixed(2))),
    ignoredOutliers: cleanedPrices.removed.map(price => Number(Number(price).toFixed(2)))
  };
}

function removeExtremeOutliers(sortedPrices) {
  if (sortedPrices.length < 7) {
    return { kept: sortedPrices, removed: [] };
  }

  const median = getMedian(sortedPrices);
  const maxDistance = median * 0.015; // 1.5% alrededor de la mediana para evitar anuncios inflados o muy bajos.
  let kept = sortedPrices.filter(price => Math.abs(price - median) <= maxDistance);

  if (kept.length < 5) {
    const widerDistance = median * 0.025;
    kept = sortedPrices.filter(price => Math.abs(price - median) <= widerDistance);
  }

  if (kept.length < 5) {
    kept = sortedPrices;
  }

  const keptSet = new Map();
  kept.forEach(price => keptSet.set(price, (keptSet.get(price) || 0) + 1));

  const removed = [];
  for (const price of sortedPrices) {
    const count = keptSet.get(price) || 0;
    if (count > 0) {
      keptSet.set(price, count - 1);
    } else {
      removed.push(price);
    }
  }

  return { kept, removed };
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
