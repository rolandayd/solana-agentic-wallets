/**
 * tests/wallet.test.js
 * 
 * Test harness for AgentWallet and multi-agent scenarios.
 * Uses Node's built-in test runner.
 * 
 * Run: node --test tests/wallet.test.js
 * Or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AgentWallet = require('../src/wallet/AgentWallet');
const WalletManager = require('../src/wallet/WalletManager');
const MockPriceFeed = require('../src/protocols/MockPriceFeed');
const MockDApp = require('../src/protocols/MockDApp');

const TEST_KEYSTORE = './keystore-test';
const MASTER_SECRET = 'test-master-secret-unit-tests';
const NETWORK = 'devnet';

// ─── Helper ─────────────────────────────────────────────────────────────────────

function makeWallet(agentId) {
  return new AgentWallet({
    agentId,
    keystorePath: TEST_KEYSTORE,
    network: NETWORK,
    masterSecret: MASTER_SECRET,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('AgentWallet — Key Management', () => {
  after(() => {
    // Cleanup test keystores
    if (fs.existsSync(TEST_KEYSTORE)) {
      fs.rmSync(TEST_KEYSTORE, { recursive: true });
    }
  });

  it('creates a new wallet and generates a unique public key', async () => {
    const wallet = makeWallet('test-agent-1');
    await wallet.connect();
    const address = await wallet.create();

    assert.ok(address, 'Address should be defined');
    assert.equal(address.length, 44, 'Solana address should be 44 characters (base58)');
  });

  it('persists the wallet to disk and can reload it', async () => {
    const wallet1 = makeWallet('test-agent-persist');
    await wallet1.connect();
    const address1 = await wallet1.create();

    // Load fresh instance
    const wallet2 = makeWallet('test-agent-persist');
    await wallet2.connect();
    await wallet2.load();

    assert.equal(wallet2.getAddress(), address1, 'Loaded wallet should have same address');
  });

  it('generates different keys for different agents', async () => {
    const w1 = makeWallet('test-agent-diff-1');
    const w2 = makeWallet('test-agent-diff-2');

    await w1.connect(); await w1.create();
    await w2.connect(); await w2.create();

    assert.notEqual(w1.getAddress(), w2.getAddress(), 'Different agents must have different keys');
  });

  it('throws when creating a wallet that already exists', async () => {
    const wallet = makeWallet('test-agent-dupe');
    await wallet.connect();
    await wallet.create();

    await assert.rejects(
      async () => { await wallet.create(); },
      /already exists/
    );
  });

  it('throws when loading a wallet that does not exist', async () => {
    const wallet = makeWallet('test-agent-nonexistent-xyz');
    await wallet.connect();

    await assert.rejects(
      async () => { await wallet.load(); },
      /No wallet found/
    );
  });

  it('initialize() is idempotent — create then initialize returns same address', async () => {
    const id = 'test-agent-idempotent';
    const w1 = makeWallet(id);
    await w1.connect();
    const addr1 = await w1.create();

    const w2 = makeWallet(id);
    await w2.connect();
    await w2.initialize();

    assert.equal(w2.getAddress(), addr1);
  });

  it('keystore file has restricted permissions (mode 0o600)', async () => {
    const id = 'test-agent-permissions';
    const wallet = makeWallet(id);
    await wallet.connect();
    await wallet.create();

    const keystoreFile = path.join(TEST_KEYSTORE, `${id}.keystore.json`);
    const stats = fs.statSync(keystoreFile);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`);
  });
});

describe('AgentWallet — Message Signing', () => {
  it('signs a message without error', async () => {
    const wallet = makeWallet('test-agent-signing');
    await wallet.connect();
    await wallet.initialize();

    const message = Buffer.from('hello from agent');
    const signature = wallet.signMessage(message);

    assert.ok(signature instanceof Uint8Array, 'Signature should be Uint8Array');
    assert.equal(signature.length, 64, 'Ed25519 signature should be 64 bytes');
  });

  it('produces different signatures for different messages', async () => {
    const wallet = makeWallet('test-agent-signing-diff');
    await wallet.connect();
    await wallet.initialize();

    const sig1 = wallet.signMessage(Buffer.from('message one'));
    const sig2 = wallet.signMessage(Buffer.from('message two'));

    assert.notDeepEqual(sig1, sig2);
  });
});

describe('WalletManager — Multi-Agent', () => {
  it('creates and manages multiple agent wallets independently', async () => {
    const manager = new WalletManager({
      network: NETWORK,
      keystorePath: TEST_KEYSTORE,
      masterSecret: MASTER_SECRET,
    });

    const agentIds = ['manager-agent-1', 'manager-agent-2', 'manager-agent-3'];
    await manager.loadAgents(agentIds);

    const addresses = agentIds.map(id => manager.getWallet(id).getAddress());
    const uniqueAddresses = new Set(addresses);

    assert.equal(uniqueAddresses.size, 3, 'All 3 agents should have unique addresses');
  });

  it('getPortfolioSummary returns correct agent count', async () => {
    const manager = new WalletManager({
      network: NETWORK,
      keystorePath: TEST_KEYSTORE,
      masterSecret: MASTER_SECRET,
    });

    await manager.loadAgents(['portfolio-agent-1', 'portfolio-agent-2']);
    const summary = await manager.getPortfolioSummary();

    assert.equal(summary.totalAgents, 2);
    assert.ok(Array.isArray(summary.agents));
  });
});

describe('MockPriceFeed — Simulation', () => {
  it('returns a positive price', async () => {
    const feed = new MockPriceFeed('SOL/USD', 150);
    const price = await feed.getPrice();
    assert.ok(price > 0, 'Price should be positive');
  });

  it('generates different prices on successive calls', async () => {
    const feed = new MockPriceFeed('SOL/USD', 150, 0.05);
    const prices = [];
    for (let i = 0; i < 10; i++) prices.push(await feed.getPrice());
    const uniquePrices = new Set(prices.map(p => p.toFixed(4)));
    assert.ok(uniquePrices.size > 1, 'Price feed should produce varying prices');
  });
});

describe('MockDApp — Protocol Interaction', () => {
  it('records deposits and tracks balances correctly', () => {
    const dapp = new MockDApp(null, null);
    dapp.recordDeposit('agent-addr-1', 1_000_000_000); // 1 SOL
    assert.equal(dapp.getBalance('agent-addr-1'), 1_000_000_000);
  });

  it('simulates a swap and reduces balance', () => {
    const dapp = new MockDApp(null, null);
    dapp.recordDeposit('agent-addr-2', 2_000_000_000);
    const swap = dapp.simulateSwap('agent-addr-2', 1, 'USDC', 150);

    assert.equal(swap.toAmount, 150);
    assert.equal(swap.toToken, 'USDC');
    assert.equal(dapp.getBalance('agent-addr-2'), 1_000_000_000); // 1 SOL remaining
  });

  it('throws on insufficient balance', () => {
    const dapp = new MockDApp(null, null);
    dapp.recordDeposit('agent-addr-3', 500_000_000); // 0.5 SOL

    assert.throws(
      () => dapp.simulateSwap('agent-addr-3', 1, 'USDC'),
      /Insufficient balance/
    );
  });
});
