# Polymarket Copy Trading Bot

A **TypeScript-based copy trading bot** for **Polymarket** that monitors a target wallet and automatically replicates their trades. Built with **Bun** and **MongoDB** for persistent trade tracking.

---

## Overview

This bot continuously monitors a target wallet's trading activity on Polymarket and copies their trades to your wallet according to configurable risk parameters.

### Core Features

* **Real-Time Trade Monitoring** – Detects and copies trades from target wallet
* **Dry Run Mode** – Test configuration without executing real trades
* **Size Controls** – Configurable trade size multiplier and maximum order amounts
* **Persistent History** – MongoDB-backed trade tracking
* **Smart Sizing** – Proportional sizing based on balance ratios

---

## Technology Stack

* **Runtime**: Bun (TypeScript runtime)
* **Language**: TypeScript
* **Database**: MongoDB (trade history & positions)
* **Blockchain**: Polygon (Ethereum L2)
* **APIs**: 
  * `@polymarket/clob-client` (Order execution)
  * Polymarket Data API (positions & balances)

---

## Installation

### Prerequisites

* **Bun** v1.0+
* **MongoDB** (local or cloud instance)
* **Polygon Wallet** with USDC
* **Private Key** for your trading wallet

### Setup Steps

```bash
git clone <repository-url>
cd polymarket-copy-trading-bot
bun install
```

Create `.env` file in the project root:

```env
USER_ADDRESS=0xTargetWalletToMonitor
PRIVATE_KEY=your_private_key_here

CLOB_HTTP_URL=https://clob.polymarket.com
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
MONGO_URI=mongodb://localhost:27017/polymarket
RPC_URL=https://polygon-rpc.com
USDC_CONTRACT_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

SIZE_MULTIPLIER=1.0
MAX_ORDER_AMOUNT=100
DRY_RUN=true

FETCH_INTERVAL=1
TOO_OLD_TIMESTAMP=24
RETRY_LIMIT=3
```

Start the bot:

```bash
bun src/index.ts
```

---

## ⚙️ Configuration Reference

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `USER_ADDRESS` | ✅ | Target wallet address to monitor | - |
| `PRIVATE_KEY` | ✅ | Your wallet's private key | - |
| `CLOB_HTTP_URL` | ✅ | Polymarket CLOB API endpoint | - |
| `CLOB_WS_URL` | ✅ | Polymarket WebSocket URL | - |
| `MONGO_URI` | ✅ | MongoDB connection string | - |
| `RPC_URL` | ✅ | Polygon RPC endpoint | - |
| `USDC_CONTRACT_ADDRESS` | ✅ | USDC token contract on Polygon | - |
| `SIZE_MULTIPLIER` | ❌ | Trade size scaling factor (0.1 = 10%, 2.0 = 200%) | `1.0` |
| `MAX_ORDER_AMOUNT` | ❌ | Maximum USDC per order | `100` |
| `DRY_RUN` | ❌ | Simulate trades without executing | `false` |
| `FETCH_INTERVAL` | ❌ | Seconds between trade checks | `1` |
| `TOO_OLD_TIMESTAMP` | ❌ | Hours before ignoring old trades | `24` |
| `RETRY_LIMIT` | ❌ | Max retries for failed orders | `3` |

---

## 🔷 Dry Run Mode

The bot includes a **dry run mode** for testing without executing real trades.

### Enable Dry Run

Set in `.env`:

```env
DRY_RUN=true
```

### What Gets Simulated

✅ **Simulated (Logged Only)**:
- Order creation and validation
- Price calculations and sizing
- Trade signal detection
- Balance checks and risk calculations
- All trade execution logic

❌ **Not Executed**:
- Actual order submission to CLOB
- Blockchain transactions
- USDC transfers
- Position changes

### Console Output Example

```
==================================================
🔷 DRY RUN MODE: Orders will be simulated only
==================================================

🔷 [DRY RUN] Would post BUY order: {
  side: 'BUY',
  tokenID: '0x123abc...',
  amount: 10.5,
  price: 0.52,
  orderType: 'FOK'
}
```

### Switch to Live Trading

```env
DRY_RUN=false
```

Console will show:

```
==================================================
✅ LIVE MODE: Orders will be executed
==================================================
```

---

## 💰 Trading Strategies

### Buy Strategy

When target wallet buys a position:

1. Calculate your wallet's balance ratio vs target wallet
2. Apply `SIZE_MULTIPLIER` to scale the trade
3. Cap order at `MAX_ORDER_AMOUNT` USDC
4. Find best ask price in orderbook
5. Execute FOK (Fill-or-Kill) order

**Formula**: `order_size = min(trade_amount * balance_ratio * SIZE_MULTIPLIER, MAX_ORDER_AMOUNT)`

### Sell Strategy

When target wallet sells a position:

1. Calculate sell ratio based on their position reduction
2. Apply `SIZE_MULTIPLIER` to your position size
3. Find best bid price in orderbook
4. Execute FOK order

**Formula**: `sell_amount = your_position * sell_ratio * SIZE_MULTIPLIER`

### Merge Strategy

Automatically sells positions to consolidate holdings when needed.

---

## 📁 Project Structure

```
src/
├── index.ts                    # Entry point
├── config/
│   ├── db.ts                   # MongoDB connection
│   └── env.ts                  # Environment variable validation
├── services/
│   ├── tradeMonitor.ts         # Monitors target wallet
│   └── tradeExecutor.ts        # Executes copy trades
├── utils/
│   ├── createClobClient.ts     # CLOB client initialization
│   ├── fetchData.ts            # API data fetching
│   ├── getMyBalance.ts         # Balance retrieval
│   ├── postOrder.ts            # Order execution logic
│   └── spinner.ts              # CLI spinner
├── models/
│   └── userHistory.ts          # MongoDB schemas
└── interfaces/
    └── User.ts                 # TypeScript interfaces
```

---

## 🚀 How It Works

1. **Monitor** – `tradeMonitor` continuously polls for new trades from target wallet
2. **Detect** – Identifies new trades stored in MongoDB with `bot: false`
3. **Calculate** – `tradeExecutor` calculates appropriate order size using multiplier and caps
4. **Validate** – Checks balances, positions, and price differences
5. **Execute** – Posts order to Polymarket CLOB (or simulates in dry run)
6. **Track** – Updates MongoDB with execution status

---

## 🛡️ Risk Management

### Built-in Protections

* **Maximum Order Size** – `MAX_ORDER_AMOUNT` caps single orders
* **Size Multiplier** – Scale trades up or down with `SIZE_MULTIPLIER`
* **Price Validation** – Rejects orders with >5% price deviation
* **Retry Limits** – Fails after `RETRY_LIMIT` attempts
* **Balance Checks** – Verifies sufficient funds before trading

### Best Practices

✅ **Start with dry run enabled** to verify behavior  
✅ **Use SIZE_MULTIPLIER < 1.0** initially (e.g., 0.5 for 50% size)  
✅ **Set conservative MAX_ORDER_AMOUNT** to limit exposure  
✅ **Monitor MongoDB** for failed trades  
✅ **Keep USDC balance** sufficient for target's trading volume  

---

## 🐛 Troubleshooting

### Bot not detecting trades

- Verify `USER_ADDRESS` matches target wallet
- Check MongoDB connection (`MONGO_URI`)
- Ensure target wallet is actively trading
- Check `FETCH_INTERVAL` isn't too high

### Orders failing

- Verify `PRIVATE_KEY` is correct
- Check USDC balance in `PROXY_WALLET`
- Ensure `CLOB_HTTP_URL` is reachable
- Review price deviation (max 5%)
- Check orderbook has sufficient liquidity

### Database errors

- Verify MongoDB is running
- Check `MONGO_URI` connection string
- Ensure database permissions

---

## 📊 MongoDB Collections

The bot creates two collections per monitored wallet:

### `user_{address}_activity`
Stores all trade activity from target wallet:
- `type`: Trade type (TRADE, MERGE, etc.)
- `bot`: Whether bot has processed this trade
- `botExcutedTime`: Number of execution attempts
- `asset`, `conditionId`, `size`, `price`, etc.

### `user_{address}_position`
Tracks current positions (if implemented).

---

## 🔧 Development

### Type Checking

```bash
bun run tsc --noEmit
```

### Watch Mode

```bash
bun --watch src/index.ts
```

### Testing

Set `DRY_RUN=true` and monitor console output for simulated trades.

---

## ⚠️ Risk Disclosure

* **Copy trading amplifies both gains and losses**
* **You are responsible for all trades executed**
* **Market conditions may cause slippage**
* **API/Network outages can impact execution**
* **Smart contract risks apply**

**Use at your own risk. Only trade with capital you can afford to lose.**

---

## 📄 License

ISC

---

**Disclaimer**: This software is provided as-is without warranties. Prediction market trading involves substantial risk. The developers are not responsible for financial losses incurred through use of this software.
