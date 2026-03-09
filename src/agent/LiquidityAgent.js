/**
 * LiquidityAgent.js
 * Autonomous liquidity management agent.
 * Monitors pool imbalances and sends real SOL to counterparty on rebalance.
 */

const BaseAgent = require('./BaseAgent');

class LiquidityAgent extends BaseAgent {
  constructor(config) {
    super({ agentId: config.agentId, wallet: config.wallet, tickMs: config.tickMs || 15000, params: config });
    this.targetRatio = config.targetRatio || 0.5;
    this.rebalanceThreshold = config.rebalanceThreshold || 0.05;
    this.maxPositionSOL = config.maxPositionSOL || 0.02;
    this.counterparty = config.counterparty || null;
    this.openPositions = [];
  }

  async initialize() {
    await super.initialize();
    this.state.openPositions = [];
    this.state.totalValueLocked = 0;
    console.log(`[LiquidityAgent:${this.agentId}] Initialized. Target ratio: ${this.targetRatio}`);
    return this;
  }

  async updateState() {
    await super.updateState();
    this.state.poolRatio = this._simulatePoolRatio();
    this.state.drift = Math.abs(this.state.poolRatio - this.targetRatio);
    this.state.needsRebalance = this.state.drift > this.rebalanceThreshold;
    this.state.openPositions = this.openPositions;
    this.state.totalValueLocked = this.openPositions.reduce((sum, p) => sum + p.solAmount, 0);
    return this.state;
  }

  async decide(state) {
    const { needsRebalance, poolRatio, solBalance, drift } = state;
    console.log(`[LiquidityAgent:${this.agentId}] Tick ${this.tickCount} | Pool ratio: ${(poolRatio * 100).toFixed(1)}% | Drift: ${(drift * 100).toFixed(1)}% | Needs rebalance: ${needsRebalance}`);

    if (!needsRebalance) return null;

    const direction = poolRatio > this.targetRatio ? 'REMOVE_SOL' : 'ADD_SOL';
    const rebalanceAmount = Math.min(
      drift * solBalance,
      this.maxPositionSOL,
      solBalance * 0.15
    );

    if (rebalanceAmount < 0.001) {
      console.log(`[LiquidityAgent:${this.agentId}] Amount too small to rebalance.`);
      return null;
    }

    return { type: 'REBALANCE', params: { direction, amount: rebalanceAmount, currentRatio: poolRatio } };
  }

  async execute(action) {
    if (action.type === 'REBALANCE') {
      const { direction, amount, currentRatio } = action.params;

      // ADD_SOL: send real SOL to counterparty as the pool deposit
      if (direction === 'ADD_SOL' && this.counterparty) {
        console.log(`[LiquidityAgent:${this.agentId}] Depositing ${amount.toFixed(6)} SOL → ${this.counterparty.address.slice(0,8)}... (ratio was ${(currentRatio * 100).toFixed(1)}%)`);
        try {
          const signature = await this.wallet.transferSOL(this.counterparty.address, amount);
          this.openPositions.push({ id: `pos-${Date.now()}`, type: 'ADD', solAmount: amount, entryRatio: currentRatio, timestamp: new Date().toISOString() });
          return { signature, action: action.type, direction, amount, positionCount: this.openPositions.length };
        } catch (err) {
          console.log(`[LiquidityAgent:${this.agentId}] Transfer failed: ${err.message} — simulating`);
          return { simulated: true, action: action.type, direction, amount };
        }
      }

      if (direction === 'ADD_SOL') {
        console.log(`[LiquidityAgent:${this.agentId}] Adding ${amount.toFixed(6)} SOL to pool (ratio was ${(currentRatio * 100).toFixed(1)}%)`);
        this.openPositions.push({ id: `pos-${Date.now()}`, type: 'ADD', solAmount: amount, entryRatio: currentRatio, timestamp: new Date().toISOString() });
      } else {
        console.log(`[LiquidityAgent:${this.agentId}] Removing ${amount.toFixed(6)} SOL from pool (ratio was ${(currentRatio * 100).toFixed(1)}%)`);
        this.openPositions = this.openPositions.filter(p => p.solAmount > amount);
      }
      return { simulated: true, action: action.type, direction, amount, positionCount: this.openPositions.length };
    }
  }

  _simulatePoolRatio() {
    const drift = (Math.random() - 0.5) * 0.06;
    const prev = this.state.poolRatio || this.targetRatio;
    return Math.max(0.1, Math.min(0.9, prev + drift));
  }
}

module.exports = LiquidityAgent;
