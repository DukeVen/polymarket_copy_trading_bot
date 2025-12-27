# Position Tracking Flow

## How the Bot Calculates Trades

```
┌─────────────────────────────────────────────────────────────┐
│                    BOT INITIALIZATION                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ Fetch Target's   │
                    │ Current Positions│
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ Save as Initial  │
                    │ Snapshot to DB   │
                    └──────────────────┘
                              │
                              ▼
                    Start Monitoring...


┌─────────────────────────────────────────────────────────────┐
│              WHEN TARGET MAKES A TRADE                       │
└─────────────────────────────────────────────────────────────┘

Step 1: Get Positions
┌──────────────────────────────────────────────────────────────┐
│ Initial Target Size (from snapshot):       100 shares       │
│ Current Target Size (live API):            150 shares       │
│ Bot Current Size (from bot_positions):      40 shares       │
└──────────────────────────────────────────────────────────────┘

Step 2: Calculate Target's Change
┌──────────────────────────────────────────────────────────────┐
│ Target Change = Current - Initial                            │
│               = 150 - 100                                    │
│               = +50 shares                                   │
└──────────────────────────────────────────────────────────────┘

Step 3: Calculate Bot's Target Position
┌──────────────────────────────────────────────────────────────┐
│ Bot Should Have = max(0, Target Change)                      │
│                 = max(0, +50)                                │
│                 = 50 shares                                  │
└──────────────────────────────────────────────────────────────┘

Step 4: Calculate Required Action
┌──────────────────────────────────────────────────────────────┐
│ Bot Size Change = Bot Should Have - Bot Current              │
│                 = 50 - 40                                    │
│                 = +10 shares                                 │
│                                                              │
│ → Action: BUY 10 shares                                      │
└──────────────────────────────────────────────────────────────┘

Step 5: Execute and Update
┌──────────────────────────────────────────────────────────────┐
│ Execute: BUY 10 shares                                       │
│ Update bot_positions: 40 + 10 = 50 shares                   │
└──────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────┐
│              OVERSELL PREVENTION EXAMPLE                     │
└─────────────────────────────────────────────────────────────┘

Scenario: Target sells but bot doesn't have enough

Step 1: Get Positions
┌──────────────────────────────────────────────────────────────┐
│ Initial Target Size:    100 shares                           │
│ Current Target Size:     20 shares (sold 80)                 │
│ Bot Current Size:        30 shares (only bought 30)          │
└──────────────────────────────────────────────────────────────┘

Step 2: Calculate
┌──────────────────────────────────────────────────────────────┐
│ Target Change = 20 - 100 = -80 shares                        │
│ Bot Should Have = max(0, -80) = 0 shares                     │
│ Bot Size Change = 0 - 30 = -30 shares                        │
│                                                              │
│ → Wants to SELL 30 shares                                    │
│ → Bot has 30 shares                                          │
│ → Safe to sell: min(30, 30) = 30 shares ✓                   │
└──────────────────────────────────────────────────────────────┘

If bot only had 20 shares:
┌──────────────────────────────────────────────────────────────┐
│ → Wants to SELL 30 shares                                    │
│ → Bot has 20 shares                                          │
│ → Safe to sell: min(30, 20) = 20 shares ✓                   │
│                                                              │
│ ⚠️ Partial fill: Selling 20 (wanted 30 but only have 20)   │
└──────────────────────────────────────────────────────────────┘
