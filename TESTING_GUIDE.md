# Testing Guide

## Prerequisites

1. Set `DRY_RUN=true` in your `.env` file for safe testing
2. Make sure MongoDB is running
3. Configure `USER_ADDRESS` (target wallet) and `PROXY_WALLET` (your bot wallet)

## Test Scenarios

### Test 1: Bot Starts Fresh (Target Has Existing Positions)

**Setup:**
- Target wallet has positions: Event A (100 shares), Event B (50 shares)
- Bot has no positions
- Delete any existing `initial_target_positions` collection

**Steps:**
```bash
npm start
```

**Expected Output:**
```
📸 Taking snapshot of target's initial positions...
  ✓ Saved initial position: Event A - Yes: 100 shares
  ✓ Saved initial position: Event B - No: 50 shares
✅ Snapshot complete. Bot will only copy NEW trades from now on.
```

**Verify in MongoDB:**
```javascript
db.initial_target_positions_<address>.find()
// Should show 2 documents with sizes 100 and 50
```

---

### Test 2: Target Makes New Buy Trade

**Setup:**
- Initial positions already saved (from Test 1)
- Target has 100 shares of Event A

**Action:**
- Target buys 25 more shares of Event A (now has 125 total)

**Expected Bot Behavior:**
```
🆕 New trade detected:
   title: Event A
   side: BUY
   size: 25

📊 Position Analysis for Event A - Yes:
   Target initial: 100 shares
   Target current: 125 shares
   Target change: +25
   Bot current: 0 shares
   Bot should have: 25 shares
   Bot needs to: BUY 25 shares

💡 Decision: Buying 25 shares to match target's position change
🔷 DRY RUN: Would BUY 25 shares @ ~$0.65
```

---

### Test 3: Target Sells (Bot Doesn't Have Enough)

**Setup:**
- Initial: Target 100, Bot 0
- Current: Target 125, Bot 25 (from Test 2)

**Action:**
- Target sells 50 shares (now has 75 total)

**Expected Bot Behavior:**
```
📊 Position Analysis for Event A - Yes:
   Target initial: 100 shares
   Target current: 75 shares
   Target change: -25
   Bot current: 25 shares
   Bot should have: 0 shares  (max(0, -25) = 0)
   Bot needs to: SELL 25 shares

💡 Decision: Selling 25 shares to match target's position change
🔷 DRY RUN: Would SELL 25 shares @ ~$0.70
```

**Note:** Bot sells all its 25 shares even though target sold 50, because bot only mirrors the CHANGE from initial position (75 - 100 = -25).

---

### Test 4: Target Sells More Than Bot Has (Oversell Prevention)

**Setup:**
- Initial: Target 100, Bot 0
- Bot bought 20 shares
- Current: Target 105, Bot 20

**Action:**
- Target sells 80 shares (now has 25 total)

**Expected Bot Behavior:**
```
📊 Position Analysis:
   Target initial: 100 shares
   Target current: 25 shares
   Target change: -75
   Bot current: 20 shares
   Bot should have: 0 shares
   Bot needs to: SELL 20 shares

💡 Decision: ⚠️ Selling 20 shares (wanted 20 but only have 20)
```

**Safety:** Bot will NEVER try to sell more than it owns!

---

### Test 5: Target Had Position Before Bot Started

**Setup:**
- Initial: Target 200 shares (when bot started)
- Bot never bought any (has 0 shares)

**Action:**
- Target sells 50 shares (now has 150)

**Expected Bot Behavior:**
```
📊 Position Analysis:
   Target initial: 200 shares
   Target current: 150 shares
   Target change: -50
   Bot current: 0 shares
   Bot should have: 0 shares
   Bot needs to: SELL 0 shares

💡 Decision: Bot position is already in sync
⏭️  Skipping this trade.
```

**Important:** Bot does NOT try to sell because it never owned those shares in the first place!

---

### Test 6: Bot Restarts (Resume From Previous State)

**Setup:**
- Bot was running, has positions tracked in database
- Stop bot with Ctrl+C
- Restart bot

**Expected Output:**
```
✅ Initial positions already saved. Resuming from previous state.

Trade Monitor is running every X seconds
Waiting for new transactions...
```

**Verify:**
- Initial positions are NOT re-snapshotted
- Bot continues from where it left off
- Bot positions are loaded from `bot_positions` collection

---

## Database Inspection

### Check Initial Snapshot
```javascript
db.initial_target_positions_<address>.find().pretty()
```

### Check Bot's Positions
```javascript
db.bot_positions.find().pretty()
```

### Check Tracked Trades
```javascript
db.user_activities_<address>.find({ bot: false }).pretty()
```

### Check Executed Trades
```javascript
db.user_activities_<address>.find({ bot: true }).pretty()
```

---

## Live Trading (Disable DRY_RUN)

**⚠️ IMPORTANT: Test thoroughly in DRY_RUN first!**

1. Set `DRY_RUN=false` in `.env`
2. Ensure `PROXY_WALLET` has sufficient USDC balance
3. Monitor logs carefully
4. Start with small positions

**Expected Output (Live Mode):**
```
✅ LIVE MODE: Orders will be executed

🚀 Executing BUY: 10 shares @ ~$0.65
✅ Trade executed successfully!
   Bot's new position: 10 shares
```

---

## Troubleshooting

### Bot tries to sell shares it doesn't have
- ❌ This should NEVER happen
- Check `bot_positions` collection for correct data
- Verify `calculateBotTrade` logic

### Bot doesn't copy any trades
- Check `initial_target_positions` exists
- Verify target address is correct
- Check if trades are within `TOO_OLD_TIMESTAMP`

### Position mismatch after restart
- Bot loads from database, not from scratch
- `bot_positions` tracks actual holdings
- Check MongoDB collections for accuracy

### Bot skips all trades
- Verify `getInitialTargetPosition` returns correct values
- Check `currentTargetPositions` map is populated
- Enable more detailed logging

---

## Reset Everything

To start fresh (delete all tracking data):

```javascript
// In MongoDB
db.initial_target_positions_<address>.drop()
db.bot_positions.drop()
db.user_activities_<address>.drop()
db.user_positions_<address>.drop()
```

Then restart the bot - it will re-snapshot target's current positions.
