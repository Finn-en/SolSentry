// SolSentry Backend Feature: On-Chain Heuristics (Security Checks)
// This module implements security checks for Solana tokens based on the provided research.
// It uses free public APIs from Solscan and DEXScreener, along with @solana/web3.js for on-chain queries.
// For advanced features like full rug checks, consider integrating paid APIs (e.g., SolSniffer, Birdeye with API key).
// Note: This is a basic implementation. In a production app, handle errors, rate limits, and caching.
// Install dependencies: npm install @solana/web3.js @solana/spl-token axios

const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint, getTokenLargestAccounts } = require('@solana/spl-token');
const axios = require('axios');

// Solana mainnet RPC (use your own for better performance, e.g., Helius or QuickNode)
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Helper function to fetch token metadata from Solscan (public API, rate-limited)
async function getTokenMeta(tokenAddress) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/meta?address=${tokenAddress}`);
    return response.data.data || null;
  } catch (error) {
    console.error('Error fetching Solscan token meta:', error.message);
    return null;
  }
}

// Helper function to fetch top holders from Solscan (public API)
async function getTopHolders(tokenAddress, limit = 10) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/holders?address=${tokenAddress}&page=1&page_size=${limit}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching Solscan holders:', error.message);
    return [];
  }
}

// Helper function to fetch pairs from DEXScreener (public API, rate-limited)
async function getDexPairs(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    return response.data.pairs || [];
  } catch (error) {
    console.error('Error fetching DEXScreener pairs:', error.message);
    return [];
  }
}

// Helper function to fetch recent transactions from Solscan (for pattern analysis)
async function getRecentTransactions(tokenAddress, limit = 20) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/txns?address=${tokenAddress}&limit=${limit}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching Solscan transactions:', error.message);
    return [];
  }
}

// Main function to perform security checks on a token
async function performSecurityChecks(tokenAddress) {
  const report = {
    authorities: {},
    adminKeys: {},
    lpHealth: {},
    tokenDistribution: {},
    transactionPatterns: {},
    riskScore: 0, // Simple score: 0-100 (higher = riskier)
    flags: [] // Red flags
  };

  // 1. Mint/Freeze/Upgrade Authorities (using on-chain data for accuracy)
  try {
    const tokenMint = new PublicKey(tokenAddress);
    const mintInfo = await getMint(connection, tokenMint);
    report.authorities = {
      mintAuthority: mintInfo.mintAuthority ? 'Active (Risk: Can mint more tokens)' : 'Renounced (Safe)',
      freezeAuthority: mintInfo.freezeAuthority ? 'Active (Risk: Can freeze tokens)' : 'Renounced (Safe)',
      // Upgrade authority not applicable for standard SPL tokens; for programs, use separate check if needed
    };
    if (mintInfo.mintAuthority) {
      report.flags.push('Mint authority active');
      report.riskScore += 30;
    }
    if (mintInfo.freezeAuthority) {
      report.flags.push('Freeze authority active');
      report.riskScore += 20;
    }
  } catch (error) {
    report.authorities.error = 'Failed to fetch on-chain mint info';
  }

  // 2. Admin/Owner Keys (using Solscan meta for creator/owner info)
  const tokenMeta = await getTokenMeta(tokenAddress);
  if (tokenMeta) {
    report.adminKeys = {
      creator: tokenMeta.creator ? `${tokenMeta.creator.address} (${tokenMeta.creator.share}% share)` : 'Unknown',
      // For admin rights, infer from authorities (as SPL doesn't have separate owner unless custom)
      note: 'Check if creator wallet has multisig or renounced control (manual review recommended)'
    };
    // Heuristic: If creator holds significant share, flag
    if (tokenMeta.creator && tokenMeta.creator.share > 10) {
      report.flags.push('Creator holds >10% share');
      report.riskScore += 15;
    }
  } else {
    report.adminKeys.error = 'Failed to fetch token meta';
  }

  // 3. Liquidity Pool (LP) Health (using DEXScreener for pairs and liquidity)
  const pairs = await getDexPairs(tokenAddress);
  if (pairs.length > 0) {
    // Select the pair with highest liquidity (assume main SOL pair)
    const mainPair = pairs.reduce((prev, curr) => (curr.liquidity?.usd > prev.liquidity?.usd ? curr : prev), pairs[0]);
    report.lpHealth = {
      dex: mainPair.dexId,
      liquidityUSD: mainPair.liquidity?.usd || 0,
      volume24h: mainPair.volume?.h24 || 0,
      pairAddress: mainPair.pairAddress,
      note: 'LP lock status: Use manual check on Solscan for LP mint supply/burns (advanced: integrate SolSniffer API)'
    };
    // Heuristics from research
    if (report.lpHealth.liquidityUSD < 20000) {
      report.flags.push('Tiny LP (<$20k)');
      report.riskScore += 25;
    }
    // For lock status, approximate by checking if mint authority renounced (prevents new mints affecting LP)
    if (report.authorities.mintAuthority.includes('Active')) {
      report.flags.push('Potential LP risk due to active mint');
      report.riskScore += 10;
    }
  } else {
    report.lpHealth.error = 'No DEX pairs found';
    report.flags.push('No liquidity pools detected');
    report.riskScore += 30;
  }

  // 4. Token Distribution (top holders concentration)
  const topHolders = await getTopHolders(tokenAddress);
  if (topHolders.length > 0) {
    const totalSupply = BigInt(tokenMeta?.supply || 0); // From meta
    let top10Percent = 0;
    topHolders.forEach(holder => {
      const balance = BigInt(holder.amount);
      top10Percent += Number((balance * 100n) / totalSupply);
    });
    report.tokenDistribution = {
      top10HoldersPercent: top10Percent,
      holderCount: tokenMeta?.holder || 'Unknown'
    };
    if (top10Percent > 50) {
      report.flags.push('High concentration (>50% in top 10)');
      report.riskScore += 25;
    } else if (top10Percent > 20) {
      report.flags.push('Moderate concentration (>20% in top 10)');
      report.riskScore += 10;
    }
  } else {
    report.tokenDistribution.error = 'Failed to fetch holders';
  }

  // 5. Transaction Patterns (basic analysis of recent tx)
  const recentTx = await getRecentTransactions(tokenAddress);
  if (recentTx.length > 0) {
    // Simple heuristics: count buys/sells, look for large dumps
    let sellCount = 0, largeDumps = 0;
    recentTx.forEach(tx => {
      if (tx.type === 'transfer' && tx.amount > 1000000) { // Arbitrary threshold for "large"
        // Assume sell if to DEX or unknown (simplified; real analysis needs more context)
        sellCount++;
        if (tx.amount > 10000000) largeDumps++;
      }
    });
    report.transactionPatterns = {
      recentTxCount: recentTx.length,
      potentialDumps: largeDumps,
      note: 'Advanced: Analyze for bot patterns or unnatural spikes (integrate Birdeye API for volume trends)'
    };
    if (largeDumps > 2) {
      report.flags.push('Recent large dumps detected');
      report.riskScore += 20;
    }
  } else {
    report.transactionPatterns.error = 'Failed to fetch transactions';
  }

  // Cap risk score at 100
  report.riskScore = Math.min(report.riskScore, 100);

  // Additional integrations (commented): For full features, add API keys
  // e.g., SolSniffer: Requires signup at solsniffer.com/api-service
  // const solSnifferResponse = await axios.get(`https://api.solsniffer.com/scan?token=${tokenAddress}`, { headers: { 'Authorization': 'YOUR_API_KEY' } });
  // Birdeye: Requires key from birdeye.so
  // const birdeyeResponse = await axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`, { headers: { 'X-API-KEY': 'YOUR_KEY' } });

  return report;
}

// Example usage (run with node)
(async () => {
  const tokenAddress = 'Pumpui3xvBFpX4vvVBy42SYLiR8Kwg8tr6V3TaBQM7b'; // Example: Replace with real token mint
  const report = await performSecurityChecks(tokenAddress);
  console.log(JSON.stringify(report, null, 2));
})();