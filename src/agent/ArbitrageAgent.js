/**
 * ArbitrageAgent.js
 *
 * Monitors two Jupiter price feeds (with slight offset to simulate DEX spread)
 * and executes when spread exceeds threshold.
 *
 * DEX-A: Live Jupiter SOL/USD price
 * DEX-B: Jupiter price + small random noise (simulates second venue spread)
 */

const BaseAgent        = require('./BaseAgent');
const JupiterPriceFeed = require('../protocols/JupiterPriceFeed');

class ArbitrageAgent extends BaseAgent {
  constructor(config) {
    super({ agentId: config.agentId, wallet: config.wallet, tickMs: config.tickMs || 5000, params: config });
    this.spreadThreshold = config.spreadThreshold || 0.015;
    this.tradeAmountSOL  = config.tradeAmountSOL  || 0.01;
    this.estimatedFeePct = config.estimatedFeePct || 0.003;
    this.minSOLReserve   = config.minSOLReserve   || 0.05;
    this.counterparty    = config.counterparty    || null;
    this.cooldown        = 0;

    // DEX-A: real Jupiter price. DEX-B: Jupiter + noise offset
    this.feedA = new JupiterPriceFeed('SOL/USD-DEX-A', 3000);
    this.feedB = new JupiterPriceFeed('SOL/USD-DEX-B', 3500); // slightly staggered cache
  }

  async initialize() {
    await super.initialize();
    console.log(`[ArbitrageAgent:${this.agentId}] Initialized. Min spread: ${(this.spreadThreshold * 100).toFixed(1)}%`);
    return this;
  }

  async updateState() {
    await super.updateState();
    if (this.cooldown > 0) this.cooldown--;

    // Fetch live Jupiter price for both feeds
    const priceA = await this.feedA.getPrice();
    // DEX-B = Jupiter price ± small noise to simulate spread
    const noise  = (Math.random() - 0.48) * priceA * 0.04;
    const priceB = Math.max(1, priceA + noise);

    const spread = Math.abs(priceA - priceB) / Math.min(priceA, priceB);

    this.state.dexA      = priceA;
    this.state.dexB      = priceB;
    this.state.spreadPct = spread * 100;
    this.state.cooldown  = this.cooldown;
    this.state.source    = this.feedA.source;

    return this.state;
  }

  async decide(state) {
    const { dexA, dexB, spreadPct, solBalance, cooldown } = state;
    console.log(`[ArbitrageAgent:${this.agentId}] Tick ${this.tickCount} | DEX-A: $${(dexA||0).toFixed(2)} | DEX-B: $${(dexB||0).toFixed(2)} | Spread: ${(spreadPct||0).toFixed(3)}% | Cooldown: ${cooldown} | SOL: ${(solBalance||0).toFixed(4)}`);

    if (cooldown > 0) return null;

    const spreadDecimal = (spreadPct || 0) / 100;
    const profitAfterFees = spreadDecimal - this.estimatedFeePct;

    if (profitAfterFees < this.spreadThreshold) return null;
    if (solBalance - this.tradeAmountSOL < this.minSOLReserve) return null;

    const direction = dexA < dexB ? 'BUY_A_SELL_B' : 'BUY_B_SELL_A';
    return { type: 'ARBITRAGE', params: { direction, amount: this.tradeAmountSOL, spreadPct, dexA, dexB } };
  }

  async execute(action) {
    if (action.type === 'ARBITRAGE') {
      const { direction, amount, spreadPct, dexA, dexB } = action.params;
      this.cooldown = 3;

      if (this.counterparty) {
        console.log(`[ArbitrageAgent:${this.agentId}] ARBITRAGE ${direction} | spread: ${spreadPct.toFixed(3)}% | sending ${amount.toFixed(6)} SOL`);
        try {
          const signature = await this.wallet.transferSOL(this.counterparty.address, amount);
          return { signature, action: action.type, direction, amount, spreadPct, dexA, dexB };
        } catch (err) {
          console.log(`[ArbitrageAgent:${this.agentId}] Transfer failed: ${err.message}`);
          return { simulated: true, action: action.type, direction, amount };
        }
      }

      console.log(`[ArbitrageAgent:${this.agentId}] [SIM] ARBITRAGE ${direction} | spread: ${spreadPct.toFixed(3)}%`);
      return { simulated: true, action: action.type, direction, amount };
    }
  }

  getState() {
    return { ...super.getState(), ...this.state };
  }
}

module.exports = ArbitrageAgent;
