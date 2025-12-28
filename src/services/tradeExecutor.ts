import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface, BotPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel, getBotPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import { getInitialTargetPosition } from './tradeMonitor';
import APIRateLimiter from '../utils/apiRateLimiter';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const DRY_RUN = ENV.DRY_RUN;

let target_activities: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(TARGET_ADDRESS);
const BotPosition = getBotPositionModel();
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

// Initialize rate limiters
const positionsRateLimiter = new APIRateLimiter('Positions', 150);
const tradesRateLimiter = new APIRateLimiter('Trades/Activities', 200);

// Fetch all target positions from API
const fetchTargetPositions = async (): Promise<UserPositionInterface[]> => {
    try {
        positionsRateLimiter.track();
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${TARGET_ADDRESS}`
        );
        return positions;
    } catch (error) {
        console.error('⚠️ Error fetching positions from API:', error);
        console.error('   Error details:', String(error));
        return [];
    }
};

// Get target position for a specific asset
const getFreshTargetPosition = async (asset: string, positions?: UserPositionInterface[]): Promise<number> => {
    try {
        // If positions data is provided, use it instead of fetching from API
        if (positions) {
            const position = positions.find(p => p.asset === asset);
            const size = position ? position.size : 0;
            return size;
        }
        
        console.log(`   [Fetching API...]`);
        const fetchedPositions = await fetchTargetPositions();
        
        const position = fetchedPositions.find(p => p.asset === asset);
        const size = position ? position.size : 0;
        console.log(`   [Fresh API] Asset ${asset.substring(0, 10)}... current: ${size} shares`);
        return size;
    } catch (error) {
        console.error('⚠️ Error getting target position:', error);
        return 0;
    }
};

// Execute a simple market order
const executeOrder = async (
    clobClient: ClobClient,
    tokenID: string,
    side: 'BUY' | 'SELL',
    size: number,
    targetPrice: number
): Promise<{ success: boolean; error?: string }> => {
    try {
        const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
        
        const order_args = {
            side: orderSide,
            tokenID: tokenID,
            amount: size,
            price: targetPrice,
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

const readTargetTrade = async () => {
    // Note: This reads from MongoDB, not the Polymarket API
    // The tradeMonitor service handles API calls for activities/trades
    target_activities = (
        await UserActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: { $lt: RETRY_LIMIT } }],
        })
        .sort({ timestamp: 1 })  // Sort by timestamp ascending (oldest first)
        .exec()
    ).map((trade) => trade as UserActivityInterface);
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

// Calculate what trade the bot should make based on target's trade
const calculateBotTrade = async (trade: UserActivityInterface, positions?: UserPositionInterface[]): Promise<{
    shouldTrade: boolean;
    action: 'BUY' | 'SELL';
    size: number;
    reason: string;
}> => {
    const { asset, side, size: tradeSize } = trade;
    
    // Get initial target position (what they had when bot started)
    let initialTargetSize = await getInitialTargetPosition(asset);
    
    // If no initial position exists for this asset, save it as 0 (new position after bot started)
    if (initialTargetSize === 0) {
        const existingInitial = await InitialTargetPosition.findOne({ asset }).exec();
        if (!existingInitial) {
            const startTimestamp = Math.floor(Date.now() / 1000);
            await new InitialTargetPosition({
                conditionId: trade.conditionId,
                asset: asset,
                size: 0,
                outcomeIndex: trade.outcomeIndex,
                startTimestamp: startTimestamp,
            }).save();
            console.log(`   📌 New asset detected, setting initial position to 0`);
        }
    }
    
    // Get FRESH current target position (use provided positions data if available)
    const currentTargetSize = await getFreshTargetPosition(asset, positions);
    
    // Get bot's current position
    const botCurrentSize = await getBotPosition(asset);
    
    // Calculate what the bot's target position should be
    // Bot should mirror the CHANGE from initial position
    const targetChange = currentTargetSize - initialTargetSize;
    const botTargetSize = Math.max(0, targetChange); // Can't have negative positions
    
    // Calculate what trade bot needs to make
    // Round to avoid floating point precision issues
    const botSizeChange = Math.round((botTargetSize - botCurrentSize) * 1000000) / 1000000;
    
    console.log(`\n📊 Position Analysis for ${trade.title} - ${trade.outcome}:`);
    console.log(`   Target initial: ${initialTargetSize} shares`);
    console.log(`   Target current: ${currentTargetSize} shares`);
    console.log(`   Target change: ${targetChange > 0 ? '+' : ''}${targetChange}`);
    console.log(`   Bot current: ${botCurrentSize} shares`);
    console.log(`   Bot should have: ${botTargetSize} shares`);
    console.log(`   Bot needs to: ${botSizeChange > 0 ? 'BUY' : 'SELL'} ${Math.abs(botSizeChange)} shares`);
    
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

const doTrading = async (clobClient: ClobClient) => {
    if (!PROXY_WALLET || !TARGET_ADDRESS) {
        console.error('PROXY_WALLET or TARGET_ADDRESS is not defined');
        return;
    }
    
    // Fetch target's current positions ONCE before processing the batch
    // This avoids rate limiting since these are historical trades already reflected in the API
    console.log('\n📡 Fetching target\'s current positions...');
    const targetPositions = await fetchTargetPositions();
    console.log(`✅ Fetched ${targetPositions.length} positions from API\n`);
    
    for (const trade of target_activities) {
        console.log('\n' + '='.repeat(60));
        console.log(`🔍 Processing target's trade:`);
        console.log(`   ${trade.title} - ${trade.outcome}`);
        console.log(`   Target ${trade.side}: ${trade.size} shares @ $${trade.price}`);
        console.log('='.repeat(60));
        
        try {
            // Calculate what the bot should do (pass positions data to avoid API calls)
            const botTrade = await calculateBotTrade(trade, targetPositions);
            
            console.log(`\n💡 Decision: ${botTrade.reason}`);
            
            if (!botTrade.shouldTrade) {
                console.log('⏭️  Skipping this trade.\n');
                
                // Mark as processed even though we didn't trade
                await UserActivity.findOneAndUpdate(
                    { transactionHash: trade.transactionHash },
                    { bot: true, botExcutedTime: Date.now() }
                );
                
                continue;
            }
            
            // Check balance before trading
            const my_balance = await getMyBalance(PROXY_WALLET);
            console.log(`\n💰 Bot balance: $${my_balance.toFixed(2)} USDC`);
            
            const estimatedCost = botTrade.size * trade.price;
            
            if (botTrade.action === 'BUY' && estimatedCost > my_balance) {
                console.log(`⚠️ Insufficient balance! Need ~$${estimatedCost.toFixed(2)}, have $${my_balance.toFixed(2)}`);
                
                // Increment retry counter
                await UserActivity.findOneAndUpdate(
                    { transactionHash: trade.transactionHash },
                    { $inc: { botExcutedTime: 1 } }
                );
                
                continue;
            }
            
            // Execute or simulate the trade
            let tradeSuccess = true;
            
            if (ENV.DRY_RUN) {
                console.log(`\n🔷 DRY RUN: Would ${botTrade.action} ${botTrade.size} shares @ ~$${trade.price}`);
                console.log(`   Estimated cost: $${estimatedCost.toFixed(2)}`);
            } else {
                console.log(`\n🚀 Executing ${botTrade.action}: ${botTrade.size} shares @ ~$${trade.price}`);
                
                const result = await executeOrder(
                    clobClient,
                    trade.asset,
                    botTrade.action,
                    botTrade.size,
                    trade.price
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
                    trade.asset,
                    trade.conditionId,
                    trade.outcomeIndex,
                    sizeChange,
                    trade.title,
                    trade.outcome
                );
                
                if (ENV.DRY_RUN) {
                    console.log(`   Bot's simulated new position: ${newSize} shares`);
                } else {
                    console.log(`✅ Trade executed successfully!`);
                    console.log(`   Bot's new position: ${newSize} shares`);
                }
            }
            
            // Mark as processed
            await UserActivity.findOneAndUpdate(
                { transactionHash: trade.transactionHash },
                { bot: true, botExcutedTime: Date.now() }
            );
            
        } catch (error) {
            console.error('❌ Error processing trade:', error);
            
            // Increment retry counter
            await UserActivity.findOneAndUpdate(
                { transactionHash: trade.transactionHash },
                { $inc: { botExcutedTime: 1 } }
            );
        }
        
        console.log(''); // Empty line for spacing
    }
};

const tradeExcutor = async (clobClient: ClobClient) => {
    if (ENV.DRY_RUN) {
        console.log(`\n🔷🔷🔷 DRY RUN MODE ENABLED 🔷🔷🔷`);
        console.log(`Orders will be simulated but NOT actually executed\n`);
    }
    console.log(`Executing Copy Trading\n`);

    while (true) {
        await readTargetTrade();
        if (target_activities.length > 0) {
            console.log('💥 New transactions found 💥:', target_activities.length);
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }
        
        // Add delay between checks
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeExcutor;
