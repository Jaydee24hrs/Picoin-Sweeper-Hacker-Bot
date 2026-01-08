require('dotenv').config();
const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const server = new StellarSdk.Server(
  process.env.PL_API_BASE_URL || 'https://api.mainnet.minepi.com',
  { allowHttp: false }
);

module.exports = {
  async getKeypair() {
    const mnemonic = process.env.YOUR_24_WORD_PHRASE;
    if (!mnemonic) throw new Error('Mnemonic missing in .env');

    const seed = bip39.mnemonicToSeedSync(mnemonic); // returns Buffer
    const { key } = derivePath("m/44'/148'/0'", seed); // pass Buffer directly
    return StellarSdk.Keypair.fromRawEd25519Seed(key); // ✅ correct function
  },

  async transferPi(amount, destination) {
    const keypair = await this.getKeypair();
    const account = await server.loadAccount(keypair.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: 'Pi Network',
      timebounds: await server.fetchTimebounds(60) // 10-minute window
    })
    .addOperation(StellarSdk.Operation.payment({
      destination,
      asset: StellarSdk.Asset.native(),
      amount: amount.toFixed(7) // Stellar requires up to 7 decimals
    }))
    .build();
 
    tx.sign(keypair);
    return server.submitTransaction(tx);
  }
};
