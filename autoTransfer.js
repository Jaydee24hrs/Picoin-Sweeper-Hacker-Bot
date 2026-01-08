require('dotenv').config();
const axios = require('axios');
const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

// ========== CONSTANTS ==========
const PI_NETWORK_PASSPHRASE = "Pi Network";
const BASE_FEE = "100000"; // as string, 0.01 Pi in stroops
const TRANSFER_THRESHOLD = parseFloat(process.env.TRANSFER_THRESHOLD || "1"); // minimum Pi to transfer

// ========== DERIVE KEYPAIR ==========
function deriveStellarKeys() {
  const mnemonic = process.env.YOUR_24_WORD_PHRASE?.trim();
  if (!mnemonic) throw new Error('Missing mnemonic in .env: YOUR_24_WORD_PHRASE');
  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Try Pi-specific path first
  const paths = ["m/44'/314159'/0'", "m/44'/148'/0'"];

  for (const path of paths) {
    const { key } = derivePath(path, seed.toString('hex'));
    const secret = StellarSdk.StrKey.encodeEd25519SecretSeed(key);
    const keypair = StellarSdk.Keypair.fromSecret(secret);
    if (keypair.publicKey() === process.env.EXPECTED_SENDER_WALLET) {
      return keypair;
    }
  }

  throw new Error("No matching wallet address found from mnemonic and expected wallet.");
}

// ========== STELLAR SERVER ==========
const server = new StellarSdk.Server(process.env.PL_API_BASE_URL || 'https://api.mainnet.minepi.com');

// ========== GET BALANCE ==========
async function getAvailableBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey);
    const nativeBalance = account.balances.find(b => b.asset_type === 'native');
    if (!nativeBalance) throw new Error("No native Pi balance found");
    return parseFloat(nativeBalance.balance);
  } catch (err) {
    throw new Error(`Failed to fetch balance: ${err.response?.data?.detail || err.message}`);
  }
}

// ========== TRANSFER PI ==========
async function transferPi(amount, destination) {
  const keypair = deriveStellarKeys();
  const account = await server.loadAccount(keypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PI_NETWORK_PASSPHRASE,
    timebounds: await server.fetchTimebounds(300)
  })
    .addOperation(StellarSdk.Operation.payment({
      destination,
      asset: StellarSdk.Asset.native(),
      amount: amount.toFixed(7)
    }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);

  return server.submitTransaction(tx);
}

// ========== AUTO TRANSFER FUNCTION ==========
async function autoTransfer() {
  try {
    const keypair = deriveStellarKeys();
    const publicKey = keypair.publicKey();
    console.log(`🔑 Derived wallet address: ${publicKey}`);

    const balance = await getAvailableBalance(publicKey);
    console.log(`💰 Current available balance: ${balance} Pi`);

    if (balance < TRANSFER_THRESHOLD) {
      console.log(`⚠️ Balance below threshold (${TRANSFER_THRESHOLD} Pi). No transfer.`);
      return;
    }

    const destination = process.env.DESTINATION_WALLET;
    if (!destination) throw new Error("Missing DESTINATION_WALLET in .env");

    console.log(`🚀 Transferring ${balance} Pi to ${destination}...`);
    const result = await transferPi(balance, destination);
    console.log(`✅ Transfer successful! Transaction hash: ${result.hash}`);
  } catch (error) {
    console.error('❌ Error:', error.message || error);
  }
}

// ========== RUN AUTO TRANSFER PERIODICALLY ==========
(async () => {
  await autoTransfer(); // run immediately
  setInterval(autoTransfer, 10 * 60 * 1000); // run every 10 minutes
})();
