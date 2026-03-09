/**
 * WalletManager.js
 * 
 * Manages a fleet of independent agent wallets.
 * Each agent's wallet is isolated — separate keys, separate state, separate logs.
 * 
 * Supports:
 * - Spawning new agent wallets on demand
 * - Loading existing agent wallets
 * - Broadcasting the same instruction to multiple agents
 * - Aggregated portfolio view across all agents
 */

const AgentWallet = require('./AgentWallet');

class WalletManager {
  /**
   * @param {Object} config
   * @param {string} config.keystorePath  - Shared keystore directory
   * @param {string} config.network       - Solana network
   * @param {string} config.masterSecret  - Master encryption secret (from env)
   */
  constructor(config) {
    this.keystorePath = config.keystorePath || './keystore';
    this.network = config.network || 'devnet';
    this.masterSecret = config.masterSecret;
    this.wallets = new Map(); // agentId → AgentWallet instance
  }

  /**
   * Spawn or load a wallet for a given agent.
   * Idempotent — safe to call multiple times for the same agentId.
   * 
   * @param {string} agentId
   * @returns {AgentWallet}
   */
  async getOrCreateWallet(agentId) {
    if (this.wallets.has(agentId)) {
      return this.wallets.get(agentId);
    }

    const wallet = new AgentWallet({
      agentId,
      keystorePath: this.keystorePath,
      network: this.network,
      masterSecret: this.masterSecret,
    });

    await wallet.connect();
    await wallet.initialize();

    this.wallets.set(agentId, wallet);
    return wallet;
  }

  /**
   * Get an already-loaded wallet. Throws if not loaded.
   */
  getWallet(agentId) {
    const wallet = this.wallets.get(agentId);
    if (!wallet) throw new Error(`Wallet for agent '${agentId}' is not loaded.`);
    return wallet;
  }

  /**
   * Load multiple wallets in parallel.
   * 
   * @param {string[]} agentIds
   */
  async loadAgents(agentIds) {
    await Promise.all(agentIds.map(id => this.getOrCreateWallet(id)));
    console.log(`[WalletManager] Loaded ${agentIds.length} agent wallets.`);
    return this;
  }

  /**
   * Get portfolio summary for all loaded agents.
   */
  async getPortfolioSummary() {
    const summaries = await Promise.all(
      Array.from(this.wallets.values()).map(w => w.getStatus())
    );

    const totalSOL = summaries.reduce((sum, s) => sum + s.solBalance, 0);

    return {
      totalAgents: summaries.length,
      totalSOL,
      agents: summaries,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Fund all agents with an airdrop (devnet only).
   * 
   * @param {number} amountPerAgent - SOL per agent
   */
  async fundAllAgents(amountPerAgent = 1) {
    const results = [];
    for (const [agentId, wallet] of this.wallets.entries()) {
      try {
        const sig = await wallet.requestAirdrop(amountPerAgent);
        results.push({ agentId, success: true, signature: sig });
      } catch (err) {
        results.push({ agentId, success: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Returns list of all loaded agent IDs.
   */
  getAgentIds() {
    return Array.from(this.wallets.keys());
  }
}

module.exports = WalletManager;
