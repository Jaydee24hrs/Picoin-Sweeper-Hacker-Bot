// Load environment variables from .env file
require('dotenv').config();

const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

// =================================================================
// --- CONFIGURATION & CONSTANTS ---
// =================================================================

const SENDER_MNEMONIC = process.env.YOUR_24_WORD_PHRASE;
const EXPECTED_SENDER_WALLET = process.env.EXPECTED_SENDER_WALLET;
const RECIPIENT_WALLET_ADDRESS = process.env.RECIPIENT_WALLET_ADDRESS;

const SPAM_ATTEMPTS = 9;
const POLLING_DURATION_SECONDS = 500;
const PRIORITY_FEE_MULTIPLIER = parseInt(process.env.PRIORITY_FEE_MULTIPLIER || '10', 10);
const MINIMUM_RESERVE_PI = 1;

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_SERVER_URL = 'https://api.mainnet.minepi.com';
const server = new StellarSdk.Server(PI_SERVER_URL, { allowHttp: PI_SERVER_URL.startsWith('http://') });
const BASE_FEE_STROOPS = "100000"; // 0.01 Pi

// =================================================================
// --- LOGGER ---
// =================================================================

const logger = (level, message, data = '') => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    if (level === 'error' || level === 'fatal') {
        console.error(logMessage, data || '');
    } else {
        console.log(logMessage, data || '');
    }
};

// =================================================================
// --- CORE FUNCTIONS ---
// =================================================================

async function initialize() {
    logger('info', '--- Bot Initializing ---');

    const requiredVars = ['YOUR_24_WORD_PHRASE', 'EXPECTED_SENDER_WALLET', 'RECIPIENT_WALLET_ADDRESS'];
    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
        throw new Error(`Missing required env variables: ${missing.join(', ')}`);
    }

    logger('info', 'Deriving and validating keys from mnemonic...');
    const seed = await bip39.mnemonicToSeed(SENDER_MNEMONIC);
    const path = "m/44'/314159'/0'";
    const { key } = derivePath(path, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);

    if (keypair.publicKey() !== EXPECTED_SENDER_WALLET) {
        throw new Error(`Key mismatch! The derived public key does not match EXPECTED_SENDER_WALLET.`);
    }

    logger('success', `Keys validated for wallet: ${keypair.publicKey()}`);
    logger('info', 'Pre-fetching account details from the network...');
    const account = await server.loadAccount(keypair.publicKey());

    const nativeBalance = account.balances.find(b => b.asset_type === 'native');
    logger('info', `Current wallet balance: ${nativeBalance?.balance || 'Unknown'} Pi`);
    logger('info', `Current account sequence: ${account.sequence}`);

    return { keypair, account };
}

async function startPollingAttack(keypair, account, retryEndTime = null) {
    logger('danger', '!!! POLLING ATTACK INITIATED !!!');
    const publicKey = keypair.publicKey();
    const pollingEndTime = retryEndTime || (Date.now() + POLLING_DURATION_SECONDS * 1000);
    let attackLaunched = false;

    const poll = async () => {
        if (Date.now() > pollingEndTime || attackLaunched) {
            if (!attackLaunched) {
                logger('error', 'Polling finished, but no claimable balance was found. The bot will stop.');
            }
            return;
        }
        try {
            const claimableBalances = await server.claimableBalances().claimant(publicKey).limit(5).call();
            const record = claimableBalances.records.find(b => b.asset === 'XLM' || b.asset === 'native');

            if (record && !attackLaunched) {
                attackLaunched = true;
                logger('success', `Found claimable balance! ID: ${record.id}, Amount: ${record.amount} Pi`);
                await launchSpamBurst(keypair, account, record);
            } else {
                setTimeout(poll, 500);
            }
        } catch (error) {
            logger('error', 'Error during polling, re-polling...', error.message);
            setTimeout(poll, 200);
        }
    };

    poll();
}

// =================================================================
// --- Delay & Retry Logic ---node
// =================================================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function submitWithBackoff(tx, attemptNumber, keypair, account, claimableBalanceRecord, retriedForCantClaimRef) {
    let retries = 0;
    while (retries < 5) {
        try {
            const result = await server.submitTransaction(tx);
            if (result.hash) {
                logger('success', `✅✅✅ TRANSACTION CONFIRMED ON-CHAIN! ATTEMPT #${attemptNumber} SUCCEEDED ✅✅✅`, { hash: result.hash });
            }
            return true;
        } catch (error) {
            const status = error .response?.status;
            const extras = error.response?.data?.extras;

            if (status === 429) {
                const waitMs = Math.pow(2, retries) * 1000;
                logger('warn', `⏳ 429 Too Many Requests. Retrying attempt #${attemptNumber} in ${waitMs}ms...`);
                await delay(waitMs);
                retries++;
                continue;
            }

            if (extras) {
                const txResultCode = extras.result_codes?.transaction;
                const opResultCodes = extras.result_codes?.operations;

                if (txResultCode === 'tx_bad_seq') {
                    logger('warn', `Attempt #${attemptNumber} failed with expected 'tx_bad_seq'. This is normal.`);
                } else if (txResultCode === 'tx_failed') {
                    if (opResultCodes?.includes('op_cant_claim')) {
                        logger('error', `Attempt #${attemptNumber} FAILED: Balance not claimable yet (op_cant_claim). Retrying polling for 140s more...`);
                        if (!retriedForCantClaimRef.value) {
                            retriedForCantClaimRef.value = true;
                            await startPollingAttack(keypair, account, Date.now() + 140000);
                        }
                    } else if (opResultCodes?.includes('op_underfunded')) {
                        logger('error', `Attempt #${attemptNumber} FAILED: Payment failed due to insufficient funds.`);
                    } else {
                        logger('error', `Attempt #${attemptNumber} FAILED with tx_failed. Codes: ${opResultCodes}`);
                    }
                } else {
                    logger('error', `Attempt #${attemptNumber} failed with unexpected transaction result: ${txResultCode}`);
                }
            } else {
                logger('error', `Attempt #${attemptNumber} failed with a network or submission error`, { message: error.message });
            }
            return false;
        }
    }
    logger('error', `Attempt #${attemptNumber} failed after multiple 429 retries.`);
    return false;
}

// =================================================================
// --- Spam Burst Logic ---
// =================================================================

async function launchSpamBurst(keypair, account, claimableBalanceRecord) {
    logger('danger', '--- Launching Spam Burst ---');
    const startSequence = account.sequence;
    const priorityFeeStroops = (parseInt(BASE_FEE_STROOPS) * PRIORITY_FEE_MULTIPLIER).toString();
    const transactionFeePi = (parseInt(priorityFeeStroops, 10) / 10000000) * 2;
    const balanceToClaim = parseFloat(claimableBalanceRecord.amount);
    const amountToSend = (balanceToClaim - MINIMUM_RESERVE_PI - transactionFeePi).toFixed(7);

    if (parseFloat(amountToSend) <= 0) {
        logger('error', `Claimable amount (${balanceToClaim} Pi) is too low to cover the reserve and fee. Aborting.`);
        return;
    }

    logger('info', `Preparing to claim ${balanceToClaim} Pi and send ${amountToSend} Pi.`);
    logger('info', `Using a priority fee of ${priorityFeeStroops} stroops (${PRIORITY_FEE_MULTIPLIER}x base fee).`);

    const promises = [];
    const retriedForCantClaimRef = { value: false };

    for (let i = 0; i < SPAM_ATTEMPTS; i++) {
        const currentSequence = (BigInt(startSequence) + BigInt(i)).toString();
        const tempAccount = new StellarSdk.Account(keypair.publicKey(), currentSequence);

        const tx = new StellarSdk.TransactionBuilder(tempAccount, {
                fee: priorityFeeStroops,
                networkPassphrase: PI_NETWORK_PASSPHRASE,
            })
            .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableBalanceRecord.id }))
            .addOperation(StellarSdk.Operation.payment({
                destination: RECIPIENT_WALLET_ADDRESS,
                asset: StellarSdk.Asset.native(),
                amount: amountToSend.toString(),
            }))
            .setTimeout(20)
            .build();

        tx.sign(keypair);
        const promise = submitWithBackoff(tx, i + 1, keypair, account, claimableBalanceRecord, retriedForCantClaimRef);
        promises.push(promise);
    }

    const results = await Promise.allSettled(promises);
    const success = results.some(r => r.status === 'fulfilled' && r.value === true);

    logger('info', '--- Spam Burst Finished ---');
    if (!success) {
        logger('fatal', 'ATTACK FAILED: Check error logs above for specific reasons.');
    }
}

// =================================================================
// --- Main Entry Point ---
// =================================================================

async function main() {
    try {
        const { keypair, account } = await initialize();
        await startPollingAttack(keypair, account);
    } catch (error) {
        logger('fatal', 'Bot failed during execution.', { message: error.message });
        process.exit(1);
    }
}

// --- Run the bot ---
main();
