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

        for (const trade of newTrades) {
            // Update last processed timestamp
            lastProcessedActivityTimestamp = Math.max(lastProcessedActivityTimestamp, trade.timestamp);

            // Get current position for this asset
            const currentPosition = currentTargetPositions.get(trade.asset);
            const previousSize = currentPosition?.size || 0;

            // Calculate new size based on trade
            let newSize = previousSize;
            if (trade.side === 'BUY') {
                newSize = previousSize + trade.size;
            } else if (trade.side === 'SELL') {
                newSize = Math.max(0, previousSize - trade.size);
            }

            const delta = newSize - previousSize;

            // Save initial position if this is first time seeing this asset
            if (!currentPosition) {
                const existingInitial = await InitialTargetPosition.findOne({ asset: trade.asset }).exec();
                if (!existingInitial) {
                    const startTimestamp = Math.floor(Date.now() / 1000);
                    await new InitialTargetPosition({
                        conditionId: trade.conditionId,
                        asset: trade.asset,
                        size: 0, // New position after bot started - initial is 0
                        outcomeIndex: trade.outcomeIndex,
                        startTimestamp: startTimestamp,
                    }).save();
                }
            }

            // Determine change type
            let changeType: 'new' | 'increase' | 'decrease' | 'closed';
            if (!currentPosition && newSize > 0) {
                changeType = 'new';
                console.log(`🆕 New position opened: ${trade.title} - ${trade.outcome}: ${newSize} shares (${trade.side} ${trade.size})`);
            } else if (newSize === 0) {
                changeType = 'closed';
                console.log(`❌ Position closed: ${trade.title} - ${trade.outcome} (SOLD ${trade.size})`);
            } else if (delta > 0) {
                changeType = 'increase';
                console.log(`🟢 Position increased: ${trade.title} - ${trade.outcome}: ${previousSize} → ${newSize} (+${delta.toFixed(4)})`);
            } else {
                changeType = 'decrease';
                console.log(`🔴 Position decreased: ${trade.title} - ${trade.outcome}: ${previousSize} → ${newSize} (${delta.toFixed(4)})`);
            }

            // Create position object for the event
            const positionForEvent: UserPositionInterface = currentPosition ? {
                ...currentPosition,
                size: newSize
            } : {
                asset: trade.asset,
                conditionId: trade.conditionId,
                size: newSize,
                title: trade.title,
                outcome: trade.outcome,
                outcomeIndex: trade.outcomeIndex,
                avgPrice: trade.price,
                curPrice: trade.price,
                redeemable: false,
            } as any;

            // Emit event for trade executor
            const changeEvent: PositionChangeEvent = {
                asset: trade.asset,
                previousSize,
                currentSize: newSize,
                delta,
                position: positionForEvent,
                changeType
            };
            positionChangeEmitter.emitPositionChange(changeEvent);

            // Update our local tracking
            if (newSize > 0) {
                currentTargetPositions.set(trade.asset, positionForEvent);
            } else {
                currentTargetPositions.delete(trade.asset);
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
