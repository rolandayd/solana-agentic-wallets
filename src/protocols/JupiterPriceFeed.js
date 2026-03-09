/**
 * JupiterPriceFeed.js
 *
 * Live SOL/USD price feed powered by Jupiter Price API v2.
 * Replaces MockPriceFeed for production-grade agent decisions.
 *
 * API: https://price.jup.ag/v6/price?ids=SOL
 * No API key required. Rate limit: ~10 req/s.
 *
 * Falls back to geometric brownian motion if Jupiter is unreachable,
 * so agents never stop running due to network issues.
 */

const https = require('https');

// SOL mint address on Solana
const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Jupiter Price API v2
const JUPITER_API = 'https://price.jup.ag/v6/price';

class JupiterPriceFeed {
  /**
   * @param {string} symbol   - 'SOL/USD' (default) or 'SOL/USDC'
   * @param {number} cacheTtlMs - How long to cache a price (default 3000ms)
   *                              Prevents hammering the API on every tick
   */
  constructor(symbol = 'SOL/USD', cacheTtlMs = 3000) {
    this.symbol      = symbol;
    this.cacheTtlMs  = cacheTtlMs;
    this.tickCount   = 0;
    this.source      = 'jupiter';

    // Cache
    this._cachedPrice = null;
    this._cacheTime   = 0;

    // Fallback GBM state (used when Jupiter is unreachable)
    this._fallbackPrice    = 150;
    this._fallbackActive   = false;
    this._consecutiveFails = 0;
  }

  /**
   * Fetch current SOL/USD price from Jupiter.
   * Returns cached value if within TTL window.
   */
  async getPrice() {
    this.tickCount++;

    // Return cache if fresh
    if (this._cachedPrice && Date.now() - this._cacheTime < this.cacheTtlMs) {
      return this._cachedPrice;
    }

    try {
      const price = await this._fetchJupiter();
      this._cachedPrice         = price;
      this._cacheTime           = Date.now();
      this._fallbackPrice       = price; // keep fallback in sync
      this._consecutiveFails    = 0;
      this._fallbackActive      = false;
      this.source               = 'jupiter';
      return price;
    } catch (err) {
      this._consecutiveFails++;
      if (this._consecutiveFails === 1) {
        console.warn(`[JupiterPriceFeed] API unreachable — falling back to GBM simulation (${err.message})`);
      }
      this._fallbackActive = true;
      this.source = 'fallback-gbm';
      return this._gbmStep();
    }
  }

  getCurrentPrice() {
    return this._cachedPrice || this._fallbackPrice;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _fetchJupiter() {
    return new Promise((resolve, reject) => {
      const url = `${JUPITER_API}?ids=${SOL_MINT}&vsToken=${USDC_MINT}`;
      const req = https.get(url, { timeout: 5000 }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const price = json?.data?.[SOL_MINT]?.price;
            if (!price || isNaN(price)) throw new Error('Invalid price response');
            resolve(parseFloat(price));
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  _gbmStep() {
    const volatility   = 0.02;
    const drift        = 0.0005;
    const randomShock  = (Math.random() - 0.5) * 2 * volatility;
    this._fallbackPrice = Math.max(1, this._fallbackPrice * (1 + drift + randomShock));
    return this._fallbackPrice;
  }
}

module.exports = JupiterPriceFeed;
