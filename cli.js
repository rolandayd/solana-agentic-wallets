#!/usr/bin/env node
/**
 * cli.js
 * 
 * Command-line interface for managing and observing agent wallets.
 * 
 * Usage:
 *   node cli.js create <agent-id>          - Create wallet for an agent
 *   node cli.js status <agent-id>          - Show wallet status
 *   node cli.js airdrop <agent-id> [sol]   - Request devnet airdrop
 *   node cli.js transfer <from> <to> <sol> - Transfer SOL between agents
 *   node cli.js portfolio                   - Show all agent wallets
 *   node cli.js watch <agent-id>           - Live-watch agent decision loop
 */

require('dotenv').config();
const AgentWallet = require('./src/wallet/AgentWallet');
const WalletManager = require('./src/wallet/WalletManager');

const MASTER_SECRET = process.env.MASTER_SECRET || 'demo-secret-change-in-production';
const NETWORK = process.env.NETWORK || 'devnet';
const KEYSTORE = process.env.KEYSTORE_PATH || './keystore';

function buildWallet(agentId) {
  return new AgentWallet({
    agentId,
    keystorePath: KEYSTORE,
    network: NETWORK,
    masterSecret: MASTER_SECRET,
  });
}

async function cmd_create(agentId) {
  const wallet = buildWallet(agentId);
  await wallet.connect();
  const address = await wallet.create();
  console.log(`✓ Created wallet for agent '${agentId}'`);
  console.log(`  Address: ${address}`);
  console.log(`  Network: ${NETWORK}`);
  console.log(`  Keystore: ${KEYSTORE}/${agentId}.keystore.json`);
}

async function cmd_status(agentId) {
  const wallet = buildWallet(agentId);
  await wallet.connect();
  await wallet.load();
  const status = await wallet.getStatus();
  console.log(`\n Agent Wallet Status`);
  console.log(`  Agent ID:    ${status.agentId}`);
  console.log(`  Address:     ${status.address}`);
  console.log(`  Network:     ${status.network}`);
  console.log(`  SOL Balance: ${status.solBalance.toFixed(6)} SOL`);
  console.log(`  Active:      ${status.isActive}`);
}

async function cmd_airdrop(agentId, amount = 1) {
  const wallet = buildWallet(agentId);
  await wallet.connect();
  await wallet.load();
  console.log(`Requesting ${amount} SOL airdrop for ${agentId}...`);
  const sig = await wallet.requestAirdrop(parseFloat(amount));
  console.log(`✓ Airdrop confirmed: ${sig}`);
  const balance = await wallet.getSOLBalance();
  console.log(`  New balance: ${balance.toFixed(6)} SOL`);
}

async function cmd_transfer(fromId, toId, amount) {
  const fromWallet = buildWallet(fromId);
  const toWallet = buildWallet(toId);

  await fromWallet.connect();
  await fromWallet.load();
  await toWallet.connect();
  await toWallet.load();

  const toAddress = toWallet.getAddress();
  console.log(`Transferring ${amount} SOL from ${fromId} to ${toId} (${toAddress.slice(0, 8)}...)...`);

  const sig = await fromWallet.transferSOL(toAddress, parseFloat(amount));
  console.log(`✓ Transfer complete: ${sig}`);
}

async function cmd_portfolio() {
  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(KEYSTORE)) {
    console.log('No keystore directory found. Create some agents first.');
    return;
  }

  const files = fs.readdirSync(KEYSTORE).filter(f => f.endsWith('.keystore.json'));
  if (!files.length) {
    console.log('No agent keystores found.');
    return;
  }

  console.log(`\n Portfolio — ${files.length} agent wallets\n`);

  let totalSOL = 0;
  for (const file of files) {
    const agentId = file.replace('.keystore.json', '');
    try {
      const wallet = buildWallet(agentId);
      await wallet.connect();
      await wallet.load();
      const balance = await wallet.getSOLBalance();
      totalSOL += balance;
      console.log(`  ${agentId.padEnd(20)} ${wallet.getAddress().slice(0, 12)}...  ${balance.toFixed(6)} SOL`);
    } catch (err) {
      console.log(`  ${agentId.padEnd(20)} [error loading: ${err.message}]`);
    }
  }

  console.log(`\n  ${'─'.repeat(55)}`);
  console.log(`  ${'TOTAL'.padEnd(35)} ${totalSOL.toFixed(6)} SOL`);
}

async function cmd_watch(agentId) {
  const TradingAgent = require('./src/agent/TradingAgent');

  const wallet = buildWallet(agentId);
  await wallet.connect();
  await wallet.load();

  console.log(`\nWatching agent ${agentId} (${wallet.getAddress()})`);
  console.log('Press Ctrl+C to stop.\n');

  const agent = new TradingAgent({
    agentId,
    wallet,
    tickMs: 3000,
    tradeAmountSOL: 0.001,
    priceWindow: 4,
  });

  agent.on('action', ({ action, result }) => {
    console.log(`\n🔔 ${new Date().toISOString()} — ACTION: ${action.type}`);
    console.log(`   Params: ${JSON.stringify(action.params)}`);
    console.log(`   Result: ${JSON.stringify(result)}`);
  });

  await agent.initialize();
  agent.start();

  process.on('SIGINT', () => {
    agent.stop();
    console.log('\n\nFinal state:');
    console.log(JSON.stringify(agent.getState(), null, 2));
    process.exit(0);
  });
}

// ─── Command Router ─────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

const commands = {
  create:    () => cmd_create(args[0]),
  status:    () => cmd_status(args[0]),
  airdrop:   () => cmd_airdrop(args[0], args[1]),
  transfer:  () => cmd_transfer(args[0], args[1], args[2]),
  portfolio: () => cmd_portfolio(),
  watch:     () => cmd_watch(args[0]),
};

if (!command || !commands[command]) {
  console.log(`
Solana Agentic Wallet CLI

Usage:
  node cli.js create <agent-id>                - Create wallet
  node cli.js status <agent-id>                - Show wallet status  
  node cli.js airdrop <agent-id> [sol]         - Devnet airdrop
  node cli.js transfer <from> <to> <sol>       - Transfer SOL
  node cli.js portfolio                         - All wallets overview
  node cli.js watch <agent-id>                  - Live agent loop

Environment:
  MASTER_SECRET   Encryption master secret (required in production)
  NETWORK         devnet | testnet | mainnet-beta (default: devnet)
  KEYSTORE_PATH   Path to keystore directory (default: ./keystore)
  `);
  process.exit(0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
