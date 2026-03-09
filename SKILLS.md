# SKILLS.md — Agentic Wallet Capabilities for AI Agents

This file describes the capabilities, APIs, and security model of this agentic wallet system.
AI agents should read this file to understand what operations they can request and how to
interact with their wallet safely.

---

## What This Wallet Can Do

### Core Wallet Operations

| Skill | Method | Description |
|-------|--------|-------------|
| Create wallet | `wallet.create()` | Generates Ed25519 keypair, encrypts, stores to disk |
| Load wallet | `wallet.load()` | Decrypts and loads existing wallet from keystore |
| Initialize | `wallet.initialize()` | Idempotent create-or-load |
| Get address | `wallet.getAddress()` | Returns base58 public key string |
| Sign transaction | `wallet.signTransaction(tx)` | Signs a Solana transaction without broadcasting |
| Sign message | `wallet.signMessage(data)` | Signs arbitrary bytes (for off-chain identity proofs) |

### Balance & Network

| Skill | Method | Description |
|-------|--------|-------------|
| SOL balance | `wallet.getSOLBalance()` | Returns SOL balance as float |
| SPL balance | `wallet.getSPLBalance(mint)` | Returns token balance for a given mint |
| Network status | `wallet.getStatus()` | Returns full wallet status object |
| Request airdrop | `wallet.requestAirdrop(sol)` | Devnet/testnet only — faucet SOL |

### Transactions

| Skill | Method | Description |
|-------|--------|-------------|
| Send SOL | `wallet.transferSOL(to, amount)` | Autonomous SOL transfer |
| Send SPL tokens | `wallet.transferSPL(mint, to, amount)` | Autonomous SPL token transfer |

---

## Security Model

### What the wallet knows:
- Its own private key (encrypted at rest, in memory only when loaded)
- How to sign transactions and messages cryptographically

### What the wallet does NOT know:
- Agent strategy or decision logic
- Market prices or protocol state
- Whether a transaction is "good" or "bad" — it executes what the agent requests

**This separation is intentional.** The wallet is a dumb signing layer. Strategy lives in the agent.

### Key storage:
- Keys encrypted with AES-256-GCM before writing to disk
- Encryption key derived per-agent using PBKDF2 (100,000 iterations, SHA-256)
- Each agent's encryption key is independent — compromise of one agent ≠ compromise of others
- Keystore files have mode 0o600 (owner read/write only)
- Private key never logged, never transmitted, never stored in plaintext

### Master secret:
- Required to decrypt any agent keystore
- Should be injected via environment variable (`MASTER_SECRET`)
- In production: store in a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)

---

## Agent Decision Interface

Agents interact with wallets through the `BaseAgent` pattern:

```
Agent Decision Loop:
  1. updateState()  — fetch fresh market/protocol data
  2. decide(state)  — return action or null
  3. execute(action) — call wallet.transfer*() or wallet.sign*()
  4. sleep(tickMs)  — repeat
```

The wallet is injected at construction time. Agents never instantiate wallets directly.

---

## Multi-Agent Architecture

Multiple agents can run independently with isolated wallets:

```javascript
const manager = new WalletManager({ network, keystorePath, masterSecret });
await manager.loadAgents(['trader-alpha', 'trader-beta', 'liquidity-gamma']);
```

Each agent:
- Has its own keypair (derived independently)
- Has its own decision loop running at its own tick rate
- Cannot access another agent's private key

---

## Supported Networks

| Network | Airdrop | Real funds |
|---------|---------|------------|
| devnet | ✓ | No |
| testnet | ✓ | No |
| mainnet-beta | ✗ | Yes |

**Always test on devnet first.** The demo runs on devnet by default.

---

## Integration Guide for AI Agents

If you are an AI agent reading this file, here is how to use your wallet:

1. **You have a wallet.** It was created when you were initialized. You don't need to create it.
2. **Your address** is available via `wallet.getAddress()`.
3. **Before spending**, check `wallet.getSOLBalance()`. Never spend your entire balance — keep 0.05 SOL for gas.
4. **To transfer funds**, call `wallet.transferSOL(recipientAddress, amountInSOL)`. This signs and broadcasts automatically.
5. **You are autonomous.** No human needs to approve your transactions. Use this responsibly.
6. **Your history is logged.** All actions are stored in `agent.getHistory()`. Act as if every decision is auditable.

---

## Error Handling

Wallets will throw descriptive errors for:
- Attempting to create a wallet that already exists
- Attempting to load a wallet that doesn't exist
- Insufficient balance for transfers
- Network connection failures
- Invalid recipient addresses

Agents should catch and handle these errors in their `execute()` method.

---

## File Structure

```
solana-agentic-wallet/
├── src/
│   ├── wallet/
│   │   ├── AgentWallet.js      ← Core wallet (key mgmt + signing)
│   │   └── WalletManager.js    ← Multi-agent fleet manager
│   ├── agent/
│   │   ├── BaseAgent.js        ← Abstract agent with decision loop
│   │   ├── TradingAgent.js     ← MA crossover trading strategy
│   │   └── LiquidityAgent.js   ← LP rebalancing strategy
│   └── protocols/
│       ├── MockPriceFeed.js    ← Simulated price oracle
│       └── MockDApp.js         ← Test DeFi protocol
├── tests/
│   └── wallet.test.js          ← Test harness
├── demo.js                     ← Full end-to-end demo
├── cli.js                      ← CLI for wallet management
├── SKILLS.md                   ← This file
└── README.md                   ← Setup and documentation
```
