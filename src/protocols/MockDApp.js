/**
 * MockDApp.js
 * 
 * Simulates a minimal test DeFi protocol on devnet.
 * Accepts SOL deposits, tracks balances, processes simple swaps.
 * 
 * Serves as the counterparty for TradingAgent transaction demos.
 * Replace with real Jupiter/Orca instructions for production.
 * 
 * This is what agents interact with — the wallet just signs the instructions.
 */

const {
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

class MockDApp {
  /**
   * @param {Connection} connection     - Solana connection
   * @param {Keypair}    operatorKeypair - The dApp "treasury" keypair
   */
  constructor(connection, operatorKeypair) {
    this.connection = connection;
    this.operator = operatorKeypair;
    this.deposits = new Map();  // agentAddress → lamport amount
    this.swaps = [];
  }

  getAddress() {
    return this.operator.publicKey.toBase58();
  }

  /**
   * Record a deposit from an agent.
   * In production this would verify the on-chain transaction.
   */
  recordDeposit(agentAddress, lamports) {
    const current = this.deposits.get(agentAddress) || 0;
    this.deposits.set(agentAddress, current + lamports);
    console.log(`[MockDApp] Recorded deposit: ${agentAddress.slice(0, 8)}... deposited ${lamports / 1e9} SOL`);
  }

  /**
   * Get deposit balance for an agent.
   */
  getBalance(agentAddress) {
    return this.deposits.get(agentAddress) || 0;
  }

  /**
   * Simulate a swap: SOL → Token
   * Returns simulated token amount at a mock rate.
   */
  simulateSwap(agentAddress, solAmount, tokenSymbol = 'USDC', rate = 150) {
    const currentBalance = this.deposits.get(agentAddress) || 0;
    const lamports = Math.floor(solAmount * 1e9);

    if (currentBalance < lamports) {
      throw new Error(`Insufficient balance. Have: ${currentBalance / 1e9} SOL, need: ${solAmount} SOL`);
    }

    this.deposits.set(agentAddress, currentBalance - lamports);
    const tokenAmount = solAmount * rate;

    const swap = {
      agentAddress,
      fromAmount: solAmount,
      fromToken: 'SOL',
      toAmount: tokenAmount,
      toToken: tokenSymbol,
      rate,
      timestamp: new Date().toISOString(),
    };

    this.swaps.push(swap);
    console.log(`[MockDApp] Swap: ${solAmount} SOL → ${tokenAmount} ${tokenSymbol} for ${agentAddress.slice(0, 8)}...`);
    return swap;
  }

  /**
   * Get full activity log.
   */
  getActivityLog() {
    return {
      deposits: Object.fromEntries(this.deposits),
      swapCount: this.swaps.length,
      swaps: this.swaps,
    };
  }
}

module.exports = MockDApp;
