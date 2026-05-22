let chartInstances = {};
let chartTickers = [];
let currentPeriod = "1mo";

async function runScan() {
  const btn = document.getElementById("scan-btn");
  const loading = document.getElementById("loading");
  const welcome = document.getElementById("welcome");
  const results = document.getElementById("results");

  btn.disabled = true;
  btn.textContent = "Scanning...";
  welcome.classList.add("hidden");
  results.classList.add("hidden");
  loading.classList.remove("hidden");

  try {
    const resp = await fetch("/api/scan");
    const data = await resp.json();
    renderResults(data);
  } catch (err) {
    alert("Scan failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Scan";
    loading.classList.add("hidden");
  }
}

function fmtNumber(val) {
  if (val == null) return "-";
  if (Math.abs(val) >= 1e9) return (val / 1e9).toFixed(1) + "B";
  if (Math.abs(val) >= 1e6) return (val / 1e6).toFixed(1) + "M";
  if (Math.abs(val) >= 1e3) return Math.round(val / 1e3) + "K";
  return Math.round(val).toLocaleString();
}

function renderResults(data) {
  const results = document.getElementById("results");

  // Screen cards
  const screenCards = document.getElementById("screen-cards");
  screenCards.innerHTML = "";
  for (const [name, info] of Object.entries(data.screens)) {
    screenCards.innerHTML += `
      <div class="screen-card">
        <h3>${name.replace("_", " ")}</h3>
        <p class="desc">${info.description}</p>
        <div class="count">${info.count}</div>
        <div class="tickers">${info.tickers.join(", ")}</div>
      </div>`;
  }

  // Summary
  if (data.summary) {
    document.getElementById("stat-total").textContent = data.summary.total;
    document.getElementById("stat-high").textContent = data.summary.high;
    document.getElementById("stat-med").textContent = data.summary.medium;
    document.getElementById("stat-low").textContent = data.summary.low;
  }

  // Tier lists
  const high = data.entries.filter(e => e.tier === "HIGH");
  const medium = data.entries.filter(e => e.tier === "MEDIUM");
  const low = data.entries.filter(e => e.tier === "LOW");

  renderTierList("high", high);
  renderTierList("medium", medium);
  renderTierList("low", low);

  // Interactive charts for top 5
  chartTickers = high.slice(0, 5);
  if (chartTickers.length > 0) {
    initCharts(chartTickers);
  }

  results.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Interactive charts (TradingView Lightweight Charts)
// ---------------------------------------------------------------------------
function initCharts(entries) {
  const section = document.getElementById("charts-section");
  const grid = document.getElementById("charts-grid");
  section.classList.remove("hidden");
  grid.innerHTML = "";
  chartInstances = {};

  for (const e of entries) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.id = `chart-card-${e.ticker}`;

    const changeStr = e.change != null ? (e.change >= 0 ? "+" : "") + e.change.toFixed(1) + "%" : "";
    const rvolStr = e.rel_vol != null ? "RVol " + e.rel_vol.toFixed(1) + "x" : "";
    const scoreStr = "Score: " + Math.round(e.score);

    card.innerHTML = `
      <div class="chart-card-header">
        <h3>${escapeHtml(e.ticker)} <span style="font-weight:400;color:var(--text-dim);font-size:0.85rem">${escapeHtml(e.company)}</span></h3>
        <span class="chart-subtitle">${changeStr}  ${rvolStr}  ${scoreStr}</span>
      </div>
      <div class="chart-container" id="chart-${e.ticker}">
        <div class="chart-loading">Loading chart...</div>
      </div>`;
    grid.appendChild(card);
  }

  // Setup period buttons
  const btns = document.querySelectorAll("#global-period-btns .period-btn");
  btns.forEach(btn => {
    btn.addEventListener("click", () => {
      btns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentPeriod = btn.dataset.period;
      loadAllCharts();
    });
  });

  loadAllCharts();
}

async function loadAllCharts() {
  for (const e of chartTickers) {
    await loadChart(e.ticker);
  }
}

async function loadChart(ticker) {
  const containerId = `chart-${ticker}`;
  const container = document.getElementById(containerId);
  if (!container) return;

  // Clear previous chart instance
  if (chartInstances[ticker]) {
    chartInstances[ticker].chart.remove();
    delete chartInstances[ticker];
  }

  container.innerHTML = '<div class="chart-loading">Loading...</div>';

  try {
    const resp = await fetch(`/api/chart/${ticker}?period=${currentPeriod}`);
    const data = await resp.json();
    if (data.error) {
      container.innerHTML = `<div class="chart-loading">${data.error}</div>`;
      return;
    }

    container.innerHTML = "";

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 350,
      layout: {
        background: { type: "solid", color: "#1a1d27" },
        textColor: "#8b8fa3",
        fontSize: 11,
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
      rightPriceScale: {
        borderColor: "#2e3341",
      },
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
      const sma5Series = chart.addLineSeries({
        color: "#ffeb3b",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma5Series.setData(data.sma5);
    }

    if (data.sma20 && data.sma20.length > 0) {
      const sma20Series = chart.addLineSeries({
        color: "#42a5f5",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      sma20Series.setData(data.sma20);
    }

    chart.timeScale().fitContent();

    chartInstances[ticker] = { chart };

    // Resize on window resize
    const resizeHandler = () => {
      chart.applyOptions({ width: container.clientWidth });
    };
    window.addEventListener("resize", resizeHandler);

  } catch (err) {
    container.innerHTML = `<div class="chart-loading">Failed to load chart</div>`;
  }
}


// ---------------------------------------------------------------------------
// Tier list rendering
// ---------------------------------------------------------------------------
function renderTierList(tier, entries) {
  const section = document.getElementById(tier + "-section");
  const list = document.getElementById(tier + "-list");
  list.innerHTML = "";

  if (entries.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");

  for (const e of entries) {
    const changeClass = (e.change != null && e.change >= 0) ? "positive" : "negative";
    const changeStr = e.change != null ? (e.change >= 0 ? "+" : "") + e.change.toFixed(1) + "%" : "-";
    const rvolStr = e.rel_vol != null ? e.rel_vol.toFixed(1) + "x" : "-";
    const rsiStr = e.rsi != null ? Math.round(e.rsi) : "-";
    const priceStr = e.price != null ? "$" + e.price.toFixed(2) : "-";

    let newsHtml = "";
    if (e.news && e.news.length > 0) {
      newsHtml = e.news.map(n => {
        const linkHtml = n.link
          ? `<a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>`
          : escapeHtml(n.title);
        return `<div class="news-item">
          ${linkHtml}
          <div class="news-meta">${escapeHtml(n.date)} &middot; ${escapeHtml(n.source)}</div>
        </div>`;
      }).join("");
    } else {
      newsHtml = '<div class="news-item" style="color:var(--text-dim)">No recent news</div>';
    }

    const card = document.createElement("div");
    card.className = "ticker-card";
    card.innerHTML = `
      <div class="ticker-top">
        <span class="ticker-symbol">${escapeHtml(e.ticker)}</span>
        <span class="ticker-company">${escapeHtml(e.company)} &middot; ${escapeHtml(e.industry)}</span>
        <div class="ticker-metrics">
          <div class="metric">
            <span class="metric-val">${priceStr}</span>
            <span class="metric-label">Price</span>
          </div>
          <div class="metric">
            <span class="metric-val ${changeClass}">${changeStr}</span>
            <span class="metric-label">Change</span>
          </div>
          <div class="metric">
            <span class="metric-val">${rvolStr}</span>
            <span class="metric-label">RVol</span>
          </div>
          <div class="metric">
            <span class="metric-val">${rsiStr}</span>
            <span class="metric-label">RSI</span>
          </div>
          <div class="metric">
            <span class="metric-val">${e.volume_fmt}</span>
            <span class="metric-label">Volume</span>
          </div>
          <span class="score-badge">${Math.round(e.score)}</span>
          <span class="tier-badge ${tier}">${e.tier}</span>
        </div>
      </div>
      <div class="ticker-rec">${escapeHtml(e.recommendation)}</div>
      <div class="ticker-detail">
        <div class="detail-grid">
          <div class="news-section">
            <h4>Latest News</h4>
            ${newsHtml}
          </div>
          <div class="extra-metrics">
            <h4>Details</h4>
            <div class="metrics-grid">
              <div class="extra-metric"><span class="label">Sector</span><span>${escapeHtml(e.sector)}</span></div>
              <div class="extra-metric"><span class="label">Industry</span><span>${escapeHtml(e.industry)}</span></div>
              <div class="extra-metric"><span class="label">Avg Volume</span><span>${fmtNumber(e.avg_volume)}</span></div>
              <div class="extra-metric"><span class="label">SMA20</span><span>${e.sma20 != null ? e.sma20.toFixed(1) + "%" : "-"}</span></div>
              <div class="extra-metric"><span class="label">Short Float</span><span>${e.short_float != null ? e.short_float.toFixed(1) + "%" : "-"}</span></div>
              <div class="extra-metric"><span class="label">Screens Hit</span><span>${e.screen_count} / 4</span></div>
            </div>
          </div>
        </div>
      </div>
      <button class="toggle-btn" onclick="toggleCard(this)">Show details &amp; news</button>`;

    list.appendChild(card);
  }
}

function toggleCard(btn) {
  const card = btn.closest(".ticker-card");
  card.classList.toggle("expanded");
  btn.textContent = card.classList.contains("expanded") ? "Hide details" : "Show details & news";
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
