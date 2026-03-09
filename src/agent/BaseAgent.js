/**
 * BaseAgent.js
 * 
 * Abstract base class for AI agents that own and operate wallets.
 * 
 * Architecture:
 *   Agent (strategy/decisions) → AgentWallet (signing/execution) → Solana (settlement)
 * 
 * The agent never touches private keys.
 * It formulates decisions and calls wallet methods.
 * The wallet handles all cryptography.
 * 
 * This separation means:
 * - You can swap agent strategies without touching wallet security
 * - You can audit agent decisions independently from key management
 * - Multiple agent strategies can share the same wallet infrastructure
 */

const EventEmitter = require('events');

class BaseAgent extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string}       config.agentId    - Unique agent identifier
   * @param {AgentWallet}  config.wallet     - Initialized wallet instance
   * @param {number}       config.tickMs     - Decision loop interval in ms (default 5000)
   * @param {Object}       config.params     - Agent-specific parameters
   */
  constructor(config) {
    super();
    this.agentId = config.agentId;
    this.wallet = config.wallet;
    this.tickMs = config.tickMs || 5000;
    this.params = config.params || {};
    this.isRunning = false;
    this.tickCount = 0;
    this.actionHistory = [];
    this.state = {};
  }

  /**
   * Initialize agent state. Override in subclasses.
   */
  async initialize() {
    this.state = await this._buildInitialState();
    this.emit('initialized', { agentId: this.agentId, state: this.state });
    return this;
  }

  /**
   * Start the autonomous decision loop.
   */
  start() {
    if (this.isRunning) {
      console.warn(`[Agent:${this.agentId}] Already running.`);
      return;
    }

    this.isRunning = true;
    this.emit('started', { agentId: this.agentId });
    console.log(`[Agent:${this.agentId}] Starting decision loop (interval: ${this.tickMs}ms)`);
    this._scheduleNextTick();
  }

  /**
   * Stop the decision loop gracefully.
   */
  stop() {
    this.isRunning = false;
    if (this._tickTimer) {
      clearTimeout(this._tickTimer);
    }
    this.emit('stopped', { agentId: this.agentId, ticksCompleted: this.tickCount });
    console.log(`[Agent:${this.agentId}] Stopped after ${this.tickCount} ticks.`);
  }

  /**
   * Core decision method. Override in subclasses.
   * Must return an action object or null (for no-op).
   * 
   * @param {Object} state - Current agent state
   * @returns {Object|null} action - { type, params }
   */
  async decide(state) {
    throw new Error(`[Agent:${this.agentId}] decide() must be implemented in subclass.`);
  }

  /**
   * Execute a decided action. Override in subclasses.
   * 
   * @param {Object} action - Action returned by decide()
   * @returns {Object} result
   */
  async execute(action) {
    throw new Error(`[Agent:${this.agentId}] execute() must be implemented in subclass.`);
  }

  /**
   * Update agent state after each tick. Override to customize.
   */
  async updateState() {
    const solBalance = await this.wallet.getSOLBalance();
    this.state.solBalance = solBalance;
    this.state.lastUpdated = new Date().toISOString();
    return this.state;
  }

  /**
   * Get action history log.
   */
  getHistory() {
    return this.actionHistory;
  }

  /**
   * Get current state snapshot.
   */
  getState() {
    return { ...this.state, agentId: this.agentId, tickCount: this.tickCount };
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  async _tick() {
    if (!this.isRunning) return;

    this.tickCount++;
    const tickId = `${this.agentId}-tick-${this.tickCount}`;

    try {
      // 1. Update state
      await this.updateState();

      // 2. Decide
      const action = await this.decide(this.state);

      // 3. Execute (if action decided)
      let result = null;
      if (action) {
        result = await this.execute(action);
        this.actionHistory.push({
          tickId,
          timestamp: new Date().toISOString(),
          action,
          result,
        });

        this.emit('action', {
          agentId: this.agentId,
          tickId,
          action,
          result,
        });
      } else {
        this.emit('tick', {
          agentId: this.agentId,
          tickId,
          state: this.state,
          action: null,
        });
      }
    } catch (err) {
      console.error(`[Agent:${this.agentId}] Error on tick ${this.tickCount}:`, err.message);
      this.emit('error', { agentId: this.agentId, tickId, error: err });
    }

    this._scheduleNextTick();
  }

  _scheduleNextTick() {
    if (!this.isRunning) return;
    this._tickTimer = setTimeout(() => this._tick(), this.tickMs);
  }

  async _buildInitialState() {
    const solBalance = await this.wallet.getSOLBalance();
    return {
      solBalance,
      address: this.wallet.getAddress(),
      tickCount: 0,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }
}

module.exports = BaseAgent;
