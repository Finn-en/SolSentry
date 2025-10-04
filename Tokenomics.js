// SolSentry Backend Feature: Tokenomics Analysis
// This module implements tokenomics analysis for Solana tokens based on the provided research.
// It uses free public APIs from Solscan, DEXScreener, and Birdeye (if API key added), along with @solana/web3.js for on-chain queries.
// For advanced features like vesting checks or full risk scoring, consider integrating paid APIs (e.g., Birdeye, RugCheck).
// Note: This is a basic implementation. In production, handle errors, rate limits, caching, and add API keys where needed.
// Circulating supply is estimated (total - burned/locked, but requires manual wallet inputs for accuracy).
// Install dependencies: npm install @solana/web3.js @solana/spl-token axios

const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint, getTokenLargestAccounts } = require('@solana/spl-token');
const axios = require('axios');

// Solana mainnet RPC (use your own for better performance, e.g., Helius or QuickNode)
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Helper: Fetch token metadata from Solscan
async function getTokenMeta(tokenAddress) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/meta?address=${tokenAddress}`);
    return response.data.data || null;
  } catch (error) {
    console.error('Error fetching Solscan token meta:', error.message);
    return null;
  }
}

// Helper: Fetch top holders from Solscan
async function getTopHolders(tokenAddress, limit = 50) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/holders?address=${tokenAddress}&page=1&page_size=${limit}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching Solscan holders:', error.message);
    return [];
  }
}

// Helper: Fetch DEX pairs from DEXScreener
async function getDexPairs(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    return response.data.pairs || [];
  } catch (error) {
    console.error('Error fetching DEXScreener pairs:', error.message);
    return [];
  }
}

// Helper: Fetch recent transactions from Solscan (for burns, mints, etc.)
async function getRecentTransactions(tokenAddress, limit = 50) {
  try {
    const response = await axios.get(`https://api.solscan.io/v2.0/token/txns?address=${tokenAddress}&limit=${limit}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching Solscan transactions:', error.message);
    return [];
  }
}

// Helper: Fetch token overview from Birdeye (requires API key for full access; free tier limited)
async function getBirdeyeOverview(tokenAddress, apiKey = '') {
  try {
    const headers = apiKey ? { 'X-API-KEY': apiKey } : {};
    const response = await axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`, { headers });
    return response.data.data || null;
  } catch (error) {
    console.error('Error fetching Birdeye overview:', error.message);
    return null;
  }
}

// Main function to perform tokenomics analysis
async function performTokenomicsAnalysis(tokenAddress, knownVestingWallets = [], birdeyeApiKey = '') {
  const report = {
    basicInfo: {},
    supplyMetrics: {},
    authorities: {},
    distribution: {},
    lpAnalysis: {},
    burnAndMintActivity: {},
    riskIndicators: [],
    estimatedCirculatingSupply: 0,
    notes: [] // Additional insights
  };

  // 1. Basic Info & Authorities (on-chain)
  try {
    const tokenMint = new PublicKey(tokenAddress);
    const mintInfo = await getMint(connection, tokenMint);
    report.basicInfo = {
      decimals: mintInfo.decimals,
      totalSupply: Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals),
    };
    report.authorities = {
      mintAuthority: mintInfo.mintAuthority ? 'Active (Risk: Unlimited supply possible)' : 'Renounced (Fixed supply)',
      freezeAuthority: mintInfo.freezeAuthority ? 'Active (Risk: Can freeze accounts)' : 'Renounced (Safe)',
    };
    if (mintInfo.mintAuthority) {
      report.riskIndicators.push('Mint authority active - potential for inflation');
    }
    if (mintInfo.freezeAuthority) {
      report.riskIndicators.push('Freeze authority active - potential for account freezes');
    }
  } catch (error) {
    report.basicInfo.error = 'Failed to fetch on-chain mint info';
  }

  // 2. Supply Metrics (from Solscan meta)
  const tokenMeta = await getTokenMeta(tokenAddress);
  if (tokenMeta) {
    report.supplyMetrics = {
      totalSupply: tokenMeta.supply / Math.pow(10, tokenMeta.decimals), // Normalized
      holderCount: tokenMeta.holder,
      // Circulating: Solscan may provide; else estimate below
    };
  } else {
    report.supplyMetrics.error = 'Failed to fetch token meta';
  }

  // 3. Distribution & Concentration
  const topHolders = await getTopHolders(tokenAddress);
  if (topHolders.length > 0) {
    const totalSupply = BigInt(tokenMeta?.supply || report.basicInfo.totalSupply * Math.pow(10, report.basicInfo.decimals));
    let top10Percent = 0;
    let teamConcentration = 0;
    topHolders.slice(0, 10).forEach(holder => {
      const balance = BigInt(holder.amount);
      top10Percent += Number((balance * 100n) / totalSupply);
      // Heuristic: Assume top non-exchange wallets might be team; refine with known wallets
    });
    report.distribution = {
      top10HoldersPercent: top10Percent,
      holderCount: report.supplyMetrics.holderCount,
    };
    if (top10Percent > 50) {
      report.riskIndicators.push('High whale concentration (>50% in top 10 holders)');
    } else if (top10Percent > 20) {
      report.riskIndicators.push('Moderate concentration (>20% in top 10)');
    }
    // Check for known vesting/treasury wallets (user-provided)
    if (knownVestingWallets.length > 0) {
      let lockedAmount = 0n;
      topHolders.forEach(holder => {
        if (knownVestingWallets.includes(holder.owner)) {
          lockedAmount += BigInt(holder.amount);
        }
      });
      report.estimatedCirculatingSupply = Number((totalSupply - lockedAmount) / BigInt(Math.pow(10, report.basicInfo.decimals)));
      report.notes.push(`Estimated circulating supply: ${report.estimatedCirculatingSupply} (excluding provided vesting wallets)`);
    } else {
      report.notes.push('Provide known vesting/treasury wallets for better circulating supply estimate');
      report.estimatedCirculatingSupply = report.supplyMetrics.totalSupply; // Fallback
    }
  } else {
    report.distribution.error = 'Failed to fetch holders';
  }

  // 4. LP Analysis (from DEXScreener)
  const pairs = await getDexPairs(tokenAddress);
  if (pairs.length > 0) {
    const mainPair = pairs.reduce((prev, curr) => (curr.liquidity?.usd > prev.liquidity?.usd ? curr : prev), pairs[0]);
    report.lpAnalysis = {
      dex: mainPair.dexId,
      liquidityUSD: mainPair.liquidity?.usd || 0,
      lpLocked: 'Unknown (Integrate Birdeye/RugCheck for lock status)',
      // For lock status, use Birdeye if key provided
    };
    if (report.lpAnalysis.liquidityUSD < 50000) {
      report.riskIndicators.push('Shallow liquidity (<$50k) - high volatility risk');
    }
    // Enhance with Birdeye if API key
    if (birdeyeApiKey) {
      const birdeyeData = await getBirdeyeOverview(tokenAddress, birdeyeApiKey);
      if (birdeyeData) {
        report.lpAnalysis.lpLocked = birdeyeData.liquidity_locked ? 'Locked' : 'Unlocked (Risk)';
        if (!birdeyeData.liquidity_locked) {
          report.riskIndicators.push('Unlocked LP - rug pull risk');
        }
        report.supplyMetrics.marketCap = birdeyeData.mc;
      }
    } else {
      report.notes.push('Provide Birdeye API key for LP lock and market data');
    }
  } else {
    report.lpAnalysis.error = 'No DEX pairs found';
    report.riskIndicators.push('No liquidity detected - illiquid token');
  }

  // 5. Burn and Mint Activity (from recent transactions)
  const recentTx = await getRecentTransactions(tokenAddress);
  if (recentTx.length > 0) {
    let burns = 0, mints = 0, burnedAmount = 0;
    recentTx.forEach(tx => {
      if (tx.type === 'burn') {
        burns++;
        burnedAmount += tx.amount;
      } else if (tx.type === 'mint') {
        mints++;
      }
    });
    report.burnAndMintActivity = {
      recentBurns: burns,
      burnedAmount: burnedAmount / Math.pow(10, report.basicInfo.decimals),
      recentMints: mints,
    };
    if (mints > 0 && !report.authorities.mintAuthority.includes('Active')) {
      report.riskIndicators.push('Unexpected mints detected despite renounced authority');
    }
    if (burns > 0) {
      report.notes.push('Deflationary mechanics detected via burns');
    }
  } else {
    report.burnAndMintActivity.error = 'Failed to fetch transactions';
  }

  // Additional: Meme vs Utility heuristic (basic: based on name/description; advanced: manual or AI classify)
  if (tokenMeta && (tokenMeta.name.toLowerCase().includes('meme') || tokenMeta.description?.includes('fun'))) {
    report.notes.push('Token appears to be a memecoin (hype-driven, high risk)');
  } else {
    report.notes.push('Token may have utility (verify use cases off-chain)');
  }

  // Risk Summary
  report.riskLevel = report.riskIndicators.length > 3 ? 'High' : report.riskIndicators.length > 1 ? 'Medium' : 'Low';

  // Commented: Integrate RugCheck API if available (requires custom integration)
  // e.g., const rugCheckResponse = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`);

  return report;
}

// Example usage (run with node)
(async () => {
  const tokenAddress = 'Pumpui3xvBFpX4vvVBy42SYLiR8Kwg8tr6V3TaBQM7b'; // Example: Replace with real token mint
  const vestingWallets = []; // e.g., ['vestingWallet1', 'vestingWallet2']
  const birdeyeKey = ''; // Add your key
  const report = await performTokenomicsAnalysis(tokenAddress, vestingWallets, birdeyeKey);
  console.log(JSON.stringify(report, null, 2));
})();