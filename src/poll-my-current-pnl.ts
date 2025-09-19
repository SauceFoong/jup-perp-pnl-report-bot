import { type IdlAccounts } from "@coral-xyz/anchor";
import { Perpetuals } from "./idl/jupiter-perpetuals-idl";
import { JUPITER_PERPETUALS_PROGRAM, DOVES_PROGRAM } from "./constants";
import { PublicKey } from "@solana/web3.js";
import { BNToUSDRepresentation } from "./utils";
import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';

dotenv.config();

// Configuration
const POLL_INTERVAL_SECONDS = 30; // Poll every x seconds (configurable)
const WALLET_ADDRESS = "BxmSEddwE1jBFVSXnsvDsujgjBh2GK2jhrzpZLJJidrG";

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS?.split(',').map(id => parseInt(id.trim())) || [];

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required in .env file');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

async function sendTelegramMessage(message: string) {
  try {
    for (const userId of TELEGRAM_ALLOWED_USERS) {
      await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
}

export async function getMyCurrentPnL(ownerAddress: string, sendToTelegram: boolean = false) {
  try {
    const owner = new PublicKey(ownerAddress);
    
    // Get positions
    const gpaResult = await JUPITER_PERPETUALS_PROGRAM.provider.connection.getProgramAccounts(
      JUPITER_PERPETUALS_PROGRAM.programId,
      {
        commitment: "confirmed",
        filters: [
          {
            memcmp: JUPITER_PERPETUALS_PROGRAM.coder.accounts.memcmp("position"),
          },
          {
            memcmp: {
              offset: 8,
              bytes: owner.toBase58(),
            },
          },
        ],
      },
    );

    const positions = gpaResult.map((item) => ({
      publicKey: item.pubkey,
      account: JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode(
        "position",
        item.account.data,
      ) as IdlAccounts<Perpetuals>["position"],
    }));

    const openPositions = positions.filter((position) =>
      position.account.sizeUsd.gtn(0),
    );

    if (openPositions.length === 0) {
      const message = `No open positions found for ${ownerAddress}`;
      console.log(message);
      if (sendToTelegram) {
        await sendTelegramMessage(`📊 *PnL Report*\n\n${message}`);
      }
      return [];
    }
    
    // Map custody addresses to oracle addresses
    const CUSTODY_TO_ORACLE: { [key: string]: { name: string; oracle: string } } = {
      "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz": { 
        name: "SOL", 
        oracle: "39cWjvHrpHNz2SbXv6ME4NPhqBDBd4KsjUYv5JkHEAJU" 
      },
      "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn": { 
        name: "ETH", 
        oracle: "5URYohbPy32nxK1t3jAHVNfdWY2xTubHiFvLrE3VhXEp" 
      },
      "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm": { 
        name: "BTC", 
        oracle: "4HBbPx9QJdjJ7GUe6bsiJjGybvfpDhQMMPXP1UEa7VT5" 
      },
      "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa": { 
        name: "USDC", 
        oracle: "A28T5pKtscnhDo6C1Sz786Tup88aTjt8uyKewjVvPrGk" 
      },
      "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk": { 
        name: "USDT", 
        oracle: "AGW7q2a3WxCzh5TB2Q6yNde1Nf41g3HLaaXdybz7cbBU" 
      }
    };

    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n📊 PnL Update - ${timestamp} - ${openPositions.length} position(s)`);
    console.log('='.repeat(80));

    let telegramMessage = `📊 *PnL Report* - ${timestamp}\n*${openPositions.length} position(s)*\n\n`;
    let totalPnlAfterFees = 0;
    let totalPnlPercentage = 0;

    for (let i = 0; i < openPositions.length; i++) {
      const position = openPositions[i];
      const pos = position.account;
      
      const custodyInfo = CUSTODY_TO_ORACLE[pos.custody.toString()];
      if (!custodyInfo) {
        console.log(`Unknown custody: ${pos.custody.toString()}`);
        continue;
      }

      // Get current price from oracle
      const oraclePrice = await DOVES_PROGRAM.account.priceFeed.fetch(
        new PublicKey(custodyInfo.oracle)
      );

      const side = pos.side.long ? 'LONG' : 'SHORT';
      const entryPrice = pos.price;
      const currentPrice = oraclePrice.price;
      const sizeUsd = pos.sizeUsd;
      
      // Calculate unrealized PnL
      // Use Decimal.js for precision to avoid BigNumber overflow
      const Decimal = require('decimal.js');
      
      const entryPriceDecimal = new Decimal(entryPrice.toString());
      const currentPriceDecimal = new Decimal(currentPrice.toString()).div(Math.pow(10, Math.abs(oraclePrice.expo) - 6)); // Convert oracle price to same scale as entry price
      const sizeUsdDecimal = new Decimal(sizeUsd.toString());
      
      let pnlDecimal;
      if (side === 'LONG') {
        // PnL = sizeUsd * (currentPrice - entryPrice) / entryPrice
        pnlDecimal = sizeUsdDecimal.mul(currentPriceDecimal.sub(entryPriceDecimal)).div(entryPriceDecimal);
      } else {
        // PnL = sizeUsd * (entryPrice - currentPrice) / entryPrice  
        pnlDecimal = sizeUsdDecimal.mul(entryPriceDecimal.sub(currentPriceDecimal)).div(entryPriceDecimal);
      }
      
      // Calculate fees (0.06% for opening + 0.06% for closing = 0.12% total)
      const openingFeeDecimal = sizeUsdDecimal.mul(0.0006); // 0.06% = 0.0006
      const closingFeeDecimal = sizeUsdDecimal.mul(0.0006); // 0.06% = 0.0006
      const totalFeesDecimal = openingFeeDecimal.add(closingFeeDecimal); // Total fees = 0.12%
      const pnlAfterFeesDecimal = pnlDecimal.sub(totalFeesDecimal); // Subtract total fees from PnL
      
      // Display
      const entryPriceUsd = BNToUSDRepresentation(entryPrice, 6);
      const currentPriceUsd = BNToUSDRepresentation(currentPrice, Math.abs(oraclePrice.expo));
      const sizeUsdFormatted = BNToUSDRepresentation(sizeUsd, 6);
      const collateralUsdFormatted = BNToUSDRepresentation(pos.collateralUsd, 6);
      const pnlFormatted = pnlDecimal.abs().div(1000000).toFixed(2);
      const openingFeeFormatted = openingFeeDecimal.div(1000000).toFixed(2);
      const closingFeeFormatted = closingFeeDecimal.div(1000000).toFixed(2);
      const totalFeesFormatted = totalFeesDecimal.div(1000000).toFixed(2);
      const pnlAfterFeesFormatted = pnlAfterFeesDecimal.abs().div(1000000).toFixed(2);
      const realizedPnlFormatted = BNToUSDRepresentation(pos.realisedPnlUsd, 6);
      
      const hasProfit = pnlDecimal.gt(0);
      const hasProfitAfterFees = pnlAfterFeesDecimal.gt(0);
      
      // Calculate percentage based on collateral (not position size)
      const collateralUsdDecimal = new Decimal(pos.collateralUsd.toString());
      const pnlPercentage = pnlDecimal.div(collateralUsdDecimal).mul(100).toFixed(2);
      const pnlAfterFeesPercentage = pnlAfterFeesDecimal.div(collateralUsdDecimal).mul(100).toFixed(2);
      
      console.log(`🎯 ${side} ${custodyInfo.name} | $${currentPriceUsd} | PnL: ${hasProfitAfterFees ? '+' : '-'}$${pnlAfterFeesFormatted} (${hasProfitAfterFees ? '+' : '-'}${pnlAfterFeesPercentage}%) ${hasProfitAfterFees ? '📈' : '📉'}`);

      // Add to Telegram message
      telegramMessage += `🎯 *${side} ${custodyInfo.name}*\n`;
      telegramMessage += `💰 Current: $${currentPriceUsd}\n`;
      telegramMessage += `📊 Entry: $${entryPriceUsd}\n`;
      telegramMessage += `💵 Size: $${sizeUsdFormatted}\n`;
      telegramMessage += `🔒 Collateral: $${collateralUsdFormatted}\n`;
      telegramMessage += `💼 PnL: ${hasProfitAfterFees ? '+' : '-'}$${pnlAfterFeesFormatted} (${hasProfitAfterFees ? '+' : '-'}${pnlAfterFeesPercentage}%) ${hasProfitAfterFees ? '📈' : '📉'}\n\n`;

      // Track totals
      totalPnlAfterFees += parseFloat(hasProfitAfterFees ? pnlAfterFeesFormatted : `-${pnlAfterFeesFormatted}`);
      totalPnlPercentage += parseFloat(hasProfitAfterFees ? pnlAfterFeesPercentage : `-${pnlAfterFeesPercentage}`);
    }

    // Add summary to Telegram message
    if (openPositions.length > 1) {
      telegramMessage += `📈 *Total PnL: ${totalPnlAfterFees >= 0 ? '+' : ''}$${Math.abs(totalPnlAfterFees).toFixed(2)}*\n`;
      telegramMessage += `📊 *Avg %: ${totalPnlPercentage >= 0 ? '+' : ''}${(totalPnlPercentage / openPositions.length).toFixed(2)}%*`;
    }

    // Send to Telegram if enabled
    if (sendToTelegram) {
      await sendTelegramMessage(telegramMessage);
    }

    return openPositions;
  } catch (error) {
    console.error("Failed to fetch current PnL", error);
    return [];
  }
}

async function pollMyPnL() {
  console.log(`🚀 Starting PnL monitoring for wallet: ${WALLET_ADDRESS}`);
  console.log(`📊 Polling every ${POLL_INTERVAL_SECONDS} seconds`);
  console.log(`📱 Telegram notifications enabled for users: ${TELEGRAM_ALLOWED_USERS.join(', ')}`);
  console.log(`⏹️  Press Ctrl+C to stop\n`);

  // Initial fetch with Telegram notification
  await getMyCurrentPnL(WALLET_ADDRESS, true);

  // Set up polling with Telegram notifications
  setInterval(async () => {
    await getMyCurrentPnL(WALLET_ADDRESS, true);
  }, POLL_INTERVAL_SECONDS * 1000);
}

// Create Express server for Render health checks
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'running',
    service: 'jupiter-pnl-reporter',
    uptime: process.uptime()
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy' });
});

// Start server and polling
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  pollMyPnL();
});