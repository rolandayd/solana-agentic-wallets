/**
 * PolicyEngine.js
 *
 * Enforces safety guardrails before any transaction is signed.
 * Every agent wallet has its own policy instance.
 *
 * Rules enforced:
 *   - Per-transaction spend cap
 *   - Daily spend cap (rolling 24h window)
 *   - Per-hour transaction rate limit
 *   - Minimum SOL reserve (gas buffer)
 *   - Program allowlist (optional)
 */

class PolicyEngine {
  /**
   * @param {Object} policy
   * @param {number} policy.maxTxSOL        Max SOL per single transaction
   * @param {number} policy.dailyCapSOL     Max SOL spent in any 24h window
   * @param {number} policy.maxTxPerHour    Max transactions per hour
   * @param {number} policy.minReserveSOL   SOL floor — never go below this
   * @param {string[]} [policy.allowedPrograms] Optional program ID allowlist
   */
  constructor(policy = {}) {
    this.maxTxSOL       = policy.maxTxSOL      || 0.1;
    this.dailyCapSOL    = policy.dailyCapSOL   || 2.0;
    this.maxTxPerHour   = policy.maxTxPerHour  || 20;
    this.minReserveSOL  = policy.minReserveSOL || 0.05;
    this.allowedPrograms = policy.allowedPrograms || null; // null = allow all

    // Rolling windows
    this._txLog = []; // { time: Date, amount: number }
  }

  /**
   * Check if a proposed transaction is allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }
   *
   * @param {number} amountSOL   SOL amount being sent
   * @param {number} balanceSOL  Current wallet balance
   * @param {string} [programId] On-chain program being called
   */
  check(amountSOL, balanceSOL, programId = null) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo  = now - 24 * 60 * 60 * 1000;

    // Clean up old log entries
    this._txLog = this._txLog.filter(t => t.time > oneDayAgo);

    // 1. Per-tx cap
    if (amountSOL > this.maxTxSOL) {
      return { allowed: false, reason: `Amount ${amountSOL.toFixed(6)} SOL exceeds per-tx cap of ${this.maxTxSOL} SOL` };
    }

    // 2. Minimum reserve
    if (balanceSOL - amountSOL < this.minReserveSOL) {
      return { allowed: false, reason: `Transaction would breach minimum reserve of ${this.minReserveSOL} SOL` };
    }

    // 3. Daily cap
    const dailySpent = this._txLog
      .filter(t => t.time > oneDayAgo)
      .reduce((sum, t) => sum + t.amount, 0);
    if (dailySpent + amountSOL > this.dailyCapSOL) {
      return { allowed: false, reason: `Daily cap of ${this.dailyCapSOL} SOL would be exceeded (spent: ${dailySpent.toFixed(4)} SOL)` };
    }

    // 4. Hourly rate limit
    const txThisHour = this._txLog.filter(t => t.time > oneHourAgo).length;
    if (txThisHour >= this.maxTxPerHour) {
      return { allowed: false, reason: `Hourly rate limit of ${this.maxTxPerHour} tx/hr reached (${txThisHour} this hour)` };
    }

    // 5. Program allowlist
    if (this.allowedPrograms && programId && !this.allowedPrograms.includes(programId)) {
      return { allowed: false, reason: `Program ${programId} is not on the allowlist` };
    }

    return { allowed: true };
  }

  /**
   * Record a completed transaction.
   * Must be called after every successful transaction.
   */
  record(amountSOL) {
    this._txLog.push({ time: Date.now(), amount: amountSOL });
  }

  /**
   * Get current policy stats for dashboard/audit.
   */
  getStats() {
    const now = Date.now();
    const oneDayAgo  = now - 24 * 60 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    const recent = this._txLog.filter(t => t.time > oneDayAgo);
    return {
      maxTxSOL:       this.maxTxSOL,
      dailyCapSOL:    this.dailyCapSOL,
      maxTxPerHour:   this.maxTxPerHour,
      minReserveSOL:  this.minReserveSOL,
      dailySpentSOL:  +recent.reduce((s, t) => s + t.amount, 0).toFixed(6),
      txLast24h:      recent.length,
      txLastHour:     this._txLog.filter(t => t.time > oneHourAgo).length,
      dailyCapRemaining: +(this.dailyCapSOL - recent.reduce((s, t) => s + t.amount, 0)).toFixed(6),
    };
  }
}

module.exports = PolicyEngine;
