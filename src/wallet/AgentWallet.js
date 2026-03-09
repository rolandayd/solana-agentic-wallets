/**
 * AgentWallet.js
 * 
 * Core agentic wallet implementation for autonomous AI agents on Solana.
 * Handles: key generation, secure storage, transaction signing, balance queries.
 * 
 * Design principle: The wallet is a dumb signing layer.
 * It knows nothing about strategy. It only knows cryptography.
 * Agent logic lives elsewhere. This separation is intentional and security-critical.
 */

const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  clusterApiUrl,
} = require('@solana/web3.js');

const {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_DERIVATION_ITERATIONS = 100000;
const KEY_LENGTH = 32;

class AgentWallet {
  /**
   * @param {Object} config
   * @param {string} config.agentId       - Unique identifier for this agent
   * @param {string} config.keystorePath  - Directory for encrypted key storage
   * @param {string} config.network       - 'devnet' | 'testnet' | 'mainnet-beta'
   * @param {string} config.masterSecret  - Master secret for key derivation (env-provided)
   */
  constructor(config) {
    this.agentId = config.agentId;
    this.keystorePath = config.keystorePath || './keystore';
    this.network = config.network || 'devnet';
    this.masterSecret = config.masterSecret;
    this.keypair = null;
    this.connection = null;

    // Ensure keystore directory exists with restricted permissions
    if (!fs.existsSync(this.keystorePath)) {
      fs.mkdirSync(this.keystorePath, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Initialize connection to Solana network
   */
  async connect() {
    const endpoint = this.network === 'mainnet-beta'
      ? process.env.RPC_ENDPOINT || clusterApiUrl('mainnet-beta')
      : clusterApiUrl(this.network);

    this.connection = new Connection(endpoint, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });

    const version = await this.connection.getVersion();
    console.log(`[AgentWallet:${this.agentId}] Connected to ${this.network} (solana-core ${version['solana-core']})`);
    return this;
  }

  /**
   * Create a new wallet for this agent.
   * Generates a fresh Ed25519 keypair and stores it encrypted.
   * 
   * @returns {string} Public key address
   */
  async create() {
    if (await this._keystoreExists()) {
      throw new Error(`Wallet for agent '${this.agentId}' already exists. Use load() instead.`);
    }

    this.keypair = Keypair.generate();
    await this._saveKeypair(this.keypair);

    console.log(`[AgentWallet:${this.agentId}] Created wallet: ${this.keypair.publicKey.toBase58()}`);
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Load an existing wallet from encrypted keystore.
   */
  async load() {
    if (!await this._keystoreExists()) {
      throw new Error(`No wallet found for agent '${this.agentId}'. Use create() first.`);
    }

    this.keypair = await this._loadKeypair();
    console.log(`[AgentWallet:${this.agentId}] Loaded wallet: ${this.keypair.publicKey.toBase58()}`);
    return this;
  }

  /**
   * Create or load — idempotent initialization.
   */
  async initialize() {
    if (await this._keystoreExists()) {
      return this.load();
    } else {
      await this.create();
      return this;
    }
  }

  /**
   * Get the public key address string.
   */
  getAddress() {
    this._requireKeypair();
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Get the public key object.
   */
  getPublicKey() {
    this._requireKeypair();
    return this.keypair.publicKey;
  }

  /**
   * Request an airdrop of SOL (devnet/testnet only).
   * 
   * @param {number} amount - Amount in SOL
   */
  async requestAirdrop(amount = 1) {
    this._requireKeypair();
    this._requireConnection();

    if (this.network === 'mainnet-beta') {
      throw new Error('Airdrops are not available on mainnet.');
    }

    const lamports = amount * LAMPORTS_PER_SOL;
    console.log(`[AgentWallet:${this.agentId}] Requesting ${amount} SOL airdrop...`);

    const signature = await this.connection.requestAirdrop(
      this.keypair.publicKey,
      lamports
    );

    await this.connection.confirmTransaction(signature, 'confirmed');
    console.log(`[AgentWallet:${this.agentId}] Airdrop confirmed: ${signature}`);
    return signature;
  }

  /**
   * Get SOL balance in SOL (not lamports).
   */
  async getSOLBalance() {
    this._requireKeypair();
    this._requireConnection();

    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Get SPL token balance for a given mint.
   * 
   * @param {string} mintAddress - SPL token mint address
   */
  async getSPLBalance(mintAddress) {
    this._requireKeypair();
    this._requireConnection();

    try {
      const mint = new PublicKey(mintAddress);
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.keypair,
        mint,
        this.keypair.publicKey
      );

      const accountInfo = await getAccount(this.connection, tokenAccount.address);
      return Number(accountInfo.amount);
    } catch (err) {
      if (err.name === 'TokenAccountNotFoundError') return 0;
      throw err;
    }
  }

  /**
   * Transfer SOL to another address.
   * This is the core autonomous signing operation.
   * 
   * @param {string} toAddress  - Recipient public key
   * @param {number} amount     - Amount in SOL
   * @returns {string}          - Transaction signature
   */
  async transferSOL(toAddress, amount) {
    this._requireKeypair();
    this._requireConnection();

    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey,
        lamports,
      })
    );

    // Autonomous signing — no human in the loop
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.keypair],
      { commitment: 'confirmed' }
    );

    console.log(`[AgentWallet:${this.agentId}] Transferred ${amount} SOL to ${toAddress}: ${signature}`);
    return signature;
  }

  /**
   * Transfer SPL tokens to another address.
   * 
   * @param {string} mintAddress  - Token mint
   * @param {string} toAddress    - Recipient
   * @param {number} amount       - Amount in token base units
   */
  async transferSPL(mintAddress, toAddress, amount) {
    this._requireKeypair();
    this._requireConnection();

    const mint = new PublicKey(mintAddress);
    const toPublicKey = new PublicKey(toAddress);

    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair,
      mint,
      this.keypair.publicKey
    );

    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair,
      mint,
      toPublicKey
    );

    const transaction = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        this.keypair.publicKey,
        BigInt(amount)
      )
    );

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.keypair],
      { commitment: 'confirmed' }
    );

    console.log(`[AgentWallet:${this.agentId}] Transferred ${amount} tokens to ${toAddress}: ${signature}`);
    return signature;
  }

  /**
   * Sign an arbitrary transaction without broadcasting.
   * Used for multi-sig flows and pre-signed transactions.
   * 
   * @param {Transaction} transaction
   * @returns {Transaction} Signed transaction
   */
  async signTransaction(transaction) {
    this._requireKeypair();
    this._requireConnection();

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.keypair.publicKey;
    transaction.sign(this.keypair);

    return transaction;
  }

  /**
   * Sign arbitrary data (for off-chain verification of agent identity).
   * 
   * @param {Buffer|Uint8Array} data
   * @returns {Uint8Array} Signature
   */
  signMessage(data) {
    this._requireKeypair();
    const nacl = require('tweetnacl');
    return nacl.sign.detached(data, this.keypair.secretKey);
  }

  /**
   * Get wallet status summary.
   */
  async getStatus() {
    const solBalance = await this.getSOLBalance();
    return {
      agentId: this.agentId,
      address: this.getAddress(),
      network: this.network,
      solBalance,
      isActive: true,
    };
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Encrypt and save keypair to disk.
   * Uses AES-256-GCM with a key derived from the master secret + agentId.
   * 
   * Security model:
   * - The secret key never touches disk unencrypted
   * - Each agent's key is derived separately (compromise of one ≠ compromise of all)
   * - IV is random per-save (prevents ciphertext analysis)
   */
  async _saveKeypair(keypair) {
    const keystoreFile = this._getKeystorePath();
    const derivedKey = this._deriveEncryptionKey();

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);

    const secretKeyBuffer = Buffer.from(keypair.secretKey);
    const encrypted = Buffer.concat([
      cipher.update(secretKeyBuffer),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    const keystoreData = {
      version: 1,
      agentId: this.agentId,
      publicKey: keypair.publicKey.toBase58(),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encryptedKey: encrypted.toString('hex'),
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(keystoreFile, JSON.stringify(keystoreData, null, 2), { mode: 0o600 });
  }

  /**
   * Load and decrypt keypair from disk.
   */
  async _loadKeypair() {
    const keystoreFile = this._getKeystorePath();
    const keystoreData = JSON.parse(fs.readFileSync(keystoreFile, 'utf8'));

    const derivedKey = this._deriveEncryptionKey();
    const iv = Buffer.from(keystoreData.iv, 'hex');
    const authTag = Buffer.from(keystoreData.authTag, 'hex');
    const encryptedKey = Buffer.from(keystoreData.encryptedKey, 'hex');

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encryptedKey),
      decipher.final()
    ]);

    return Keypair.fromSecretKey(new Uint8Array(decrypted));
  }

  /**
   * Derive a 256-bit encryption key from master secret + agentId.
   * Each agent gets a unique derived key.
   */
  _deriveEncryptionKey() {
    const salt = crypto.createHash('sha256').update(this.agentId).digest();
    return crypto.pbkdf2Sync(
      this.masterSecret,
      salt,
      KEY_DERIVATION_ITERATIONS,
      KEY_LENGTH,
      'sha256'
    );
  }

  _getKeystorePath() {
    return path.join(this.keystorePath, `${this.agentId}.keystore.json`);
  }

  async _keystoreExists() {
    return fs.existsSync(this._getKeystorePath());
  }

  _requireKeypair() {
    if (!this.keypair) throw new Error('Wallet not initialized. Call create() or load() first.');
  }

  _requireConnection() {
    if (!this.connection) throw new Error('Not connected. Call connect() first.');
  }
}

module.exports = AgentWallet;
