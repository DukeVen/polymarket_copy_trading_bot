# Copy Bot Restructure Summary

## Problem Solved

The bot now correctly handles the scenario where:
1. Target buys shares **before** the bot starts
2. Bot starts and takes a snapshot of target's positions
3. Target makes additional trades
4. Bot only copies the **delta** (change) from the initial snapshot

### Example Scenario
- **Timestamp 1**: Target buys 5 shares of event A
- **Timestamp 2**: Bot starts → Takes snapshot (target has 5 shares)
- **Timestamp 3**: Target buys 10 more shares (now has 15 total) → Bot buys 10 shares
- **Timestamp 4**: Target sells 15 shares (now has 0) → Bot sells 10 shares (all it has)

✅ **Bot will NOT try to sell shares it doesn't own**

## Architecture Changes

### 1. New Data Models

#### **BotPositionInterface** ([interfaces/User.ts](src/interfaces/User.ts))
Tracks what the bot actually owns:
```typescript
{
  conditionId: string;
  asset: string;
  size: number;        // Bot's actual holdings
  outcomeIndex: number;
  lastUpdated: number;
}
```

#### **InitialTargetPositionInterface** ([interfaces/User.ts](src/interfaces/User.ts))
Snapshots target's positions when bot starts:
```typescript
{
  conditionId: string;
  asset: string;
  size: number;           // Target's position when bot started
  outcomeIndex: number;
  startTimestamp: number; // When snapshot was taken
}
```

### 2. Trade Monitor Updates ([tradeMonitor.ts](src/services/tradeMonitor.ts))

**On First Run:**
- Takes snapshot of ALL target's current positions
- Saves to `initial_target_positions` collection
- Only happens once (checks if snapshot already exists)

**Continuous Monitoring:**
- Tracks target's current positions in real-time
- Provides helper functions to get initial vs current positions

**New Exports:**
```typescript
getInitialTargetPosition(asset: string)  // Returns target's initial size
getCurrentTargetPosition(asset: string)  // Returns target's current size
```

### 3. Trade Executor Restructure ([tradeExecutor.ts](src/services/tradeExecutor.ts))

**New Delta Calculation Logic:**

```typescript
// Calculate what bot should own
targetChange = currentTargetSize - initialTargetSize
botTargetSize = max(0, targetChange)  // Mirror the change

// Calculate what trade to make
botSizeChange = botTargetSize - botCurrentSize

if (botSizeChange > 0) {
    → BUY botSizeChange shares
} else if (botSizeChange < 0) {
    → SELL min(|botSizeChange|, botCurrentSize)  // Never oversell!
}
```

**Position Tracking:**
- After each successful trade, updates `bot_positions` collection
- Maintains accurate record of bot's holdings
- Used to prevent overselling

**Safety Checks:**
1. ✅ Balance check before buying
2. ✅ Position check before selling (can't sell more than owned)
3. ✅ Handles partial fills by capping sell size

## Key Functions

### `calculateBotTrade(trade)`
**Purpose:** Determines what the bot should do based on target's trade

**Returns:**
```typescript
{
  shouldTrade: boolean;
  action: 'BUY' | 'SELL';
  size: number;
  reason: string;
}
```

**Logic:**
1. Get target's initial position (snapshot)
2. Get target's current position (live)
3. Get bot's current position (db)
4. Calculate delta and determine action
5. Apply safety checks (no overselling)

### `updateBotPosition(asset, sizeChange, ...)`
**Purpose:** Update bot's position after successful trade

**Parameters:**
- `sizeChange`: positive for buy, negative for sell
- Returns new total position size

### `executeOrder(clobClient, tokenID, side, size, price)`
**Purpose:** Simple wrapper to execute market orders

**Returns:** `{ success: boolean, error?: string }`

## Database Collections

| Collection | Purpose |
|------------|---------|
| `user_activities_{address}` | Target's trade history |
| `user_positions_{address}` | Target's current positions |
| `initial_target_positions_{address}` | Target's positions when bot started |
| `bot_positions` | Bot's actual holdings |

## Logging Output

The bot now provides detailed position analysis:

```
📊 Position Analysis for Event X - Yes:
   Target initial: 5 shares
   Target current: 15 shares
   Target change: +10
   Bot current: 0 shares
   Bot should have: 10 shares
   Bot needs to: BUY 10 shares

💡 Decision: Buying 10 shares to match target's position change
```

## Testing Scenarios

### Scenario 1: Target had position before bot started
- Initial: Target 100 shares, Bot 0 shares
- Target buys 50 more (now 150)
- ✅ Bot buys 50 shares

### Scenario 2: Target sells all
- Initial: Target 100 shares, Bot 0 shares  
- Target sells 100 shares (now 0)
- ✅ Bot does nothing (can't sell what it doesn't have)

### Scenario 3: Partial tracking
- Initial: Target 100 shares, Bot 0 shares
- Target buys 50 (now 150), Bot buys 50 (now 50)
- Target sells 75 (now 75), Bot sells 25 (now 25) ← **Correctly limits sell**
- Bot should have: max(0, 75-100) = 0, so sells remaining 25

### Scenario 4: Fresh position
- Initial: Target 0 shares, Bot 0 shares
- Target buys 100, Bot buys 100
- Target sells 50, Bot sells 50
- ✅ Perfect mirror after bot started

## Configuration

No new environment variables needed. Uses existing:
- `TARGET_ADDRESS` - Target wallet to copy
- `PROXY_WALLET` - Bot's wallet
- `DRY_RUN` - Test mode without executing trades
- `RETRY_LIMIT` - Max retries for failed trades

## Migration Notes

**First run after update:**
1. Bot will snapshot all current target positions
2. These become the baseline
3. Only trades AFTER this point are copied

**To reset and re-snapshot:**
Delete the `initial_target_positions` collection in MongoDB

## Safety Features

✅ Never sells more shares than bot owns  
✅ Checks balance before buying  
✅ Detailed logging for transparency  
✅ DRY_RUN mode for testing  
✅ Retry mechanism with limits  
✅ Separate tracking of bot vs target positions
