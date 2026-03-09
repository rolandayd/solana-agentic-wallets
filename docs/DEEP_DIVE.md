# Deep Dive: Agentic Wallet Design on Solana

## Why Agentic Wallets Are Different

A human wallet is built around a fundamental assumption: a person is present when a transaction is signed. Every UX decision — the approval modal, the hardware device, the browser prompt — exists because the human needs to authorize each action individually.

Agentic wallets flip this assumption entirely. The human is not present. The agent is. The wallet must be designed from the ground up for autonomous, continuous, unattended operation.

This changes everything about how you think about key storage, access control, transaction validation, and failure modes. A human who accidentally approves a bad transaction can contest it or write it off. An autonomous agent that enters a bug loop and drains its balance at 3am cannot be stopped until someone manually intervenes — unless the wallet itself has the right guardrails built in.

This deep dive covers three questions: how should agentic wallets store and manage keys, what security properties matter most in autonomous operation, and how should wallet and agent logic be separated to keep systems auditable and maintainable.

---

## Key Management Architecture

### The Core Problem

Autonomous agents need to sign transactions without human approval. That means the private key must be accessible to the software at runtime, without a hardware device, without a user prompt, and without a person present.

This is inherently more risky than hardware-wallet-based human signing. The key exists in software. That can't be fully avoided. The question is how to minimize the attack surface when it does.

### Solution: Layered Encryption with Per-Agent Key Derivation

This system uses a two-layer approach.

**Layer 1: Master secret** — A single high-entropy secret, injected via environment variable (`MASTER_SECRET`). This secret never touches disk. In production it comes from a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager). This is the system's single root of trust.

**Layer 2: Per-agent key derivation** — Each agent's encryption key is derived independently:

```
PBKDF2(masterSecret, sha256(agentId), 100000 iterations, SHA-256) → 256-bit key
```

The SHA-256 of the agentId acts as a salt. Two agents with the same master secret produce completely different encryption keys. This means:

- Compromise of one agent's keystore (by learning `agentId` + `masterSecret`) does not expose any other agent's keys
- An attacker who learns that agent `trader-alpha`'s keystore is at `./keystore/trader-alpha.keystore.json` cannot use that knowledge to derive agent `trader-beta`'s key
- Fleet-wide key exposure requires compromising the master secret — not individual keystore files

**Layer 3: AES-256-GCM per-keystore encryption** — The 64-byte Ed25519 secret key is encrypted with the derived key using AES-256-GCM. GCM mode provides authenticated encryption: any tampering with the ciphertext (or the IV, or the auth tag) causes decryption to fail with an authentication error. A tampered keystore cannot produce a valid keypair.

Each keystore file stores:
```json
{
  "version": 1,
  "agentId": "trader-alpha",
  "publicKey": "7xKZ...",
  "iv": "<random 16 bytes, hex>",
  "authTag": "<16 bytes, hex>",
  "encryptedKey": "<64 bytes encrypted, hex>",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

The IV is random per save, which prevents ciphertext analysis attacks. File permissions are `0o600` (owner read/write only) to reduce the attack surface on shared filesystems.

### What the Private Key Sees

The private key exists in memory (as a `Uint8Array`) only while the wallet is actively loaded and signing. It is:
- Never logged
- Never transmitted
- Never serialized to plaintext
- Cleared when the process exits

This is the best achievable security posture for a software wallet. The key must exist in memory to sign. It cannot be avoided. What can be avoided is unnecessary exposure.

### Upgrade Path for Production

For agents managing significant value, the software encryption approach should be upgraded to hardware-backed key security:

**AWS KMS** — The master secret is replaced with a KMS key ID. Decryption requires calling the KMS API, which is authenticated, logged, and can be rate-limited. Even if an attacker gains full read access to the server, they cannot decrypt agent keys without KMS API access.

**Hardware Security Modules (HSMs)** — The private key never leaves the HSM. Signing requests are sent to the HSM, which signs and returns the signature. The raw private key material is never accessible in software.

**Multi-signature** — For large positions, use Squads Protocol (Solana's leading multi-sig) to require M-of-N signatures. The agent's key is one signer. A cold hardware wallet held by the operator is a second signer required above a threshold amount. This caps the blast radius of any agent compromise.

---

## How It Interacts with AI Agents

### The Separation Principle

The most important design decision in this system is architectural: **agents never handle private keys**.

The agent receives an `AgentWallet` instance at construction time. It calls methods like `wallet.transferSOL()` and `wallet.signMessage()`. It never accesses `wallet.keypair.secretKey`. It doesn't need to. The wallet handles cryptography. The agent handles strategy.

```
Agent layer:  perceive → decide → request signing
Wallet layer: receive request → sign → broadcast
```

This separation has concrete consequences:

**Auditability.** You can audit agent decision logic without understanding cryptography. You can audit key management code without understanding trading strategy. They are independent modules with a clean interface between them.

**Replaceability.** You can swap trading strategies without touching key management. You can upgrade encryption without rewriting agent logic. Neither layer knows the internals of the other.

**Safety.** A bug in the agent's `decide()` method cannot cause it to leak a private key. The worst a buggy agent can do is sign bad transactions — which is still bad, but is a different class of risk than key exposure.

### The Decision Loop

`BaseAgent` implements a sense-plan-act loop:

1. **Sense** — `updateState()` fetches fresh market data, protocol state, and wallet balances from external sources. The agent builds a complete picture of the world as it currently is.

2. **Plan** — `decide(state)` analyzes the state and returns an action object or `null`. This is where all strategy logic lives. It can be as simple as a threshold check or as complex as an ML model's inference. The wallet doesn't care.

3. **Act** — `execute(action)` calls wallet methods to carry out the decided action. The wallet signs and broadcasts. `execute()` returns a result (transaction signature, confirmation, etc.) which is logged to `actionHistory`.

This pattern is deliberately simple. The sophistication lives in the agent's `decide()` method. The infrastructure is stable and predictable.

### Multiple Agents Running in Parallel

Each agent instance runs its own independent decision loop via `setTimeout`. Agents do not share state, do not coordinate, and do not block each other. A slow network response for agent A does not delay agent B's next tick.

```
trader-alpha:   ──tick──────tick──────tick──────tick──
trader-beta:    ────tick──────────tick──────────tick──
liquidity-gamma:──────────tick────────────────tick───
```

Tick intervals are configurable per agent. In the demo:
- Trading agents tick every 5-7 seconds (reactive to price changes)
- Liquidity agents tick every 12 seconds (responding to slower-moving pool ratios)

The `WalletManager` provides a fleet view: create, load, fund, and query all agents from a single object. `getPortfolioSummary()` aggregates balances across all agents into a single snapshot.

---

## Protocol Integration

### Current Architecture (Devnet Demo)

The demo uses `MockPriceFeed` and `MockDApp` to avoid requiring external protocol dependencies for the prototype. This is intentional: it allows the wallet and agent architecture to be validated without network dependencies or real capital at risk.

`MockPriceFeed` implements Geometric Brownian Motion:
```
price(t+1) = price(t) * (1 + drift + volatility * N(0,1))
```

This produces realistic price behavior — trending, volatile, capable of generating both buy and sell signals. It's the same model used in financial simulations and options pricing.

`MockDApp` simulates a counterparty: accepts deposits, tracks balances, processes swap requests. It's the minimal viable protocol for demonstrating agent-wallet-protocol interaction without requiring a live DEX.

### Production Integration Path

The wallet layer doesn't change for production. Only the protocol layer changes.

**Price feeds:** Replace `MockPriceFeed.getPrice()` with a Pyth Network or Switchboard oracle call. These are on-chain price accounts updated by a network of data providers. The agent's `updateState()` method fetches the latest price from the oracle account.

**DEX interaction:** Replace `MockDApp.simulateSwap()` with a Jupiter aggregator instruction. Jupiter finds the optimal route across all Solana DEXes, constructs the swap transaction, and returns it. The wallet signs it. The agent doesn't need to know which DEX was used.

**Lending protocols:** An agent managing a lending position would call Solend or MarginFi SDK methods in `execute()`, then pass the resulting transaction to `wallet.signTransaction()`.

The pattern is always the same: protocol SDK constructs the transaction, wallet signs it, agent decides when.

---

## Scalability

### Horizontal Scaling

Each agent and its wallet are stateless between runs (state is in the keystore file and on-chain). This means agents can be distributed across processes or machines:

- Keystore directory on shared storage (NFS, S3 with local cache)
- Master secret in a shared secrets manager
- Multiple processes each running a subset of agents

For very large fleets (100+ agents), consider moving from file-based keystores to an encrypted database (PostgreSQL with `pgcrypto`, or a purpose-built KMS).

### Independent Failure

Because agents are isolated, failure of one agent does not cascade. If `trader-alpha` encounters an RPC error and its tick fails, `trader-beta` and `liquidity-gamma` continue operating. The error is emitted as an event and logged — operators can build alerting on top of the event stream without modifying agent logic.

### Observability

The event-driven design (`BaseAgent extends EventEmitter`) means you can attach observers without modifying agent code:

```javascript
agent.on('action', logToDatabase);
agent.on('action', sendToTelegram);
agent.on('error', triggerAlert);
agent.on('tick', updateDashboard);
```

This is how you build real-time dashboards, alerts, and audit trails on top of autonomous agents without coupling them to any specific monitoring infrastructure.

---

## Summary

Agentic wallets require different thinking than human wallets. The human is not present. The software must handle everything the human normally handles: custody, authorization, and operational continuity.

The architecture presented here addresses this through three design decisions:

**Layered encryption with per-agent key derivation** — keys are encrypted at rest using AES-256-GCM, derived independently per agent, with the master secret as the only system-wide secret. Compromise of one agent does not expose others.

**Strict separation of agent logic and wallet logic** — agents never access private keys. They call wallet methods. This makes both layers independently auditable and replaceable.

**Event-driven autonomous loops** — agents operate independently, emit observable events, and can be monitored and composed without modification.

The result is a system where AI agents can sign transactions, hold funds, and interact with Solana protocols continuously and autonomously, with the security model clearly defined and the attack surface understood.

---

## Technical Walkthrough: The Four Core Requirements

This section walks through each bounty requirement and shows exactly how the system fulfills it with the specific code that does the work.

### 1. Create a Wallet Programmatically

Wallet creation happens in AgentWallet.create(). It generates a fresh Ed25519 keypair, encrypts the private key, and writes it to disk — all without any human input.

The create() method calls Keypair.generate() from @solana/web3.js, then immediately passes the keypair to _saveKeypair() which runs the full AES-256-GCM encryption pipeline. The private key never exists on disk in plaintext — the encryption happens in memory before the first byte is written.

The derivation formula:
  PBKDF2(masterSecret, sha256(agentId), 100000 iterations, SHA-256) → 256-bit key → AES-256-GCM(secretKey)

Each agent's derived key is mathematically independent. trader-alpha and trader-beta share the same masterSecret but produce completely different encryption keys because their agentIds produce different SHA-256 salts.

When the demo runs, WalletManager.loadAgents() calls initialize() for each agent in parallel. Three wallets. Three independent keypairs. Three encrypted keystore files. No human involved at any step.

The keystore file on disk looks like this:
  { version, agentId, publicKey, iv, authTag, encryptedKey, createdAt }

The iv is random per-save (prevents ciphertext analysis). The authTag is GCM's integrity guarantee — tamper with any byte and decryption fails. The encryptedKey is the 64-byte Ed25519 secret key, encrypted. File permissions are 0o600 (owner read/write only).

---

### 2. Sign Transactions Automatically

Autonomous signing happens in AgentWallet.transferSOL(). A Solana SystemProgram.transfer instruction is constructed, signed by this.keypair, and broadcast — with no human confirmation at any point.

The agent calls this from its execute() method whenever decide() returns a BUY action. The decision loop runs on a timer: every 5 seconds for trader-alpha, every 7 seconds for trader-beta. When the short moving average crosses above the long moving average, a BUY fires. The wallet signs immediately.

The system also exposes signTransaction() for pre-signing without broadcasting (useful for multi-sig flows) and signMessage() for off-chain identity proofs — both fully autonomous, both requiring only the loaded keypair.

The key point: the agent never calls this.keypair.secretKey directly. It calls this.wallet.transferSOL(). The private key is inside the wallet object. The agent has no path to it. This is the boundary that matters.

---

### 3. Hold SOL or SPL Tokens

Every agent wallet is a standard Solana account. It holds SOL natively and any SPL token via Associated Token Accounts.

In the live demo, trader-alpha received 1 SOL via devnet airdrop:
  Address: 5Uw2FNJJNrHuZSdaHFjzqSsyDDL3JeZVxN5MJjc7Xmqb
  Balance: 1.0 SOL
  Network: Devnet

Verify at explorer.solana.com — switch to Devnet and paste the address.

The getSPLBalance(mintAddress) method automatically creates an Associated Token Account for the agent if one doesn't exist yet, paying the rent from the agent's SOL balance. The agent manages this entirely without human input.

WalletManager.getPortfolioSummary() aggregates balances across all agents into a single snapshot — totalAgents, totalSOL, and per-agent breakdown — giving operators a fleet-wide view at any moment.

---

### 4. Interact with a Test dApp or Protocol

The system interacts with two test protocol components that together simulate a complete DeFi interaction loop.

MockPriceFeed generates realistic price movement using Geometric Brownian Motion — the same model used in financial simulations and options pricing. Each tick produces a new price. The TradingAgent builds a rolling price history and computes short and long moving averages from it.

MockDApp simulates a DeFi protocol counterparty. It accepts SOL deposits from agents, tracks per-agent balances, and processes swap requests. When an agent sends SOL to the dApp address via wallet.transferSOL(), the dApp records the deposit and returns simulated tokens at a configured rate.

The full autonomous interaction loop, running every 5 seconds without human input:

  Step 1 — updateState(): fetch price from MockPriceFeed, compute moving averages, determine signal (BUY / SELL / HOLD)
  Step 2 — decide(state): if short MA crossed above long MA, return BUY action
  Step 3 — execute(BUY): call wallet.transferSOL(dapp.address, 0.01), dApp records deposit and processes swap
  Step 4 — log: action, result, signature, price, and timestamp written to actionHistory

Every action is logged. The full audit trail of every decision and every outcome is available in agent.getHistory() at any point during or after the demo run. This is what makes autonomous agent behavior inspectable — not just runnable.

