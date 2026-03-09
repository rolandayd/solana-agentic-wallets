/**
 * AgentMessenger.js
 *
 * In-process message bus for agent-to-agent communication.
 * Agents broadcast signals and can request consensus from peers
 * before executing a transaction.
 *
 * Message types:
 *   SIGNAL_BROADCAST  — "I'm seeing X, here's my intent"
 *   CONSENSUS_REQUEST — "I want to act, does anyone object?"
 *   CONSENSUS_REPLY   — "confirmed" or "vetoed" + reason
 *   ALERT             — risk warning broadcast to all agents
 *
 * This is what turns isolated agents into a coordinated fleet.
 */

const EventEmitter = require('events');

class AgentMessenger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    this._agents     = {}; // agentId → { handler, type }
    this._messageLog = []; // last 200 messages for dashboard
  }

  /**
   * Register an agent to receive messages.
   * @param {string}   agentId
   * @param {string}   agentType  'trading' | 'liquidity' | 'arbitrage'
   * @param {Function} handler    async fn(message) → { vote, reason } | void
   */
  register(agentId, agentType, handler) {
    this._agents[agentId] = { handler, type: agentType };
    console.log(`[AgentMessenger] Registered: ${agentId} (${agentType})`);
  }

  /**
   * Broadcast a signal to all other agents (fire and forget).
   */
  broadcast(fromAgentId, type, payload) {
    const message = {
      id:        `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      time:      new Date().toISOString(),
      from:      fromAgentId,
      to:        'ALL',
      type,
      payload,
    };
    this._log(message);
    console.log(`[Fleet] 📡 ${fromAgentId} → ALL | ${type} | ${JSON.stringify(payload)}`);
    this.emit('message', message);
    return message;
  }

  /**
   * Request consensus from peer agents before acting.
   * Collects votes from all registered agents (except sender).
   * Returns { approved: bool, votes: [{agentId, vote, reason}] }
   *
   * Consensus rule: approved if majority vote "confirm" (or no peers object)
   */
  async requestConsensus(fromAgentId, action, payload, timeoutMs = 1500) {
    const peers = Object.keys(this._agents).filter(id => id !== fromAgentId);
    if (peers.length === 0) return { approved: true, votes: [] };

    const request = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      time:    new Date().toISOString(),
      from:    fromAgentId,
      to:      'PEERS',
      type:    'CONSENSUS_REQUEST',
      payload: { action, ...payload },
    };
    this._log(request);
    console.log(`[Fleet] 🗳  ${fromAgentId} → PEERS | CONSENSUS_REQUEST | action: ${action}`);

    // Collect votes with timeout
    const votePromises = peers.map(async peerId => {
      const agent = this._agents[peerId];
      if (!agent?.handler) return { agentId: peerId, vote: 'abstain', reason: 'no handler' };
      try {
        const result = await Promise.race([
          agent.handler({ type: 'CONSENSUS_REQUEST', from: fromAgentId, action, payload }),
          new Promise(r => setTimeout(() => r({ vote: 'abstain', reason: 'timeout' }), timeoutMs)),
        ]);
        return { agentId: peerId, vote: result?.vote || 'abstain', reason: result?.reason || '' };
      } catch (err) {
        return { agentId: peerId, vote: 'abstain', reason: err.message };
      }
    });

    const votes = await Promise.all(votePromises);
    const confirms = votes.filter(v => v.vote === 'confirm').length;
    const vetoes   = votes.filter(v => v.vote === 'veto').length;
    const approved = vetoes === 0 || confirms > vetoes;

    const reply = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      time:    new Date().toISOString(),
      from:    'FLEET',
      to:      fromAgentId,
      type:    'CONSENSUS_REPLY',
      payload: { action, approved, confirms, vetoes, votes },
    };
    this._log(reply);
    console.log(`[Fleet] ${approved ? '✅' : '🚫'} CONSENSUS ${approved ? 'APPROVED' : 'VETOED'} for ${fromAgentId} | confirms: ${confirms} vetoes: ${vetoes}`);

    votes.forEach(v => {
      console.log(`[Fleet]   └─ ${v.agentId}: ${v.vote}${v.reason ? ' — ' + v.reason : ''}`);
    });

    return { approved, votes, confirms, vetoes };
  }

  /**
   * Send a direct message to a specific agent.
   */
  async sendDirect(fromAgentId, toAgentId, type, payload) {
    const message = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      time:    new Date().toISOString(),
      from:    fromAgentId,
      to:      toAgentId,
      type,
      payload,
    };
    this._log(message);
    console.log(`[Fleet] 💬 ${fromAgentId} → ${toAgentId} | ${type}`);
    const agent = this._agents[toAgentId];
    if (agent?.handler) {
      try { await agent.handler(message); } catch (_) {}
    }
    return message;
  }

  getMessageLog(n = 50) {
    return this._messageLog.slice(0, n);
  }

  _log(message) {
    this._messageLog.unshift(message);
    if (this._messageLog.length > 200) this._messageLog.pop();
  }
}

// Singleton — shared across all agents in the process
const messenger = new AgentMessenger();
module.exports = messenger;
