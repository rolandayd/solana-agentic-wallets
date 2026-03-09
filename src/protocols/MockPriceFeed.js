/**
 * MockPriceFeed.js
 * 
 * Simulates a price oracle for testing agent decision logic on devnet.
 * In production, replace with:
 *   - Pyth Network: https://pyth.network/developers/consumers/evm
 *   - Switchboard: https://switchboard.xyz
 *   - Chainlink on Solana
 * 
 * The mock generates realistic price movement using a random walk model
 * with drift and volatility parameters.
 */

class MockPriceFeed {
  /**
   * @param {string} symbol     - e.g. 'SOL/USD'
   * @param {number} basePrice  - Starting price
   * @param {number} volatility - Price change magnitude per tick (0.02 = 2%)
   * @param {number} drift      - Slow upward/downward trend (0.001 = 0.1%)
   */
  constructor(symbol, basePrice = 150, volatility = 0.025, drift = 0.001) {
    this.symbol = symbol;
    this.currentPrice = basePrice;
    this.volatility = volatility;
    this.drift = drift;
    this.tickCount = 0;
  }

  /**
   * Get the current simulated price.
   * Each call advances the simulation by one step.
   */
  async getPrice() {
    // Geometric Brownian Motion step
    const randomShock = (Math.random() - 0.5) * 2 * this.volatility;
    const priceChange = this.currentPrice * (this.drift + randomShock);
    this.currentPrice = Math.max(1, this.currentPrice + priceChange);
    this.tickCount++;
    return this.currentPrice;
  }

  /**
   * Peek at current price without advancing.
   */
  getCurrentPrice() {
    return this.currentPrice;
  }
}

module.exports = MockPriceFeed;
