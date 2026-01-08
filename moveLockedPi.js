require('dotenv').config();
const axios = require('axios');

const API_BASE_URL = process.env.PL_API_BASE_URL || 'https://api.mainnet.minepi.com/v2';
const ACCESS_TOKEN = process.env.PL_ACCESS_TOKEN;
const PUBLIC_KEY = process.env.EXPECTED_SENDER_WALLET;

async function getLockups(publicKey) {
  try {
    const res = await axios.get(`${API_BASE_URL}/accounts/${publicKey}/lockups`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    return res.data.lockups || [];
  } catch (err) {
    console.error('Error fetching lockups:', err.response?.data || err.message);
    return [];
  }
}

async function moveLockup(lockupId) {
  try {
    const res = await axios.post(`${API_BASE_URL}/lockups/${lockupId}/move`, {}, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    console.log(`Moved locked Pi from lockup ${lockupId}:`, res.data);
  } catch (err) {
    console.error(`Error moving lockup ${lockupId}:`, err.response?.data || err.message);
  }
}

async function unlockAvailableFunds() {
  const lockups = await getLockups(PUBLIC_KEY);
  if (!lockups.length) {
    console.log('No lockups found.');
    return;
  }

  const now = new Date();

  for (const lockup of lockups) {
    const unlockDate = new Date(lockup.unlock_date);
    if (unlockDate <= now) {
      console.log(`Lockup ${lockup.id} is unlockable (unlock_date: ${lockup.unlock_date}), moving funds...`);
      await moveLockup(lockup.id);
    } else {
      console.log(`Lockup ${lockup.id} not unlockable yet (unlock_date: ${lockup.unlock_date})`);
    }
  }
}

unlockAvailableFunds();
