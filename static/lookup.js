let lookupChart = null;
let currentTicker = "";
let currentPeriod = "5d";

function handleSearch(e) {
  e.preventDefault();
  const input = document.getElementById("ticker-input");
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return false;
  searchTicker(ticker);
  return false;
}

async function searchTicker(ticker) {
  const btn = document.getElementById("search-btn");
  const loading = document.getElementById("loading");
  const results = document.getElementById("results");
  const errorMsg = document.getElementById("error-msg");

  btn.disabled = true;
  btn.textContent = "Searching...";
  loading.classList.remove("hidden");
  results.classList.add("hidden");
  errorMsg.classList.add("hidden");

  try {
    const resp = await fetch(`/api/lookup/${ticker}`);
    if (!resp.ok) {
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const errData = await resp.json();
        errorMsg.textContent = errData.error || resp.statusText;
      } else {
        errorMsg.textContent = "Server returned " + resp.status + " — the request may have timed out. Try again.";
      }
      errorMsg.classList.remove("hidden");
      return;
    }
    const data = await resp.json();

    if (data.error) {
      errorMsg.textContent = data.error;
      errorMsg.classList.remove("hidden");
      return;
    }

    currentTicker = ticker;
    renderLookup(data);
    results.classList.remove("hidden");

    // Load chart
    initLookupChart();
  } catch (err) {
    errorMsg.textContent = "Search failed: " + err.message;
    errorMsg.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
    loading.classList.add("hidden");
  }
}

function renderLookup(data) {
  document.getElementById("res-symbol").textContent = data.ticker;
  document.getElementById("res-company").textContent = data.company;
  document.getElementById("res-industry").textContent =
    [data.sector, data.industry].filter(Boolean).join(" / ");

  const priceEl = document.getElementById("res-price");
  priceEl.textContent = data.price != null ? "$" + data.price.toFixed(2) : "-";

  const changeEl = document.getElementById("res-change");
  if (data.change != null) {
    const sign = data.change >= 0 ? "+" : "";
    changeEl.textContent = sign + data.change.toFixed(2) + "%";
    changeEl.className = "price-change " + (data.change >= 0 ? "positive" : "negative");
  } else {
    changeEl.textContent = "-";
    changeEl.className = "price-change";
  }

  renderMetrics(data);
  renderNews(data.news);
}

function renderMetrics(data) {
  const table = document.getElementById("metrics-table");

  const metrics = [
    { label: "Price", value: data.price != null ? "$" + data.price.toFixed(2) : "-" },
    { label: "Change", value: fmtPct(data.change), cls: pctClass(data.change) },
    { label: "Volume", value: data.volume_fmt || "-" },
    { label: "Avg Volume", value: data.avg_volume_fmt || "-" },
    { label: "Rel Volume", value: data.rel_vol != null ? data.rel_vol.toFixed(1) + "x" : "-" },
    { label: "RSI (14)", value: data.rsi != null ? Math.round(data.rsi) : "-" },
    { label: "SMA20", value: fmtPct(data.sma20), cls: pctClass(data.sma20) },
    { label: "SMA50", value: fmtPct(data.sma50), cls: pctClass(data.sma50) },
    { label: "SMA200", value: fmtPct(data.sma200), cls: pctClass(data.sma200) },
    { label: "Short Float", value: data.short_float != null ? data.short_float.toFixed(1) + "%" : "-" },
    { label: "ATR (14)", value: data.atr != null ? data.atr.toFixed(2) : "-" },
    { label: "Perf Week", value: fmtPct(data.perf_week), cls: pctClass(data.perf_week) },
    { label: "Perf Month", value: fmtPct(data.perf_month), cls: pctClass(data.perf_month) },
    { label: "Sector", value: data.sector || "-" },
  ];

  table.innerHTML = metrics.map(m =>
    `<div class="metric-row">
      <span class="label">${m.label}</span>
      <span class="value ${m.cls || ''}">${m.value}</span>
    </div>`
  ).join("");
}

function renderNews(news) {
  const list = document.getElementById("news-list");

  if (!news || news.length === 0) {
    list.innerHTML = '<div class="news-item" style="color:var(--text-dim);padding:1rem 0">No recent news found.</div>';
    return;
  }

  list.innerHTML = news.map(n => {
    const linkHtml = n.link
      ? `<a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>`
      : `<span>${escapeHtml(n.title)}</span>`;
    return `<div class="news-item">
      ${linkHtml}
      <div class="news-meta">${escapeHtml(n.date)} &middot; ${escapeHtml(n.source)}</div>
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
function initLookupChart() {
  const btns = document.querySelectorAll("#lookup-period-btns .period-btn");
  btns.forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener("click", () => {
      document.querySelectorAll("#lookup-period-btns .period-btn").forEach(b => b.classList.remove("active"));
      clone.classList.add("active");
      currentPeriod = clone.dataset.period;
      loadLookupChart();
    });
  });

  loadLookupChart();
}

async function loadLookupChart() {
  const container = document.getElementById("lookup-chart");

  if (lookupChart) {
    lookupChart.remove();
    lookupChart = null;
  }

  container.innerHTML = '<div class="chart-loading">Loading chart...</div>';

  try {
    const resp = await fetch(`/api/chart/${currentTicker}?period=${currentPeriod}`);
    const data = await resp.json();

    if (data.error) {
      container.innerHTML = `<div class="chart-loading">${escapeHtml(data.error)}</div>`;
      return;
    }

    container.innerHTML = "";

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: {
        background: { type: "solid", color: "#1a1d27" },
        textColor: "#8b8fa3",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "#2e334133" },
        horzLines: { color: "#2e334133" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "#7c4dff66", width: 1, style: 2 },
        horzLine: { color: "#7c4dff66", width: 1, style: 2 },
      },
      rightPriceScale: { borderColor: "#2e3341" },
      timeScale: {
        borderColor: "#2e3341",
        timeVisible: currentPeriod === "1d" || currentPeriod === "5d",
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    candleSeries.setData(data.candles);

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.setData(data.volumes);
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    if (data.sma5 && data.sma5.length > 0) {
      const sma5 = chart.addLineSeries({
        color: "#ffeb3b",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma5.setData(data.sma5);
    }

    if (data.sma20 && data.sma20.length > 0) {
      const sma20 = chart.addLineSeries({
        color: "#42a5f5",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma20.setData(data.sma20);
    }

    chart.timeScale().fitContent();
    lookupChart = chart;

    window.addEventListener("resize", () => {
      chart.applyOptions({ width: container.clientWidth });
    });

  } catch (err) {
    container.innerHTML = `<div class="chart-loading">Failed to load chart</div>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtPct(val) {
  if (val == null) return "-";
  const sign = val >= 0 ? "+" : "";
  return sign + val.toFixed(2) + "%";
}

function pctClass(val) {
  if (val == null) return "";
  return val >= 0 ? "positive" : "negative";
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Handle URL params (e.g. /lookup?t=AAPL)
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const ticker = params.get("t");
  if (ticker) {
    document.getElementById("ticker-input").value = ticker.toUpperCase();
    searchTicker(ticker.toUpperCase());
  }
});
