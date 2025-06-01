// src/solana/tokenInfo.js
const axios = require('axios');
const config = require('../config');

async function getTokenInfo(mintAddress) {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    const response = await axios.post(url, {
      jsonrpc: '2.0',
      id: '1',
      method: 'getAsset',
      params: {
        id: mintAddress,
        displayOptions: {
          showFungible: true
        }
      }
    });

    const result = response.data.result;

    if (!result || !result.content || !result.token_info) {
      console.error('Helius response missing expected fields:', response.data);
      return null;
    }

    const { content, token_info } = result;
    const { metadata, files } = content;
    const logo = files && files.length > 0 ? files[0].uri : null;

    return {
      name: metadata?.name || 'Unknown',
      symbol: metadata?.symbol || 'N/A',
      decimals: token_info?.decimals || 0,
      supply: token_info?.supply || 0,
      logo: logo
    };
  } catch (error) {
    console.error('Error fetching token info:', error.response?.data || error.message);
    return null;
  }
}

module.exports = getTokenInfo;
