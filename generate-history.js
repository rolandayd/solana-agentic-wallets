#!/usr/bin/env node
/**
 * generate-history.js
 *
 * Funds all three agent wallets via devnet airdrop and executes
 * real SOL transfers between them — creating genuine on-chain
 * transaction history that judges can verify on Solana Explorer.
 *
 * What this produces on-chain:
 * - 3 airdrop transactions (one per wallet)
 * - 6 SOL transfers between agents (round-robin)
 * - Every transaction verifiable at explorer.solana.com (Devnet)
 *
 * Run: node generate-history.js
 */

require('dotenv').config();
const { Connection, clusterApiUrl } = require('@solana/web3.js');
const AgentWallet = require('./src/wallet/AgentWallet');

const MASTER_SECRET = process.env.MASTER_SECRET || 'my-super-secret-key-abc123xyz';
const KEYSTORE = './keystore';
const NETWORK = 'devnet';

const AGENTS = [
  'trader-alpha',
  'trader-beta',
  'liquidity-gamma',
];

function makeWallet(agentId) {
  return new AgentWallet({
    agentId,
    keystorePath: KEYSTORE,
    network: NETWORK,
    masterSecret: MASTER_SECRET,
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function separator(label) {
  console.log(`\n${'─'.repeat(55)}`);
  if (label) console.log(` ${label}`);
  console.log('─'.repeat(55));
}

async function main() {
  separator('GENERATING ON-CHAIN TRANSACTION HISTORY');
  console.log('This script creates real devnet transactions for all agents.');
  console.log('Every transaction will be visible on Solana Explorer.\n');

  // ── Load all wallets ────────────────────────────────────────
  separator('Loading Agent Wallets');
  const wallets = {};
  for (const id of AGENTS) {
    const w = makeWallet(id);
    await w.connect();
    await w.initialize();
    wallets[id] = w;
    console.log(`✓ ${id}: ${w.getAddress()}`);
  }

  // ── Airdrop all agents ──────────────────────────────────────
  separator('Airdropping SOL to All Agents');
  for (const id of AGENTS) {
    try {
      const before = await wallets[id].getSOLBalance();
      if (before >= 0.5) {
        console.log(`  ${id}: already has ${before.toFixed(4)} SOL — skipping airdrop`);
        continue;
      }
      console.log(`  Requesting airdrop for ${id}...`);
      const sig = await wallets[id].requestAirdrop(1);
      console.log(`  ✓ ${id}: airdrop confirmed`);
      console.log(`    TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await sleep(2000);
    } catch (err) {
      console.log(`  ✗ ${id}: airdrop failed (${err.message}) — trying to continue`);
    }
  }

  await sleep(3000);

  // ── Show balances ───────────────────────────────────────────
  separator('Balances After Airdrop');
  for (const id of AGENTS) {
    const bal = await wallets[id].getSOLBalance();
    console.log(`  ${id}: ${bal.toFixed(6)} SOL`);
  }

  // ── Round-robin transfers ───────────────────────────────────
  separator('Executing Round-Robin Transfers Between Agents');
  console.log('Creating real on-chain transfer history...\n');

  const transfers = [
    { from: 'trader-alpha',    to: 'trader-beta',      amount: 0.005 },
    { from: 'trader-beta',     to: 'liquidity-gamma',  amount: 0.004 },
    { from: 'liquidity-gamma', to: 'trader-alpha',     amount: 0.003 },
    { from: 'trader-alpha',    to: 'liquidity-gamma',  amount: 0.003 },
    { from: 'trader-beta',     to: 'trader-alpha',     amount: 0.002 },
    { from: 'liquidity-gamma', to: 'trader-beta',      amount: 0.002 },
  ];

  const signatures = [];

  for (const t of transfers) {
    try {
      const fromWallet = wallets[t.from];
      const toAddress = wallets[t.to].getAddress();
      const bal = await fromWallet.getSOLBalance();

      if (bal < t.amount + 0.002) {
        console.log(`  ✗ ${t.from} → ${t.to}: insufficient balance (${bal.toFixed(4)} SOL)`);
        continue;
      }

      console.log(`  Sending ${t.amount} SOL: ${t.from} → ${t.to}...`);
      const sig = await fromWallet.transferSOL(toAddress, t.amount);
      signatures.push({ ...t, signature: sig });

      console.log(`  ✓ Confirmed!`);
      console.log(`    TX: https://explorer.solana.com/tx/${sig}?cluster=devnet\n`);
      await sleep(1500);
    } catch (err) {
      console.log(`  ✗ ${t.from} → ${t.to}: ${err.message}\n`);
    }
  }

  // ── Final balances ──────────────────────────────────────────
  separator('Final Balances');
  for (const id of AGENTS) {
    const bal = await wallets[id].getSOLBalance();
    const addr = wallets[id].getAddress();
    console.log(`  ${id}`);
    console.log(`    Address: ${addr}`);
    console.log(`    Balance: ${bal.toFixed(6)} SOL`);
    console.log(`    Explorer: https://explorer.solana.com/address/${addr}?cluster=devnet\n`);
  }

  // ── Transaction summary ─────────────────────────────────────
  separator(`Transaction History — ${signatures.length} Confirmed TXs`);
  signatures.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.from} → ${s.to}: ${s.amount} SOL`);
    console.log(`     https://explorer.solana.com/tx/${s.signature}?cluster=devnet`);
  });

  separator('DONE');
  console.log('All transactions are now live on Solana devnet.');
  console.log('Paste any address or TX link into Solana Explorer to verify.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
