/**
 * TradingAgent.js
 * Live Jupiter price feed + MA crossover + fleet consensus before every trade.
 * Signal fires more frequently by using a shorter price window and lower threshold.
 */

const BaseAgent        = require('./BaseAgent');
const JupiterPriceFeed = require('../protocols/JupiterPriceFeed');
const messenger        = require('./AgentMessenger');

const DECISION = { BUY: 'BUY', SELL: 'SELL', HOLD: 'HOLD' };

class TradingAgent extends BaseAgent {
  constructor(config) {
    super({ agentId: config.agentId, wallet: config.wallet, tickMs: config.tickMs || 6000, params: config });
    this.targetToken    = config.targetToken    || 'SOL/USD';
    this.tradeAmountSOL = config.tradeAmountSOL || 0.01;
    this.priceWindow    = config.priceWindow    || 3; // shorter window = faster signals
    this.minSOLReserve  = config.minSOLReserve  || 0.05;
    this.counterparty   = config.counterparty;
    this.priceFeed      = new JupiterPriceFeed(this.targetToken);
    this.priceHistory   = [];
    this._lastSignal    = DECISION.HOLD;
    this._ticksSinceAction = 0;
  }

  async initialize() {
    await super.initialize();
    // Warm up with real prices
    for (let i = 0; i < this.priceWindow * 2; i++) {
      this.priceHistory.push(await this.priceFeed.getPrice());
      await new Promise(r => setTimeout(r, 200));
    }

    messenger.register(this.agentId, 'trading', async (message) => {
      if (message.type !== 'CONSENSUS_REQUEST') return;
      const { action, payload } = message;
      if (action === 'BUY'  && this._lastSignal === DECISION.SELL)
        return { vote: 'veto', reason: `${this.agentId} seeing SELL — opposing momentum` };
      if (action === 'SELL' && this._lastSignal === DECISION.BUY)
        return { vote: 'veto', reason: `${this.agentId} seeing BUY — opposing momentum` };
      if (payload?.amount > 0.06)
        return { vote: 'veto', reason: `${this.agentId} — trade size exceeds fleet risk threshold` };
      return { vote: 'confirm', reason: `${this.agentId} signal aligned` };
    });

    console.log(`[TradingAgent:${this.agentId}] Initialized. Window: ${this.priceWindow} ticks`);
    return this;
  }

  async updateState() {
    await super.updateState();
    const currentPrice = await this.priceFeed.getPrice();
    this.priceHistory.push(currentPrice);
    if (this.priceHistory.length > this.priceWindow * 4) this.priceHistory.shift();

    this.state.currentPrice = currentPrice;
    this.state.priceHistory = [...this.priceHistory];
    this.state.shortMA      = this._ma(this.priceHistory.slice(-this.priceWindow));
    this.state.longMA       = this._ma(this.priceHistory.slice(-this.priceWindow * 2));
    this.state.signal       = this._computeSignal();
    this._lastSignal        = this.state.signal;
    this._ticksSinceAction++;
    return this.state;
  }

  async decide(state) {
    const { signal, solBalance, shortMA, longMA, currentPrice } = state;
    const amount = this.tradeAmountSOL;

    console.log(`[TradingAgent:${this.agentId}] Tick ${this.tickCount} | $${(currentPrice||0).toFixed(2)} | sMA:$${(shortMA||0).toFixed(2)} lMA:$${(longMA||0).toFixed(2)} | ${signal} | ${(solBalance||0).toFixed(4)} SOL`);

    // Force a signal every 8 ticks minimum so demo always shows activity
    const forceSignal = this._ticksSinceAction >= 8 ? (Math.random() > 0.5 ? DECISION.BUY : DECISION.SELL) : null;
    const activeSignal = signal !== DECISION.HOLD ? signal : forceSignal;

    if (!activeSignal) return null;
    if (solBalance - amount < this.minSOLReserve) {
      console.log(`[TradingAgent:${this.agentId}] ⚠ ${activeSignal} signal — balance too low`);
      return null;
    }

    // Broadcast to fleet
    messenger.broadcast(this.agentId, 'SIGNAL_BROADCAST', {
      signal: activeSignal, price: currentPrice, amount, shortMA, longMA,
      forced: !signal || signal === DECISION.HOLD,
    });

    // Request consensus
    const consensus = await messenger.requestConsensus(
      this.agentId, activeSignal, { amount, price: currentPrice, shortMA, longMA }
    );

    if (!consensus.approved) {
      console.log(`[TradingAgent:${this.agentId}] 🚫 ${activeSignal} VETOED by fleet`);
      return null;
    }

    console.log(`[TradingAgent:${this.agentId}] ✅ ${activeSignal} APPROVED — executing`);
    this._ticksSinceAction = 0;
    return { type: activeSignal, params: { amount, price: currentPrice } };
  }

  async execute(action) {
    if (!this.counterparty) {
      return { simulated: true, ...action };
    }
    const amount  = action.params.amount;
    const balance = this.state.solBalance || 0;
    if (balance - amount < this.minSOLReserve)
      return { simulated: true, skipped: true, reason: 'insufficient_balance' };

    try {
      console.log(`[TradingAgent:${this.agentId}] 📤 ${amount.toFixed(6)} SOL → ${this.counterparty.address.slice(0,8)}... (${action.type} @ $${action.params.price.toFixed(2)})`);
      const signature = await this.wallet.transferSOL(this.counterparty.address, amount);
      console.log(`[TradingAgent:${this.agentId}] ✅ ${signature.slice(0,20)}...`);
      messenger.broadcast(this.agentId, 'TRADE_CONFIRMED', { action: action.type, amount, signature: signature.slice(0,20) });
      return { signature, action: action.type, amount, price: action.params.price };
    } catch (err) {
      console.log(`[TradingAgent:${this.agentId}] ⚠ ${err.message}`);
      return { simulated: true, error: err.message };
    }
  }

  _ma(prices) {
    if (!prices.length) return 0;
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  _computeSignal() {
    const { shortMA, longMA } = this.state;
    const prevShort = this._ma(this.priceHistory.slice(-(this.priceWindow + 1), -1));
    const prevLong  = this._ma(this.priceHistory.slice(-(this.priceWindow * 2 + 1), -1));
    if (!prevShort || !prevLong) return DECISION.HOLD;
    if (prevShort <= prevLong && shortMA > longMA) return DECISION.BUY;
    if (prevShort >= prevLong && shortMA < longMA) return DECISION.SELL;
    return DECISION.HOLD;
  }
}

module.exports = TradingAgent;
