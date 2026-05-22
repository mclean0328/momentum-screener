#!/usr/bin/env python3
"""Flask app for the momentum day trading screener."""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, render_template, request

from finvizfinance.quote import finvizfinance as Ticker
from finvizfinance.screener.overview import Overview

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

# ---------------------------------------------------------------------------
# Screener configurations
# ---------------------------------------------------------------------------
SCREENER_CONFIGS = {
    "gappers": {
        "description": "Pre-market / early session gap-ups with volume",
        "signal": "Top Gainers",
        "filters": {
            "Price": "$1 to $20",
            "Change": "Up 5%",
            "Relative Volume": "Over 2",
            "Average Volume": "Over 200K",
            "Market Cap.": "-Small (under $2bln)",
            "Float": "Under 50M",
            "Current Volume": "Over 500K",
        },
    },
    "breakouts": {
        "description": "Stocks breaking out near 52-week highs",
        "signal": "Top Gainers",
        "filters": {
            "Price": "$5 to $50",
            "Change": "Up 3%",
            "Relative Volume": "Over 1.5",
            "Average Volume": "Over 300K",
            "20-Day Simple Moving Average": "Price above SMA20",
            "52-Week High/Low": "New High",
            "Current Volume": "Over 500K",
        },
    },
    "volatile": {
        "description": "High-volatility movers with unusual volume",
        "signal": "Most Volatile",
        "filters": {
            "Price": "$1 to $20",
            "Relative Volume": "Over 2",
            "Average Volume": "Over 200K",
            "Market Cap.": "-Small (under $2bln)",
            "Current Volume": "Over 500K",
        },
    },
    "unusual_volume": {
        "description": "Unusual volume spikes — potential catalysts",
        "signal": "Unusual Volume",
        "filters": {
            "Price": "$1 to $20",
            "Change": "Up 3%",
            "Relative Volume": "Over 3",
            "Average Volume": "Over 100K",
            "Market Cap.": "-Small (under $2bln)",
        },
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _parse_float(val: str) -> float | None:
    if not val or val == "-":
        return None
    val = val.replace("%", "").replace(",", "").strip()
    try:
        return float(val)
    except ValueError:
        return None


def _parse_volume_str(val: str) -> float | None:
    if not val or val == "-":
        return None
    val = val.replace(",", "").strip()
    multiplier = 1
    if val.endswith("M"):
        val, multiplier = val[:-1], 1_000_000
    elif val.endswith("K"):
        val, multiplier = val[:-1], 1_000
    elif val.endswith("B"):
        val, multiplier = val[:-1], 1_000_000_000
    try:
        return float(val) * multiplier
    except ValueError:
        return None


def fmt_number(val):
    if val is None:
        return "-"
    if abs(val) >= 1e9:
        return f"{val / 1e9:.1f}B"
    if abs(val) >= 1e6:
        return f"{val / 1e6:.1f}M"
    if abs(val) >= 1e3:
        return f"{val / 1e3:.0f}K"
    return f"{val:,.0f}"


# ---------------------------------------------------------------------------
# Screener
# ---------------------------------------------------------------------------
def run_screen(name: str) -> tuple[list[str], pd.DataFrame | None]:
    config = SCREENER_CONFIGS[name]
    screener = Overview()
    screener.set_filter(signal=config["signal"], filters_dict=config["filters"])
    df = screener.screener_view()
    if df is None or df.empty:
        return [], None
    return df["Ticker"].tolist(), df


def fetch_ticker_data(symbol: str, max_retries: int = 3) -> dict | None:
    for attempt in range(max_retries):
        try:
            return _fetch_inner(symbol)
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            if attempt == max_retries - 1:
                return None
    return None


def _fetch_inner(symbol: str) -> dict | None:
    stock = Ticker(symbol)
    fund = stock.ticker_fundament()
    news_df = stock.ticker_news()

    headlines = []
    if news_df is not None and not news_df.empty:
        for _, row in news_df.head(5).iterrows():
            title = row.get("Title", "").strip()
            source = row.get("Source", "").strip()
            date = str(row.get("Date", ""))[:16]
            link = row.get("Link", "").strip()
            if title:
                headlines.append({
                    "title": title,
                    "source": source,
                    "date": date,
                    "link": link,
                })

    return {
        "Ticker": symbol,
        "Company": fund.get("Company", ""),
        "Price": _parse_float(fund.get("Price", "")),
        "Change%": _parse_float(fund.get("Change", "")),
        "Rel Vol": _parse_float(fund.get("Rel Volume", "")),
        "RSI": _parse_float(fund.get("RSI (14)", "")),
        "SMA20%": _parse_float(fund.get("SMA20", "")),
        "SMA50%": _parse_float(fund.get("SMA50", "")),
        "SMA200%": _parse_float(fund.get("SMA200", "")),
        "Avg Volume": _parse_volume_str(fund.get("Avg Volume", "")),
        "Volume": _parse_volume_str(fund.get("Volume", "")),
        "Perf Week%": _parse_float(fund.get("Perf Week", "")),
        "Perf Month%": _parse_float(fund.get("Perf Month", "")),
        "Short Float%": _parse_float(fund.get("Short Float", "")),
        "ATR": _parse_float(fund.get("ATR (14)", "")),
        "Sector": fund.get("Sector", ""),
        "Industry": fund.get("Industry", ""),
        "News": headlines,
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def compute_score(data: dict, screen_count: int) -> float:
    score = min(screen_count * 10, 40)

    change = data.get("Change%")
    if change is not None:
        if change >= 20:
            score += 25
        elif change >= 10:
            score += 20
        elif change >= 5:
            score += 15
        elif change >= 3:
            score += 10

    rel_vol = data.get("Rel Vol")
    if rel_vol is not None:
        if rel_vol >= 5:
            score += 20
        elif rel_vol >= 3:
            score += 15
        elif rel_vol >= 2:
            score += 10
        elif rel_vol >= 1.5:
            score += 5

    rsi = data.get("RSI")
    if rsi is not None:
        if 50 <= rsi <= 75:
            score += 10
        elif 40 <= rsi < 50 or 75 < rsi <= 80:
            score += 5

    sma20 = data.get("SMA20%")
    if sma20 is not None and sma20 > 0:
        score += 5

    short_float = data.get("Short Float%")
    if short_float is not None and short_float >= 10:
        score += 10

    perf_week = data.get("Perf Week%")
    if perf_week is not None and perf_week > 5:
        score += 5

    news_count = len(data.get("News", []))
    if news_count >= 3:
        score += 10
    elif news_count >= 1:
        score += 5

    return score


def classify_tier(score: float) -> str:
    if score >= 65:
        return "HIGH"
    elif score >= 40:
        return "MEDIUM"
    return "LOW"


def build_recommendation(data: dict) -> str:
    reasons = []
    change = data.get("Change%")
    rel_vol = data.get("Rel Vol")
    rsi = data.get("RSI")
    short_float = data.get("Short Float%")
    sma20 = data.get("SMA20%")

    if change is not None and change >= 10:
        reasons.append(f"Strong move +{change:.1f}%")
    elif change is not None and change >= 5:
        reasons.append(f"Solid move +{change:.1f}%")

    if rel_vol is not None and rel_vol >= 3:
        reasons.append(f"Heavy relative volume {rel_vol:.1f}x")
    elif rel_vol is not None and rel_vol >= 1.5:
        reasons.append(f"Elevated volume {rel_vol:.1f}x")

    if rsi is not None:
        if rsi > 80:
            reasons.append(f"RSI overbought ({rsi:.0f}) — watch for pullback")
        elif rsi > 70:
            reasons.append(f"RSI running hot ({rsi:.0f})")

    if short_float is not None and short_float >= 15:
        reasons.append(f"High short interest {short_float:.1f}% — squeeze potential")
    elif short_float is not None and short_float >= 10:
        reasons.append(f"Short interest {short_float:.1f}%")

    if sma20 is not None and sma20 > 10:
        reasons.append(f"Extended {sma20:.1f}% above SMA20")

    if not reasons:
        reasons.append("Meets multiple screen criteria")

    return "; ".join(reasons)


# ---------------------------------------------------------------------------
# Full scan pipeline
# ---------------------------------------------------------------------------
def run_full_scan() -> dict:
    screen_hits: dict[str, int] = {}
    screen_results = {}

    for name, config in SCREENER_CONFIGS.items():
        tickers, df = run_screen(name)
        screen_results[name] = {
            "description": config["description"],
            "count": len(tickers),
            "tickers": tickers,
        }
        for t in tickers:
            screen_hits[t] = screen_hits.get(t, 0) + 1

    if not screen_hits:
        return {"screens": screen_results, "entries": []}

    ranked = sorted(screen_hits.items(), key=lambda x: x[1], reverse=True)
    top_tickers = [t for t, _ in ranked]

    ticker_data: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(fetch_ticker_data, t): t for t in top_tickers}
        for future in as_completed(futures):
            sym = futures[future]
            result = future.result()
            if result:
                ticker_data[sym] = result
            time.sleep(0.5)

    entries = []
    for symbol, data in ticker_data.items():
        count = screen_hits.get(symbol, 1)
        score = compute_score(data, count)
        tier = classify_tier(score)
        rec = build_recommendation(data)
        entries.append({
            "ticker": symbol,
            "company": data.get("Company", ""),
            "price": data.get("Price"),
            "change": data.get("Change%"),
            "rel_vol": data.get("Rel Vol"),
            "rsi": data.get("RSI"),
            "volume": data.get("Volume"),
            "avg_volume": data.get("Avg Volume"),
            "sma20": data.get("SMA20%"),
            "short_float": data.get("Short Float%"),
            "sector": data.get("Sector", ""),
            "industry": data.get("Industry", ""),
            "score": score,
            "tier": tier,
            "screen_count": count,
            "recommendation": rec,
            "news": data.get("News", []),
            "volume_fmt": fmt_number(data.get("Volume")),
        })

    entries.sort(key=lambda x: x["score"], reverse=True)

    return {
        "screens": screen_results,
        "entries": entries,
        "summary": {
            "total": len(entries),
            "high": sum(1 for e in entries if e["tier"] == "HIGH"),
            "medium": sum(1 for e in entries if e["tier"] == "MEDIUM"),
            "low": sum(1 for e in entries if e["tier"] == "LOW"),
        },
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/lookup")
def lookup():
    return render_template("lookup.html")


@app.route("/api/scan")
def api_scan():
    try:
        results = run_full_scan()
        return jsonify(results)
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


@app.route("/api/lookup/<ticker>")
def api_lookup(ticker: str):
    try:
        symbol = ticker.upper().strip()
        data = fetch_ticker_data(symbol)
        if not data:
            return jsonify({"error": f"Could not find data for {symbol}"}), 404

        return jsonify({
            "ticker": symbol,
            "company": data.get("Company", ""),
            "price": data.get("Price"),
            "change": data.get("Change%"),
            "rel_vol": data.get("Rel Vol"),
            "rsi": data.get("RSI"),
            "volume": data.get("Volume"),
            "avg_volume": data.get("Avg Volume"),
            "sma20": data.get("SMA20%"),
            "sma50": data.get("SMA50%"),
            "sma200": data.get("SMA200%"),
            "short_float": data.get("Short Float%"),
            "atr": data.get("ATR"),
            "perf_week": data.get("Perf Week%"),
            "perf_month": data.get("Perf Month%"),
            "sector": data.get("Sector", ""),
            "industry": data.get("Industry", ""),
            "news": data.get("News", []),
            "volume_fmt": fmt_number(data.get("Volume")),
            "avg_volume_fmt": fmt_number(data.get("Avg Volume")),
        })
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


PERIOD_MAP = {
    "1d":  {"period": "1d",  "interval": "5m"},
    "5d":  {"period": "5d",  "interval": "15m"},
    "1mo": {"period": "1mo", "interval": "1h"},
    "3mo": {"period": "3mo", "interval": "1d"},
    "6mo": {"period": "6mo", "interval": "1d"},
    "1y":  {"period": "1y",  "interval": "1d"},
}


@app.route("/api/chart/<ticker>")
def api_chart(ticker: str):
    period = request.args.get("period", "5d")
    if period not in PERIOD_MAP:
        return jsonify({"error": f"Invalid period. Use: {list(PERIOD_MAP.keys())}"}), 400

    params = PERIOD_MAP[period]
    try:
        stock = yf.Ticker(ticker.upper())
        df = stock.history(period=params["period"], interval=params["interval"])
        if df.empty:
            return jsonify({"error": "No data"}), 404

        df.index = pd.DatetimeIndex(df.index)

        candles = []
        volumes = []
        for ts, row in df.iterrows():
            t = int(ts.timestamp())
            candles.append({
                "time": t,
                "open": round(row["Open"], 4),
                "high": round(row["High"], 4),
                "low": round(row["Low"], 4),
                "close": round(row["Close"], 4),
            })
            color = "#26a69a" if row["Close"] >= row["Open"] else "#ef5350"
            volumes.append({
                "time": t,
                "value": int(row["Volume"]),
                "color": color + "80",
            })

        sma5 = df["Close"].rolling(5).mean()
        sma20 = df["Close"].rolling(20).mean()
        sma5_data = [
            {"time": int(ts.timestamp()), "value": round(v, 4)}
            for ts, v in sma5.items() if pd.notna(v)
        ]
        sma20_data = [
            {"time": int(ts.timestamp()), "value": round(v, 4)}
            for ts, v in sma20.items() if pd.notna(v)
        ]

        return jsonify({
            "ticker": ticker.upper(),
            "period": period,
            "interval": params["interval"],
            "candles": candles,
            "volumes": volumes,
            "sma5": sma5_data,
            "sma20": sma20_data,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5055)
