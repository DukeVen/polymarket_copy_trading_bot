import moment from 'moment';
import { ENV } from '../config/env';
import { UserPositionInterface, UserActivityInterface } from '../interfaces/User';
import { getUserPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchPositions from '../utils/fetchPositions';
import fetchData from '../utils/fetchData';
import APIRateLimiter from '../utils/apiRateLimiter';
import { positionChangeEmitter, PositionChangeEvent } from './positionChangeEmitter';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!TARGET_ADDRESS) {
    throw new Error('TARGET_ADDRESS is not defined');
    console.log('TARGET_ADDRESS is not defined');
}

// Initialize rate limiters
const positionsRateLimiter = new APIRateLimiter('Positions', 150);
const activitiesRateLimiter = new APIRateLimiter('Activities', 200);

const UserPosition = getUserPositionModel(TARGET_ADDRESS);
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

let isInitialized = false;
let currentTargetPositions: Map<string, UserPositionInterface> = new Map(); // Track current positions
let lastProcessedActivityTimestamp = 0; // Track last activity we've processed

const init = async () => {
    // Check if we've already saved initial positions
    const existingInitialPositions = await InitialTargetPosition.find().exec();
    
    if (existingInitialPositions.length === 0) {
        console.log('📸 Taking snapshot of target\'s initial positions...');
        
        // Fetch and save target's current positions as initial state
        positionsRateLimiter.track();
        const userPositions: UserPositionInterface[] = await fetchPositions(TARGET_ADDRESS);
        console.log(`✅ Fetched ${userPositions.length} positions from API\n`);
            
        
        const startTimestamp = Math.floor(Date.now() / 1000);
        
        for (const position of userPositions) {
            const initialPosition = new InitialTargetPosition({
                conditionId: position.conditionId,
                asset: position.asset,
                size: position.size,
                outcomeIndex: position.outcomeIndex,
                startTimestamp: startTimestamp,
            });
            await initialPosition.save();
            console.log(`  ✓ Saved initial position: ${position.title} - ${position.outcome}: ${position.size} shares`);
            
            // Store in current positions map
            currentTargetPositions.set(position.asset, position);
        }
        
        console.log(`✅ Snapshot complete. Bot will track trades from Activities API.\n`);
    } else {
        console.log('✅ Initial positions already saved. Resuming from previous state.\n');
        
        // Load current positions from Positions API
        positionsRateLimiter.track();
        const userPositions: UserPositionInterface[] = await fetchPositions(TARGET_ADDRESS);
        for (const position of userPositions) {
            currentTargetPositions.set(position.asset, position);
        }
    }
    
    // Set last processed timestamp to now (only process new activities going forward)
    lastProcessedActivityTimestamp = Math.floor(Date.now() / 1000);
    
    isInitialized = true;
};

const fetchActivitiesAndProcessTrades = async () => {
    try {
        // Fetch recent activities from Polymarket API
        activitiesRateLimiter.track();
        const activities: UserActivityInterface[] = await fetchData(
            `https://data-api.polymarket.com/activity?user=${TARGET_ADDRESS}&limit=100&_=${Date.now()}`
        );

        if (activities.length === 0) {
            return;
        }

        // Filter to only TRADE activities that are newer than last processed
        const newTrades = activities
            .filter(a => a.type === 'TRADE' && a.timestamp > lastProcessedActivityTimestamp)
            .sort((a, b) => a.timestamp - b.timestamp); // Process oldest first

        if (newTrades.length === 0) {
            return;
        }

        // Group all new trades by asset - process the net change per asset
        const tradesByAsset = new Map<string, UserActivityInterface[]>();
        for (const trade of newTrades) {
            if (!tradesByAsset.has(trade.asset)) {
                tradesByAsset.set(trade.asset, []);
            }
            tradesByAsset.get(trade.asset)!.push(trade);
            // Update last processed timestamp
            lastProcessedActivityTimestamp = Math.max(lastProcessedActivityTimestamp, trade.timestamp);
        }

        // Process each asset's trades as a single net change
        for (const [asset, trades] of tradesByAsset) {
            const firstTrade = trades[0];
            const lastTrade = trades[trades.length - 1];

            // Get current tracked position BEFORE any of these trades
            const currentPosition = currentTargetPositions.get(asset);
            const previousSize = currentPosition?.size || 0;

            // Save initial position if this is first time seeing this asset
            if (!currentPosition) {
                const existingInitial = await InitialTargetPosition.findOne({ asset }).exec();
                if (!existingInitial) {
                    const startTimestamp = Math.floor(Date.now() / 1000);
                    await new InitialTargetPosition({
                        conditionId: firstTrade.conditionId,
                        asset: asset,
                        size: previousSize,
                        outcomeIndex: firstTrade.outcomeIndex,
                        startTimestamp: startTimestamp,
                    }).save();
                }
            }

            // Calculate net size change from all trades for this asset
            let netSizeChange = 0;
            let totalBuySize = 0;
            let totalSellSize = 0;
            let weightedPriceSum = 0;

            for (const trade of trades) {
                if (trade.side === 'BUY') {
                    netSizeChange += trade.size;
                    totalBuySize += trade.size;
                } else if (trade.side === 'SELL') {
                    netSizeChange -= trade.size;
                    totalSellSize += trade.size;
                }
                weightedPriceSum += trade.price * trade.size;
            }

            const avgPrice = (totalBuySize + totalSellSize) > 0 ? weightedPriceSum / (totalBuySize + totalSellSize) : lastTrade.price;
            
            // Round to avoid floating point precision issues (round to 6 decimals)
            let newSize = Math.max(0, previousSize + netSizeChange);
            newSize = Math.round(newSize * 1000000) / 1000000;
            
            // Treat very small positions as fully closed
            if (newSize < 0.01) {
                newSize = 0;
            }
            
            const delta = newSize - previousSize;

            // Determine change type and log
            let changeType: 'new' | 'increase' | 'decrease' | 'closed';
            const tradeInfo = trades.length > 1 ? ` (${trades.length} trades combined)` : '';
            
            if (!currentPosition && newSize > 0) {
                changeType = 'new';
                console.log(`🆕 New position opened: ${firstTrade.title} - ${firstTrade.outcome}: ${newSize} shares${tradeInfo}`);
            } else if (newSize === 0) {
                changeType = 'closed';
                console.log(`❌ Position closed: ${firstTrade.title} - ${firstTrade.outcome}${tradeInfo}`);
            } else if (delta > 0) {
                changeType = 'increase';
                console.log(`🟢 Position increased: ${firstTrade.title} - ${firstTrade.outcome}: ${previousSize} → ${newSize} (+${delta.toFixed(4)})${tradeInfo}`);
            } else if (delta < 0) {
                changeType = 'decrease';
                console.log(`🔴 Position decreased: ${firstTrade.title} - ${firstTrade.outcome}: ${previousSize} → ${newSize} (${delta.toFixed(4)})${tradeInfo}`);
            } else {
                // No net change (e.g., bought 10 then sold 10)
                continue; // Skip emitting event
            }

            // Create position object for the event
            const positionForEvent: UserPositionInterface = currentPosition ? {
                ...currentPosition,
                size: newSize,
                avgPrice: avgPrice,
                curPrice: avgPrice,
            } : {
                asset: asset,
                conditionId: firstTrade.conditionId,
                size: newSize,
                title: firstTrade.title,
                outcome: firstTrade.outcome,
                outcomeIndex: firstTrade.outcomeIndex,
                avgPrice: avgPrice,
                curPrice: avgPrice,
                redeemable: false,
            } as any;

            // Emit single event for the net change in this asset
            const changeEvent: PositionChangeEvent = {
                asset: asset,
                previousSize,
                currentSize: newSize,
                delta,
                position: positionForEvent,
                changeType
            };
            positionChangeEmitter.emitPositionChange(changeEvent);

            // Update our local tracking
            if (newSize > 0) {
                currentTargetPositions.set(asset, positionForEvent);
            } else {
                currentTargetPositions.delete(asset);
            }
        }

    } catch (error) {
        console.error('Error fetching activities:', error);
    }
};

const tradeMonitor = async () => {
    // Check if already initialized (by external call to initializeMonitor)
    if (!isInitialized) {
        console.log('Trade Monitor is initializing...');
        await init();
    }
    
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    console.log('Tracking trades via Activities API (no flickers!)\n');

    // Start monitoring loop
    while (true) {
        await fetchActivitiesAndProcessTrades();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

// Export init function for manual initialization
export const initializeMonitor = init;

// Export functions to get initial and current target positions
export const getInitialTargetPosition = async (asset: string) => {
    const initialPos = await InitialTargetPosition.findOne({ asset }).exec();
    return initialPos ? initialPos.size : 0;
};

export const getCurrentTargetPosition = (asset: string): number => {
    const position = currentTargetPositions.get(asset);
    return position ? position.size : 0;
};

export default tradeMonitor;
