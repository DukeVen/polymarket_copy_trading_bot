import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserPositionInterface, BotPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserPositionModel, getBotPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import getMyBalance from '../utils/getMyBalance';
import { getInitialTargetPosition } from './tradeMonitor';
import { positionChangeEmitter, PositionChangeEvent } from './positionChangeEmitter';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const DRY_RUN = ENV.DRY_RUN;

const UserPosition = getUserPositionModel(TARGET_ADDRESS);
const BotPosition = getBotPositionModel();
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

// Execute a simple market order
const executeOrder = async (
    clobClient: ClobClient,
    tokenID: string,
    side: 'BUY' | 'SELL',
    size: number
): Promise<{ success: boolean; error?: string }> => {
    try {
        const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
        
        const order_args = {
            side: orderSide,
            tokenID: tokenID,
            amount: size,
        };
        
        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
        
        if (resp.success === true) {
            return { success: true };
        } else {
            return { success: false, error: JSON.stringify(resp) };
        }
    } catch (error) {
        return { success: false, error: String(error) };
    }
};

// Get bot's current position for a specific asset
const getBotPosition = async (asset: string): Promise<number> => {
    const position = await BotPosition.findOne({ asset }).exec();
    return position ? position.size : 0;
};

// Update bot's position after a trade
const updateBotPosition = async (
    asset: string,
    conditionId: string,
    outcomeIndex: number,
    sizeChange: number,
    title: string,
    outcome: string
) => {
    const currentPosition = await BotPosition.findOne({ asset }).exec();
    const currentSize = currentPosition ? currentPosition.size : 0;
    const newSize = currentSize + sizeChange;
    
    await BotPosition.findOneAndUpdate(
        { asset },
        {
            asset,
            conditionId,
            outcomeIndex,
            size: newSize,
            title,
            outcome,
            lastUpdated: Math.floor(Date.now() / 1000),
        },
        { upsert: true, new: true }
    );
    
    return newSize;
};

// Calculate what trade the bot should make based on position delta
const calculateBotTrade = async (targetPosition: UserPositionInterface): Promise<{
    shouldTrade: boolean;
    action: 'BUY' | 'SELL';
    size: number;
    reason: string;
}> => {
    const { asset, size: currentTargetSize, title, outcome, conditionId, outcomeIndex } = targetPosition;
    
    // Get initial target position (what they had when bot started)
    let initialTargetSize = await getInitialTargetPosition(asset);

    // Get bot's current position
    const botCurrentSize = await getBotPosition(asset);
    
    // Calculate what the bot's target position should be
    // Bot should mirror the CHANGE from initial position
    const targetChange = currentTargetSize - initialTargetSize;
    const botTargetSize = Math.max(0, targetChange); // Can't have negative positions
    
    // Calculate what trade bot needs to make
    // Round to avoid floating point precision issues
    const botSizeChange = Math.round((botTargetSize - botCurrentSize) * 1000000) / 1000000;
    
    // Only log detailed analysis if there's a trade to make
    if (Math.abs(botSizeChange) >= 0.0001) {
        console.log(`\n📊 Position Analysis for ${title} - ${outcome}:`);
        console.log(`   Target initial: ${initialTargetSize} shares`);
        console.log(`   Target current: ${currentTargetSize} shares`);
        console.log(`   Target change: ${targetChange > 0 ? '+' : ''}${targetChange}`);
        console.log(`   Bot current: ${botCurrentSize} shares`);
        console.log(`   Bot should have: ${botTargetSize} shares`);
        console.log(`   Bot needs to: ${botSizeChange > 0 ? 'BUY' : 'SELL'} ${Math.abs(botSizeChange)} shares`);
    }
    
    if (Math.abs(botSizeChange) < 0.0001) {
        return {
            shouldTrade: false,
            action: 'BUY',
            size: 0,
            reason: 'Bot position is already in sync'
        };
    }
    
    if (botSizeChange > 0) {
        return {
            shouldTrade: true,
            action: 'BUY',
            size: botSizeChange,
            reason: `Buying ${botSizeChange} shares to match target's position change`
        };
    } else {
        // Selling - make sure we don't oversell
        const maxSellSize = Math.min(Math.abs(botSizeChange), botCurrentSize);
        
        if (maxSellSize === 0) {
            return {
                shouldTrade: false,
                action: 'SELL',
                size: 0,
                reason: 'Cannot sell - bot has no shares to sell'
            };
        }
        
        if (maxSellSize < Math.abs(botSizeChange)) {
            return {
                shouldTrade: true,
                action: 'SELL',
                size: maxSellSize,
                reason: `⚠️ Selling ${maxSellSize} shares (wanted ${Math.abs(botSizeChange)} but only have ${botCurrentSize})`
            };
        }
        
        return {
            shouldTrade: true,
            action: 'SELL',
            size: maxSellSize,
            reason: `Selling ${maxSellSize} shares to match target's position change`
        };
    }
};

// Process a single position change event
const processPositionChange = async (clobClient: ClobClient, change: PositionChangeEvent) => {
    if (!PROXY_WALLET || !TARGET_ADDRESS) {
        console.error('PROXY_WALLET or TARGET_ADDRESS is not defined');
        return;
    }

    const { position, changeType } = change;

    try {
        // Calculate what the bot should do
        const botTrade = await calculateBotTrade(position);

        if (!botTrade.shouldTrade) {
            return; // Skip silently if no action needed
        }

        // Only log if there's a meaningful action to execute
        console.log('\n' + '='.repeat(60));
        console.log(`🔍 Processing position change (${changeType}):`);
        console.log(`   ${position.title} - ${position.outcome}`);
        console.log(`   Target: ${position.size} shares @ avg $${position.avgPrice}`);
        console.log('='.repeat(60));

        console.log(`\n💡 Decision: ${botTrade.reason}`);

        // Check balance before trading (skip in dry run mode)
        const my_balance = await getMyBalance(PROXY_WALLET);
        console.log(`\n💰 Bot balance: $${my_balance.toFixed(2)} USDC`);

        // Estimate cost using current market price
        const estimatedCost = botTrade.size * position.curPrice;

        if (!ENV.DRY_RUN && botTrade.action === 'BUY' && estimatedCost > my_balance) {
            console.log(`⚠️ Insufficient balance! Need ~$${estimatedCost.toFixed(2)}, have $${my_balance.toFixed(2)}`);
            return;
        }

        // Execute or simulate the trade
        let tradeSuccess = true;

        if (ENV.DRY_RUN) {
            console.log(`\n🔷 DRY RUN: Would ${botTrade.action} ${botTrade.size} shares`);
            console.log(`   Market price: ~$${position.curPrice}`);
            console.log(`   Estimated cost: $${estimatedCost.toFixed(2)}`);
            if (botTrade.action === 'BUY' && estimatedCost > my_balance) {
                console.log(`   ⚠️ Note: Would need $${estimatedCost.toFixed(2)} but only have $${my_balance.toFixed(2)}`);
            }
        } else {
            console.log(`\n🚀 Executing ${botTrade.action}: ${botTrade.size} shares`);
            console.log(`   Market price: ~$${position.curPrice}`);

            const result = await executeOrder(
                clobClient,
                position.asset,
                botTrade.action,
                botTrade.size
            );

            tradeSuccess = result.success;
            if (!result.success) {
                console.log(`❌ Trade failed: ${result.error}`);
            }
        }

        // Update bot's position (for both dry run and live)
        if (tradeSuccess) {
            const sizeChange = botTrade.action === 'BUY' ? botTrade.size : -botTrade.size;
            const newSize = await updateBotPosition(
                position.asset,
                position.conditionId,
                position.outcomeIndex,
                sizeChange,
                position.title,
                position.outcome
            );

            if (ENV.DRY_RUN) {
                console.log(`   Bot's simulated new position: ${newSize} shares`);
            } else {
                console.log(`✅ Trade executed successfully!`);
                console.log(`   Bot's new position: ${newSize} shares`);
            }
        }

        console.log(''); // Empty line for spacing

    } catch (error) {
        console.error('❌ Error processing position change:', error);
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    if (ENV.DRY_RUN) {
        console.log(`\n🔷🔷🔷 DRY RUN MODE ENABLED 🔷🔷🔷`);
        console.log(`Orders will be simulated but NOT actually executed\n`);
    }
    console.log(`Trade Executor listening for position changes...\n`);

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
    };

    // Listen for position change events from tradeMonitor
    positionChangeEmitter.onPositionChange((change: PositionChangeEvent) => {
        eventQueue.push(change);
        processQueue(); // Process queue sequentially
    });

    // Keep the process alive (event-driven now, no polling loop)
    console.log(`✅ Event listener registered. Waiting for position changes...\n`);
};

export default tradeExecutor;
