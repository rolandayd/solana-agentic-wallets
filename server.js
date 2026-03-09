#!/usr/bin/env node
require('dotenv').config();

const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const WalletManager  = require('./src/wallet/WalletManager');
const TradingAgent   = require('./src/agent/TradingAgent');
const LiquidityAgent = require('./src/agent/LiquidityAgent');
const ArbitrageAgent = require('./src/agent/ArbitrageAgent');
const PolicyEngine   = require('./src/wallet/PolicyEngine');
const AuditLogger    = require('./src/wallet/AuditLogger');
const messenger      = require('./src/agent/AgentMessenger');

const PORT = process.env.PORT || 3000;

const CONFIG = {
  network:      'devnet',
  keystorePath: './keystore',
  masterSecret: process.env.MASTER_SECRET || 'demo-secret-change-in-production',
  agents: [
    { id: 'trader-alpha',    type: 'trading',   tickMs: 6000  },
    { id: 'trader-beta',     type: 'trading',   tickMs: 8000  },
    { id: 'liquidity-gamma', type: 'liquidity', tickMs: 14000 },
    { id: 'arbitrage-delta', type: 'arbitrage', tickMs: 5000  },
  ],
  trading:   { minTradeSOL: 0.005, maxTradeSOL: 0.05, minSOLReserve: 0.2, priceWindow: 4 },
  arbitrage: { minTradeSOL: 0.005, maxTradeSOL: 0.03, spreadThreshold: 0.015, estimatedFeePct: 0.003, minSOLReserve: 0.2 },
  liquidity: { targetRatio: 0.5, rebalanceThreshold: 0.04, minTradeSOL: 0.005, maxTradeSOL: 0.02, minSOLReserve: 0.2 },

  // ── Per-agent policy rules ────────────────────────────────────────────────
  policy: {
    'trader-alpha':    { maxTxSOL: 0.06, dailyCapSOL: 3.0, maxTxPerHour: 30, minReserveSOL: 0.2 },
    'trader-beta':     { maxTxSOL: 0.06, dailyCapSOL: 3.0, maxTxPerHour: 30, minReserveSOL: 0.2 },
    'liquidity-gamma': { maxTxSOL: 0.03, dailyCapSOL: 1.0, maxTxPerHour: 10, minReserveSOL: 0.2 },
    'arbitrage-delta': { maxTxSOL: 0.04, dailyCapSOL: 2.0, maxTxPerHour: 20, minReserveSOL: 0.2 },
  },
};

const liveState = {
  initialized: false,
  agents: {},
  transactions: [],
  auditLog: [],
  messages: [],
  policies: {},
  portfolio: { totalAgents: 0, totalSOL: 0, wallets: [] },
  startTime: Date.now(),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randSOL(min, max) { return +(Math.random() * (max - min) + min).toFixed(4); }

function logAction(agentId, type, amount, fromAddr, toAddr, sig, blocked, reason) {
  const status = blocked ? `🚫 BLOCKED — ${reason}` : sig ? `✅ ON-CHAIN | ${sig.slice(0,20)}...` : '📋 SIMULATED';
  console.log(`\n┌─ ACTION ──────────────────────────────────────────────`);
  console.log(`│  Agent  : ${agentId}`);
  console.log(`│  Type   : ${type}`);
  console.log(`│  Amount : ${amount.toFixed(6)} SOL`);
  if (fromAddr) console.log(`│  From   : ${fromAddr.slice(0,8)}...`);
  if (toAddr)   console.log(`│  To     : ${toAddr.slice(0,8)}...`);
  console.log(`│  Status : ${status}`);
  console.log(`└───────────────────────────────────────────────────────\n`);
}

async function bootstrap() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SOLANA AGENTIC WALLET — SERVER STARTING');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const manager = new WalletManager({ network: CONFIG.network, keystorePath: CONFIG.keystorePath, masterSecret: CONFIG.masterSecret });
  await manager.loadAgents(CONFIG.agents.map(a => a.id));
  // Forward fleet messages to liveState for dashboard
  messenger.on('message', (msg) => {
    liveState.messages.unshift(msg);
    if (liveState.messages.length > 200) liveState.messages.pop();
  });

  console.log('✓ Wallets loaded\n');

  const alphaAddress = manager.getWallet('trader-alpha').getAddress();
  const betaAddress  = manager.getWallet('trader-beta').getAddress();
  const gammaAddress = manager.getWallet('liquidity-gamma').getAddress();

  console.log('  WALLET ADDRESSES');
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const id of CONFIG.agents.map(a => a.id)) {
    console.log(`  ${id.padEnd(20)} : ${manager.getWallet(id).getAddress()}`);
  }
  console.log('  ─────────────────────────────────────────────────────────────\n');

  // ── Build policy engines and audit loggers ────────────────────────────────
  const policies = {};
  const auditors = {};
  for (const agentConfig of CONFIG.agents) {
    policies[agentConfig.id] = new PolicyEngine(CONFIG.policy[agentConfig.id]);
    auditors[agentConfig.id] = new AuditLogger(agentConfig.id);
    liveState.policies[agentConfig.id] = policies[agentConfig.id].getStats();
  }
  // Seed audit log from disk so dashboard shows history immediately
  try {
    const diskEntries = AuditLogger.readAll(100);
    diskEntries.forEach(e => { if (!liveState.auditLog.find(x => x.id === e.id)) liveState.auditLog.push(e); });
    console.log(`✓ Loaded ${diskEntries.length} audit entries from disk`);
  } catch (_) {}
  console.log('✓ Policy engines initialized\n');

  // ── Check balances ────────────────────────────────────────────────────────
  console.log('Checking balances...');
  for (const agentId of ['trader-alpha', 'trader-beta', 'liquidity-gamma', 'arbitrage-delta']) {
    const wallet = manager.getWallet(agentId);
    const bal = await wallet.getSOLBalance();
    console.log(`  ${agentId.padEnd(20)} : ${bal.toFixed(4)} SOL`);
    if (bal < 0.5 && ['trader-alpha', 'trader-beta'].includes(agentId)) {
      try { await wallet.requestAirdrop(2); console.log(`  ✓ Airdropped ${agentId}`); await sleep(2000); }
      catch (err) { console.log(`  ✗ Airdrop failed: ${err.message}`); }
    }
    await sleep(300);
  }
  console.log();

  // ── Build and start agents ────────────────────────────────────────────────
  const agents = [];

  for (const agentConfig of CONFIG.agents) {
    const wallet  = manager.getWallet(agentConfig.id);
    const policy  = policies[agentConfig.id];
    const auditor = auditors[agentConfig.id];
    let agent;

    if (agentConfig.type === 'trading') {
      const counterpartyAddress = agentConfig.id === 'trader-alpha' ? betaAddress : alphaAddress;
      agent = new TradingAgent({
        agentId: agentConfig.id, wallet, tickMs: agentConfig.tickMs,
        tradeAmountSOL: randSOL(CONFIG.trading.minTradeSOL, CONFIG.trading.maxTradeSOL),
        priceWindow: CONFIG.trading.priceWindow,
        minSOLReserve: CONFIG.trading.minSOLReserve,
        counterparty: { address: counterpartyAddress },
      });
    }
    if (agentConfig.type === 'liquidity') {
      agent = new LiquidityAgent({
        agentId: agentConfig.id, wallet, tickMs: agentConfig.tickMs,
        targetRatio: CONFIG.liquidity.targetRatio,
        rebalanceThreshold: CONFIG.liquidity.rebalanceThreshold,
        maxPositionSOL: CONFIG.liquidity.maxTradeSOL,
        counterparty: { address: alphaAddress },
      });
    }
    if (agentConfig.type === 'arbitrage') {
      agent = new ArbitrageAgent({
        agentId: agentConfig.id, wallet, tickMs: agentConfig.tickMs,
        spreadThreshold: CONFIG.arbitrage.spreadThreshold,
        tradeAmountSOL: randSOL(CONFIG.arbitrage.minTradeSOL, CONFIG.arbitrage.maxTradeSOL),
        estimatedFeePct: CONFIG.arbitrage.estimatedFeePct,
        minSOLReserve: CONFIG.arbitrage.minSOLReserve,
        counterparty: { address: betaAddress },
      });
    }

    // ── Action event: policy check → audit → record ──────────────────────
    agent.on('action', async ({ agentId, action, result }) => {
      const amount    = action.params?.amount || 0;
      const fromAddr  = wallet.getAddress();
      const toAddr    = agentConfig.type === 'trading'   ? (agentConfig.id === 'trader-alpha' ? betaAddress : alphaAddress)
                      : agentConfig.type === 'liquidity' ? alphaAddress
                      : agentConfig.type === 'arbitrage' ? betaAddress : null;

      // Randomize next trade amount
      if (agentConfig.type === 'trading')   agent.tradeAmountSOL = randSOL(CONFIG.trading.minTradeSOL, CONFIG.trading.maxTradeSOL);
      if (agentConfig.type === 'arbitrage') agent.tradeAmountSOL = randSOL(CONFIG.arbitrage.minTradeSOL, CONFIG.arbitrage.maxTradeSOL);

      // Policy check
      let currentBal = 0;
      try { currentBal = await wallet.getSOLBalance(); } catch (_) {}
      const policyResult = policy.check(amount, currentBal);
      auditor.logPolicyCheck(amount, policyResult);

      if (!policyResult.allowed) {
        logAction(agentId, action.type, amount, fromAddr, toAddr, null, true, policyResult.reason);
        // Add blocked entry to audit log
        const blockedEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, time: new Date().toISOString(), agentId, type: action.type, amount, status: 'blocked', reason: policyResult.reason };
        liveState.auditLog.unshift(blockedEntry);
        return;
      }

      // Record in policy engine
      if (result?.signature) {
        policy.record(amount);
        auditor.logTxConfirmed(amount, toAddr, result.signature);
      } else if (result?.simulated) {
        auditor.logTxSimulated(amount, action.type);
      }

      // Update policy stats
      liveState.policies[agentId] = policy.getStats();

      logAction(agentId, action.type, amount, fromAddr, toAddr, result?.signature || null, false, null);

      const txEntry = {
        id:        `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        time:      new Date().toISOString(),
        agentId,
        type:      action.type,
        amount,
        price:     action.params?.price || 0,
        from:      fromAddr,
        to:        toAddr,
        signature: result?.signature || null,
        simulated: result?.simulated || false,
        status:    result?.signature ? 'confirmed' : 'simulated',
        solscan:   result?.signature ? `https://solscan.io/tx/${result.signature}?cluster=devnet` : null,
      };
      liveState.transactions.unshift(txEntry);
      if (liveState.transactions.length > 200) liveState.transactions.pop();

      // Audit log entry
      liveState.auditLog.unshift({ ...txEntry, event: result?.signature ? 'tx:confirmed' : 'tx:simulated' });
      if (liveState.auditLog.length > 500) liveState.auditLog.pop();
    });

    agent.on('error', ({ agentId, error }) => {
      auditors[agentId]?.log('tx:failed', { error: error.message });
      console.error(`⚠  ${agentId} | ${error.message}`);
    });

    auditor.logAgentStart(agentConfig.type, agentConfig.tickMs);
    // Populate policy stats immediately so dashboard shows data on load
    liveState.policies[agentConfig.id] = policies[agentConfig.id].getStats();

    liveState.agents[agentConfig.id] = {
      agentId: agentConfig.id, type: agentConfig.type,
      address: wallet.getAddress(), status: 'starting',
      balance: 0, ticks: 0, actions: 0, state: {},
    };

    await agent.initialize();
    agent.start();
    agents.push(agent);

    // Seed audit log with agent start entry immediately
    const startEntry = {
      id:      `start-${agentConfig.id}-${Date.now()}`,
      time:    new Date().toISOString(),
      agentId: agentConfig.id,
      event:   'agent:start',
      type:    agentConfig.type,
      status:  'active',
      tickMs:  agentConfig.tickMs,
    };
    liveState.auditLog.unshift(startEntry);

    console.log(`✓ ${agentConfig.id.padEnd(20)} started (${agentConfig.type}, ${agentConfig.tickMs}ms)`);
  }

  console.log(`\n  ✅ All agents running → http://localhost:${PORT}\n`);
  liveState.initialized = true;

  // ── Sync state every 4s ────────────────────────────────────────────────────
  setInterval(async () => {
    try {
      for (const agent of agents) {
        const s = agent.getState();
        const wallet = manager.getWallet(agent.agentId);
        let balance = liveState.agents[agent.agentId]?.balance || 0;
        try { balance = await wallet.getSOLBalance(); } catch (_) {}
        liveState.agents[agent.agentId] = {
          ...liveState.agents[agent.agentId],
          status: 'active', balance,
          ticks: s.tickCount || 0,
          actions: agent.getHistory().length,
          state: { signal: s.signal||null, price: s.currentPrice||null, shortMA: s.shortMA||null, longMA: s.longMA||null, poolRatio: s.poolRatio||null, drift: s.drift||null, spreadPct: s.spreadPct||null },
        };
        liveState.policies[agent.agentId] = policies[agent.agentId].getStats();
      }
      liveState.portfolio = await manager.getPortfolioSummary();
    } catch (_) {}
  }, 4000);
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}
function sendJSON(res, data, status = 200) {
  cors(res); res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/' || url === '/dashboard' || url === '/dashboard.html') {
    try { const html = fs.readFileSync(path.join(__dirname, 'dashboard.html')); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
    catch (_) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  if (url === '/api/status') return sendJSON(res, {
    initialized: liveState.initialized,
    uptime: Math.floor((Date.now() - liveState.startTime) / 1000),
    agentCount: Object.keys(liveState.agents).length,
    agents: Object.values(liveState.agents),
    portfolio: liveState.portfolio,
    timestamp: new Date().toISOString(),
  });

  if (url.startsWith('/api/agent/')) {
    const agent = liveState.agents[url.replace('/api/agent/', '')];
    return agent ? sendJSON(res, agent) : sendJSON(res, { error: 'not found' }, 404);
  }

  if (url === '/api/transactions') return sendJSON(res, { count: liveState.transactions.length, transactions: liveState.transactions.slice(0, 100) });
  if (url === '/api/portfolio')    return sendJSON(res, liveState.portfolio);

  // ── NEW: Policy and Audit endpoints ──────────────────────────────────────
  if (url === '/api/messages') return sendJSON(res, { count: liveState.messages.length, messages: liveState.messages.slice(0, 100) });
  if (url === '/api/policy') return sendJSON(res, liveState.policies);
  if (url === '/api/audit')  return sendJSON(res, { count: liveState.auditLog.length, entries: liveState.auditLog.slice(0, 200) });

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\nServer listening on http://localhost:${PORT}`);
  try { await bootstrap(); } catch (err) { console.error('Bootstrap error:', err); }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n❌ Port ${PORT} in use.\n   taskkill /PID $(netstat -ano | findstr :${PORT}) /F\n`);
  else console.error('Server error:', err.message);
  process.exit(1);
});
