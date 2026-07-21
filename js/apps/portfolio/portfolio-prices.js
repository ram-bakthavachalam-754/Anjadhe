/**
 * Portfolio Price Fetcher
 * Fetches stock prices via Yahoo Finance v8 API
 */

const PriceFetcher = {
    CACHE_TTL: 5 * 60 * 1000, // 5 minutes

    /**
     * Fetch prices for multiple tickers
     * @param {string[]} tickers - Array of stock ticker symbols
     * @param {Object} priceCache - Existing price cache
     * @returns {Object} Updated price cache
     */
    async fetchPrices(tickers, priceCache = {}) {
        if (!tickers || tickers.length === 0) return priceCache;

        const now = Date.now();
        const staleTickers = tickers.filter(ticker => {
            const cached = priceCache[ticker];
            return !cached || (now - cached.updatedAt > this.CACHE_TTL);
        });

        if (staleTickers.length === 0) return priceCache;

        const results = await Promise.all(
            staleTickers.map(ticker => this.fetchSingle(ticker))
        );

        const updated = { ...priceCache };
        results.forEach(result => {
            if (result) {
                updated[result.ticker] = {
                    price: result.price,
                    change: result.change,
                    changePercent: result.changePercent,
                    updatedAt: now
                };
            }
        });

        return updated;
    },

    /**
     * Fetch price for a single ticker
     * @param {string} ticker
     * @returns {Object|null}
     */
    async fetchSingle(ticker) {
        try {
            // Yahoo Finance uses hyphens for share classes (BRK.B -> BRK-B)
            const yahooTicker = ticker.replace(/\./g, '-');
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;
            const response = await fetch(url);

            if (!response.ok) return null;

            const data = await response.json();
            const result = data?.chart?.result?.[0];
            if (!result) return null;

            const meta = result.meta;
            const price = meta.regularMarketPrice;
            const previousClose = meta.chartPreviousClose || meta.previousClose;
            const change = previousClose ? price - previousClose : 0;
            const changePercent = previousClose ? (change / previousClose) * 100 : 0;

            return {
                ticker: ticker.toUpperCase(),
                price,
                change,
                changePercent
            };
        } catch (error) {
            console.error(`Failed to fetch price for ${ticker}:`, error);
            return null;
        }
    },

    /**
     * Fetch company info for a ticker via Yahoo Finance quoteSummary (through main process)
     * @param {string} ticker
     * @returns {Object|null} Company info object
     */
    async fetchCompanyInfo(ticker) {
        try {
            const yahooTicker = ticker.replace(/\./g, '-');
            const result = await window.electronNet.fetchYahooQuoteSummary(yahooTicker);
            if (!result) return null;

            const profile = result.assetProfile || {};
            const quoteType = result.quoteType || {};

            return {
                name: quoteType.longName || quoteType.shortName || ticker,
                sector: profile.sector || null,
                industry: profile.industry || null,
                description: profile.longBusinessSummary || null,
                website: profile.website || null,
                country: profile.country || null,
                employees: profile.fullTimeEmployees || null
            };
        } catch (error) {
            console.error(`Failed to fetch company info for ${ticker}:`, error);
            return null;
        }
    },

    /**
     * Check if a cached price is stale
     * @param {Object} cached - Cached price entry
     * @returns {boolean}
     */
    isStale(cached) {
        if (!cached) return true;
        return Date.now() - cached.updatedAt > this.CACHE_TTL;
    }
};
