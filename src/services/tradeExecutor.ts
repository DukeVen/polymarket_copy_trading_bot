import { ClobClient, OrderType, Side, UserMarketOrder } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { getBotPositionModel, getBotSpendingModel } from '../models/userHistory';
import getMyBalance from '../utils/getMyBalance';
import fetchPositions from '../utils/fetchPositions';
import { positionChangeEmitter, PositionChangeEvent } from './positionChangeEmitter';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const MAX_ORDER_AMOUNT = ENV.MAX_ORDER_AMOUNT;
const MAX_SPEND_24H = ENV.MAX_SPEND_24H;
const DRY_RUN = ENV.DRY_RUN;

const PRECISION_MULTIPLIER = 10000; // For rounding to 4 decimal places

const BotPosition = getBotPositionModel();
const BotSpending = getBotSpendingModel();

// Get spending in the last 24 hours
const getSpendingLast24Hours = async (): Promise<number> => {
    const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
    
    try {
        const recentSpending = await BotSpending.find({
            timestamp: { $gte: twentyFourHoursAgo }
        });
        
        const totalSpent = recentSpending.reduce((sum, record) => sum + record.amount, 0);
        return totalSpent;
    } catch (error) {
        console.error('[EXECUTOR] Error fetching spending history:', error);
        return 0;
    }
};

// Record a spending transaction
const recordSpending = async (amount: number, asset: string, title: string, outcome: string): Promise<void> => {
    try {
        await BotSpending.create({
            timestamp: Math.floor(Date.now() / 1000),
            amount,
            asset,
            title,
            outcome,
        });
    } catch (error) {
        console.error('[EXECUTOR] Error recording spending:', error);
    }
};

// Local position type (without mongoose _id)
interface LocalBotPosition {
    asset: string;
    conditionId: string;
    outcomeIndex: number;
    size: number;
    title: string;
    outcome: string;
    lastUpdated: number;
}

// Local position tracking (avoids race conditions from re-fetching)
const botLocalPositions = new Map<string, LocalBotPosition>();
let isInitialized = false;

// Initialize bot positions from API (called once at startup)
const initializeBotPositions = async () => {
    if (!PROXY_WALLET) {
        throw new Error('PROXY_WALLET is not defined');
    }

    console.log('🔄 Fetching bot\'s current positions from API...');
    
    try {
        const positions = await fetchPositions(PROXY_WALLET);
        
        // Load into local map
        botLocalPositions.clear();
        for (const position of positions) {
            if (position.size > 0.01) { // Only track meaningful positions
                botLocalPositions.set(position.asset, {
                    asset: position.asset,
                    conditionId: position.conditionId,
                    outcomeIndex: position.outcomeIndex,
                    size: position.size,
                    title: position.title,
                    outcome: position.outcome,
                    lastUpdated: Math.floor(Date.now() / 1000),
                });
            }
        }
        
        console.log(`✅ Loaded ${botLocalPositions.size} existing bot positions`);
        if (botLocalPositions.size > 0) {
            console.log('📊 Current bot positions:');
            for (const [asset, pos] of botLocalPositions) {
                console.log(`   • ${pos.title} - ${pos.outcome}: ${pos.size} shares`);
            }
        }
        console.log('');
        
        isInitialized = true;
    } catch (error) {
        console.error('❌ Failed to fetch bot positions:', error);
        throw error;
    }
};


// todo, use batched orders?
/*
const orders: PostOrdersArgs[] = [
  {
    order: await clobClient.createMarketOrder({
      tokenID: YES,
      amount: 100,
      side: Side.BUY,
    }),
    orderType: OrderType.FOK,  // or FAK for market orders
  },
  {
    order: await clobClient.createMarketOrder({
      tokenID: NO,
      amount: 50,
      side: Side.BUY,
    }),
    orderType: OrderType.FAK,
  },
];

const resp = await clobClient.postOrders(orders);
*/
// TODO make so spending is recorded only on successful trades
// Execute a market order
// Note: For market orders, 'amount' represents USD value, not number of shares
const executeOrder = async (
    clobClient: ClobClient,
    tokenID: string,
    side: 'BUY' | 'SELL',
    usdAmount: number
): Promise<{ success: boolean; error?: string }> => {
    try {
        const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
        
        const userMarketOrder: UserMarketOrder = {
            tokenID: tokenID,
            amount: usdAmount, // USD amount, not shares
            side: orderSide,
        };
        
        // Use createAndPostMarketOrder - convenience method that creates, signs, and posts in one call
        // FAK (Fill-And-Kill) is better for copy trading - executes partial fills instead of failing completely
        const resp = await clobClient.createAndPostMarketOrder(
            userMarketOrder, 
            { tickSize: '0.001', negRisk: false }, 
            OrderType.FAK
        );
        
        if (resp.success === true) {
            return { success: true };
        } else {
            return { success: false, error: resp.errorMsg || JSON.stringify(resp) };
        }
    } catch (error) {
        return { success: false, error: String(error) };
    }
};

// Get bot's current position for a specific asset (from local map)
const getBotPosition = (asset: string): number => {
    const position = botLocalPositions.get(asset);
    return position ? position.size : 0;
};

// Update bot's position after a trade (local map + database)
const updateBotPosition = async (
    asset: string,
    conditionId: string,
    outcomeIndex: number,
    sizeChange: number,
    title: string,
    outcome: string
): Promise<number> => {
    const currentSize = getBotPosition(asset);
    const newSize = Math.max(0, currentSize + sizeChange); // Can't go below 0
    
    // Round to avoid floating point issues
    const roundedNewSize = Math.round(newSize * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;
    
    // Update local map
    if (roundedNewSize < 0.01) {
        // Position effectively closed
        botLocalPositions.delete(asset);
    } else {
        botLocalPositions.set(asset, {
            asset,
            conditionId,
            outcomeIndex,
            size: roundedNewSize,
            title,
            outcome,
            lastUpdated: Math.floor(Date.now() / 1000),
        });
    }
    
    // Also update database for persistence
    await BotPosition.findOneAndUpdate(
        { asset },
        {
            asset,
            conditionId,
            outcomeIndex,
            size: roundedNewSize,
            title,
            outcome,
            lastUpdated: Math.floor(Date.now() / 1000),
        },
        { upsert: true, new: true }
    );
    
    return roundedNewSize;
};

// Calculate what trade the bot should make based on target's position change
// Uses actual USD amounts from activity API
const calculateBotTrade = (
    sizeChange: number,
    usdcSize: number,
    asset: string,
    title: string,
    outcome: string
): {
    shouldTrade: boolean;
    action: 'BUY' | 'SELL';
    usdAmount: number;
    shares: number;
    reason: string;
} => {
    // Get bot's current position
    const botCurrentSize = getBotPosition(asset);
    
    // Round size change to avoid floating point issues
    const roundedSizeChange = Math.round(sizeChange * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;
    
    // No meaningful change
    if (Math.abs(roundedSizeChange) < 0.01) {
        return {
            shouldTrade: false,
            action: 'BUY',
            usdAmount: 0,
            shares: 0,
            reason: 'Position change too small to replicate'
        };
    }
    
    // Target is buying - bot should buy the same USD amount
    if (roundedSizeChange > 0) {
        return {
            shouldTrade: true,
            action: 'BUY',
            usdAmount: Math.abs(usdcSize),
            shares: roundedSizeChange,
            reason: `Replicating target's BUY of ${roundedSizeChange} shares ($${Math.abs(usdcSize).toFixed(2)} USD)`
        };
    }
    
    // Target is selling - bot should sell the same amount (if it has enough)
    const sellSize = Math.abs(roundedSizeChange);
    const targetUsdAmount = Math.abs(usdcSize);
    
    if (botCurrentSize === 0) {
        return {
            shouldTrade: false,
            action: 'SELL',
            usdAmount: 0,
            shares: 0,
            reason: `⚠️ Cannot replicate SELL - bot has no position in this asset`
        };
    }
    
    // TODO - review?
    if (botCurrentSize < sellSize) {
        // Bot doesn't have enough shares - sell what it has (proportional USD amount)
        const proportionalUsdAmount = (botCurrentSize / sellSize) * targetUsdAmount;
        return {
            shouldTrade: true,
            action: 'SELL',
            usdAmount: proportionalUsdAmount,
            shares: botCurrentSize,
            reason: `⚠️ Partial SELL - target sold ${sellSize} but bot only has ${botCurrentSize} shares (selling all, $${proportionalUsdAmount.toFixed(2)} USD)`
        };
    }
    
    // Bot has enough shares to replicate the sell
    return {
        shouldTrade: true,
        action: 'SELL',
        usdAmount: targetUsdAmount,
        shares: sellSize,
        reason: `Replicating target's SELL of ${sellSize} shares ($${targetUsdAmount.toFixed(2)} USD)`
    };
};

// Process a single position change event
const processPositionChange = async (clobClient: ClobClient, change: PositionChangeEvent) => {
    if (!PROXY_WALLET || !TARGET_ADDRESS) {
        console.error('❌ PROXY_WALLET or TARGET_ADDRESS is not defined');
        return;
    }

    const { asset, conditionId, outcomeIndex, title, outcome, avgPrice, curPrice, changeType, sizeChange, usdcSize } = change;

    try {
        // Calculate what the bot should do
        const botTrade = calculateBotTrade(
            sizeChange,
            usdcSize,
            asset,
            title,
            outcome
        );

        if (!botTrade.shouldTrade) {
            console.log(`\n[EXECUTOR] ⏭️  Skipped: ${title} - ${outcome}`);
            console.log(`[EXECUTOR]    Reason: ${botTrade.reason}\n`);
            return;
        }

        // Log the action we're about to take
        console.log('\n[EXECUTOR] ' + '='.repeat(70));
        console.log(`[EXECUTOR] 🎯 Target Trade Detected (${changeType.toUpperCase()}):`);
        console.log(`[EXECUTOR]    Market: ${title}`);
        console.log(`[EXECUTOR]    Outcome: ${outcome}`);
        console.log(`[EXECUTOR]    Target's Change: ${sizeChange > 0 ? '+' : ''}${sizeChange} shares`);
        console.log('[EXECUTOR] ' + '='.repeat(70));

        console.log(`[EXECUTOR] \n💡 Bot Decision: ${botTrade.reason}`);
        
        // Get current bot position
        const currentBotPosition = getBotPosition(asset);
        console.log(`[EXECUTOR] 📊 Bot's Current Position: ${currentBotPosition} shares`);
        console.log(`[EXECUTOR] 💵 Target's USD Amount: $${Math.abs(usdcSize).toFixed(2)}`);

        // Check balance before trading
        const my_balance = await getMyBalance(PROXY_WALLET);
        console.log(`[EXECUTOR] 💰 Bot Balance: $${my_balance.toFixed(2)} USDC`);

        // Use the USD amount from botTrade (actual from activity API)
        const estimatedCost = botTrade.usdAmount;

        // Check if order exceeds MAX_ORDER_AMOUNT limit
        if (botTrade.action === 'BUY' && estimatedCost > MAX_ORDER_AMOUNT) {
            console.log(`[EXECUTOR] \n⚠️ TRADE SKIPPED - EXCEEDS MAX ORDER AMOUNT`);
            console.log(`[EXECUTOR]    Market: ${title} - ${outcome}`);
            console.log(`[EXECUTOR]    Action: ${botTrade.action} ${botTrade.shares} shares`);
            console.log(`[EXECUTOR]    Estimated Cost: $${estimatedCost.toFixed(2)}`);
            console.log(`[EXECUTOR]    Max Allowed: $${MAX_ORDER_AMOUNT.toFixed(2)}`);
            console.log(`[EXECUTOR]    Exceeded By: $${(estimatedCost - MAX_ORDER_AMOUNT).toFixed(2)}\n`);
            console.log('[EXECUTOR] ' + '='.repeat(70) + '\n');
            return;
        }

        // Check 24-hour spending limit
        if (botTrade.action === 'BUY') {
            const spentLast24h = await getSpendingLast24Hours();
            const projectedSpend = spentLast24h + estimatedCost;
            
            if (projectedSpend > MAX_SPEND_24H) {
                console.log(`[EXECUTOR] \n⚠️ TRADE SKIPPED - EXCEEDS 24-HOUR SPEND LIMIT`);
                console.log(`[EXECUTOR]    Market: ${title} - ${outcome}`);
                console.log(`[EXECUTOR]    Action: ${botTrade.action} ${botTrade.shares} shares`);
                console.log(`[EXECUTOR]    Trade Cost: $${estimatedCost.toFixed(2)}`);
                console.log(`[EXECUTOR]    Already Spent (24h): $${spentLast24h.toFixed(2)}`);
                console.log(`[EXECUTOR]    Projected Total: $${projectedSpend.toFixed(2)}`);
                console.log(`[EXECUTOR]    24h Limit: $${MAX_SPEND_24H.toFixed(2)}`);
                console.log(`[EXECUTOR]    Would Exceed By: $${(projectedSpend - MAX_SPEND_24H).toFixed(2)}\n`);
                console.log('[EXECUTOR] ' + '='.repeat(70) + '\n');
                return;
            }
            
            // Log remaining budget
            const remainingBudget = MAX_SPEND_24H - spentLast24h;
            console.log(`[EXECUTOR] 💳 24h Spending: $${spentLast24h.toFixed(2)} / $${MAX_SPEND_24H.toFixed(2)} (${remainingBudget.toFixed(2)} remaining)`);
        }

        if (!DRY_RUN && botTrade.action === 'BUY' && estimatedCost > my_balance) {
            console.log(`[EXECUTOR] \n❌ INSUFFICIENT BALANCE!`);
            console.log(`[EXECUTOR]    Need: ~$${estimatedCost.toFixed(2)}`);
            console.log(`[EXECUTOR]    Have: $${my_balance.toFixed(2)}`);
            console.log(`[EXECUTOR]    Missing: $${(estimatedCost - my_balance).toFixed(2)}\n`);
            console.log('[EXECUTOR] ' + '='.repeat(70) + '\n');
            return;
        }

        // Execute or simulate the trade
        let tradeSuccess = true;

        if (DRY_RUN) {
            console.log(`[EXECUTOR] \n🔷 DRY RUN MODE`);
            console.log(`[EXECUTOR]    Action: ${botTrade.action}`);
            console.log(`[EXECUTOR]    Size: ${botTrade.shares} shares`);
            console.log(`[EXECUTOR]    USD Amount: $${botTrade.usdAmount.toFixed(2)}`);
            
            if (botTrade.action === 'BUY' && estimatedCost > my_balance) {
                console.log(`[EXECUTOR]    ⚠️ Note: Would need $${estimatedCost.toFixed(2)} but only have $${my_balance.toFixed(2)}`);
            }
        } else {
            console.log(`[EXECUTOR] \n🚀 Executing Trade:`);
            console.log(`[EXECUTOR]    Action: ${botTrade.action}`);
            console.log(`[EXECUTOR]    Size: ${botTrade.shares} shares`);
            console.log(`[EXECUTOR]    USD Amount: $${botTrade.usdAmount.toFixed(2)}`);

            const result = await executeOrder(
                clobClient,
                asset,
                botTrade.action,
                botTrade.usdAmount
            );

            tradeSuccess = result.success;
            
            if (!result.success) {
                console.log(`[EXECUTOR] \n❌ TRADE FAILED`);
                console.log(`[EXECUTOR]    Error: ${result.error}`);
                console.log('[EXECUTOR] ' + '='.repeat(70) + '\n');
                return;
            }
        }

        // Update bot's position (for both dry run and live)
        if (tradeSuccess) {
            const actualSizeChange = botTrade.action === 'BUY' ? botTrade.shares : -botTrade.shares;
            const newSize = await updateBotPosition(
                asset,
                conditionId,
                outcomeIndex,
                actualSizeChange,
                title,
                outcome
            );

            // Record spending for BUY orders (both dry run and live for tracking)
            if (botTrade.action === 'BUY') {
                await recordSpending(estimatedCost, asset, title, outcome);
            }

            if (DRY_RUN) {
                console.log(`[EXECUTOR] \n✅ SIMULATED SUCCESSFULLY`);
            } else {
                console.log(`[EXECUTOR] \n✅ TRADE EXECUTED SUCCESSFULLY`);
            }
            console.log(`[EXECUTOR]    Bot's New Position: ${newSize} shares`);
            console.log(`[EXECUTOR]    Position Change: ${actualSizeChange > 0 ? '+' : ''}${actualSizeChange}`);
        }

        console.log('[EXECUTOR] ' + '='.repeat(70) + '\n');

    } catch (error) {
        console.error('[EXECUTOR] \n❌ ERROR PROCESSING POSITION CHANGE');
        console.error(`[EXECUTOR]    Market: ${title} - ${outcome}`);
        console.error(`[EXECUTOR]    Error: ${error}`);
        console.error('[EXECUTOR] ' + '='.repeat(70) + '\n');
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    // Initialize bot positions first
    if (!isInitialized) {
        await initializeBotPositions();
    }

    if (DRY_RUN) {
        console.log(`🔷🔷🔷 DRY RUN MODE ENABLED 🔷🔷🔷`);
        console.log(`Orders will be simulated but NOT actually executed\n`);
    }
    console.log(`🎧 Trade Executor listening for position changes...\n`);

    // Queue to process events sequentially
    const eventQueue: PositionChangeEvent[] = [];
    let isProcessing = false;

    const processQueue = async () => {
        if (isProcessing || eventQueue.length === 0) return;
        
        isProcessing = true;
        while (eventQueue.length > 0) {
            const change = eventQueue.shift()!;
            await processPositionChange(clobClient, change);
        }
        isProcessing = false;
        
        // Add separator after all trades in batch are processed
        console.log('🔄 ' + '━'.repeat(68) + ' 🔄\n');
    };

    // Listen for position change events from tradeMonitor
    positionChangeEmitter.onPositionChange((change: PositionChangeEvent) => {
        eventQueue.push(change);
        processQueue(); // Process queue sequentially
    });

    // Keep the process alive (event-driven now, no polling loop)
    console.log(`✅ Event listener registered. Waiting for position changes...\n`);
};

// Export initialization function for external use
export const initializeExecutor = initializeBotPositions;

export default tradeExecutor;
