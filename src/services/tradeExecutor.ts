import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface, BotPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel, getBotPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import { getInitialTargetPosition, getCurrentTargetPosition } from './tradeMonitor';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const DRY_RUN = ENV.DRY_RUN;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);
const BotPosition = getBotPositionModel();
const InitialTargetPosition = getInitialTargetPositionModel(USER_ADDRESS);

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

const readTempTrade = async () => {
    temp_trades = (
        await UserActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: { $lt: RETRY_LIMIT } }],
        }).exec()
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
const calculateBotTrade = async (trade: UserActivityInterface): Promise<{
    shouldTrade: boolean;
    action: 'BUY' | 'SELL';
    size: number;
    reason: string;
}> => {
    const { asset, side, size: tradeSize } = trade;
    
    // Get initial target position (what they had when bot started)
    const initialTargetSize = await getInitialTargetPosition(asset);
    
    // Get current target position (what they have now)
    const currentTargetSize = getCurrentTargetPosition(asset);
    
    // Get bot's current position
    const botCurrentSize = await getBotPosition(asset);
    
    // Calculate what the bot's target position should be
    // Bot should mirror the CHANGE from initial position
    const targetChange = currentTargetSize - initialTargetSize;
    const botTargetSize = Math.max(0, targetChange); // Can't have negative positions
    
    // Calculate what trade bot needs to make
    const botSizeChange = botTargetSize - botCurrentSize;
    
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
    if (!PROXY_WALLET || !USER_ADDRESS) {
        console.error('PROXY_WALLET or USER_ADDRESS is not defined');
        return;
    }
    
    for (const trade of temp_trades) {
        console.log('\n' + '='.repeat(60));
        console.log(`🔍 Processing target's trade:`);
        console.log(`   ${trade.title} - ${trade.outcome}`);
        console.log(`   Target ${trade.side}: ${trade.size} shares @ $${trade.price}`);
        console.log('='.repeat(60));
        
        try {
            // Calculate what the bot should do
            const botTrade = await calculateBotTrade(trade);
            
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
            
            if (ENV.DRY_RUN) {
                console.log(`\n🔷 DRY RUN: Would ${botTrade.action} ${botTrade.size} shares @ ~$${trade.price}`);
                console.log(`   Estimated cost: $${estimatedCost.toFixed(2)}`);
            } else {
                console.log(`\n🚀 Executing ${botTrade.action}: ${botTrade.size} shares @ ~$${trade.price}`);
                
                // Execute the trade
                const result = await executeOrder(
                    clobClient,
                    trade.asset,
                    botTrade.action,
                    botTrade.size,
                    trade.price
                );
                
                if (result.success) {
                    // Update bot's position
                    const sizeChange = botTrade.action === 'BUY' ? botTrade.size : -botTrade.size;
                    const newSize = await updateBotPosition(
                        trade.asset,
                        trade.conditionId,
                        trade.outcomeIndex,
                        sizeChange,
                        trade.title,
                        trade.outcome
                    );
                    
                    console.log(`✅ Trade executed successfully!`);
                    console.log(`   Bot's new position: ${newSize} shares`);
                } else {
                    console.log(`❌ Trade failed: ${result.error}`);
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
    console.log(`Executing Copy Trading`);

    while (true) {
        await readTempTrade();
        if (temp_trades.length > 0) {
            console.log('💥 New transactions found 💥');
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }
    }
};

export default tradeExcutor;
