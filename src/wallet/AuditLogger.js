/**
 * AuditLogger.js
 *
 * Append-only audit trail for every wallet operation.
 * Logs to both console and a JSONL file (one JSON object per line).
 * Every operation is recorded regardless of success or failure.
 *
 * Log file: ./audit.jsonl
 * Format:   { timestamp, agentId, event, amount, to, signature, status, reason, policyStats }
 */

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(process.cwd(), 'audit.jsonl');

// Event types
const EVENTS = {
  POLICY_CHECK:   'policy:check',
  POLICY_BLOCKED: 'policy:blocked',
  TX_SIGNED:      'tx:signed',
  TX_CONFIRMED:   'tx:confirmed',
  TX_FAILED:      'tx:failed',
  TX_SIMULATED:   'tx:simulated',
  AGENT_START:    'agent:start',
  AGENT_TICK:     'agent:tick',
  BALANCE_CHECK:  'wallet:balance_check',
};

class AuditLogger {
  constructor(agentId) {
    this.agentId = agentId;
    this._entries = []; // in-memory for dashboard API
  }

  /**
   * Write an audit entry.
   * @param {string} event   One of EVENTS.*
   * @param {Object} details Extra context
   */
  log(event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      agentId:   this.agentId,
      event,
      ...details,
    };

    // In-memory (last 200 per agent)
    this._entries.unshift(entry);
    if (this._entries.length > 200) this._entries.pop();

    // Append to JSONL file (non-blocking)
    const line = JSON.stringify(entry) + '\n';
    fs.appendFile(LOG_FILE, line, () => {});

    return entry;
  }

  logPolicyCheck(amountSOL, result) {
    return this.log(result.allowed ? EVENTS.POLICY_CHECK : EVENTS.POLICY_BLOCKED, {
      amountSOL,
      allowed: result.allowed,
      reason:  result.reason || null,
    });
  }

  logTxSigned(amountSOL, toAddress) {
    return this.log(EVENTS.TX_SIGNED, { amountSOL, toAddress });
  }

  logTxConfirmed(amountSOL, toAddress, signature) {
    return this.log(EVENTS.TX_CONFIRMED, { amountSOL, toAddress, signature,
      solscan: `https://solscan.io/tx/${signature}?cluster=devnet` });
  }

  logTxFailed(amountSOL, toAddress, error) {
    return this.log(EVENTS.TX_FAILED, { amountSOL, toAddress, error: error?.message || String(error) });
  }

  logTxSimulated(amountSOL, type) {
    return this.log(EVENTS.TX_SIMULATED, { amountSOL, type });
  }

  logAgentStart(type, tickMs) {
    return this.log(EVENTS.AGENT_START, { type, tickMs });
  }

  /** Returns last N entries for dashboard */
  getEntries(n = 50) {
    return this._entries.slice(0, n);
  }
}

AuditLogger.EVENTS = EVENTS;

// Global log reader (for /api/audit endpoint)
AuditLogger.readAll = function(n = 100) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map(l => JSON.parse(l));
  } catch (_) {
    return [];
  }
};

module.exports = AuditLogger;
