import moment from 'moment';
import { ENV } from '../config/env';
import { UserPositionInterface } from '../interfaces/User';
import { getUserPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchPositions from '../utils/fetchPositions';
import APIRateLimiter from '../utils/apiRateLimiter';
import { positionChangeEmitter, PositionChangeEvent } from './positionChangeEmitter';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!TARGET_ADDRESS) {
    throw new Error('TARGET_ADDRESS is not defined');
    console.log('TARGET_ADDRESS is not defined');
}

// Initialize rate limiter (only positions API now)
const positionsRateLimiter = new APIRateLimiter('Positions', 150);

const UserPosition = getUserPositionModel(TARGET_ADDRESS);
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

let isInitialized = false;
let previousTargetPositions: Map<string, UserPositionInterface> = new Map(); // Previous poll snapshot
let currentTargetPositions: Map<string, UserPositionInterface> = new Map(); // Current positions

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
        
        console.log(`✅ Snapshot complete. Bot will only copy NEW position changes from now on.\n`);
    } else {
        console.log('✅ Initial positions already saved. Resuming from previous state.\n');
        
        // Load current positions
        await fetchPositionData();
    }
    
    // Copy current to previous for first comparison
    previousTargetPositions = new Map(currentTargetPositions);
    
    isInitialized = true;
};

const fetchPositionData = async () => {
    try {
        // Fetch target positions from Polymarket API
        positionsRateLimiter.track();
        const userPositions: UserPositionInterface[] = await fetchPositions(TARGET_ADDRESS);

        // Store previous positions before updating
        previousTargetPositions = new Map(currentTargetPositions);

        currentTargetPositions.clear();

        // Update positions in database and current map
        for (const position of userPositions) {
            // Skip resolved positions (can't trade on resolved markets)
            if (position.redeemable) {
                console.log(`⏭️  Skipping resolved position: ${position.title} - ${position.outcome}`);
                continue;
            }

            await UserPosition.findOneAndUpdate(
                { asset: position.asset },
                { ...position },
                { upsert: true, new: true }
            );

            const previousSize = previousTargetPositions.get(position.asset)?.size || 0;
            const currentSize = position.size;
            const delta = currentSize - previousSize;

            // Save initial position if this is the first time we're seeing this asset
            if (!previousTargetPositions.has(position.asset)) {
                const existingInitial = await InitialTargetPosition.findOne({ asset: position.asset }).exec();
                if (!existingInitial) {
                    const startTimestamp = Math.floor(Date.now() / 1000);
                    await new InitialTargetPosition({
                        conditionId: position.conditionId,
                        asset: position.asset,
                        size: 0, // New position after bot started - initial is 0
                        outcomeIndex: position.outcomeIndex,
                        startTimestamp: startTimestamp,
                    }).save();
                }
            }

            // Emit position change events and log
            if (Math.abs(delta) > 0.0001) {
                let changeType: 'new' | 'increase' | 'decrease' | 'closed';
                
                if (!previousTargetPositions.has(position.asset)) {
                    changeType = 'new';
                    console.log(`🆕 New position opened: ${position.title} - ${position.outcome}: ${currentSize} shares`);
                } else if (delta > 0) {
                    changeType = 'increase';
                    console.log(`🟢 Position increased: ${position.title} - ${position.outcome}: ${previousSize} → ${currentSize} (+${delta.toFixed(4)})`);
                } else {
                    changeType = 'decrease';
                    console.log(`🔴 Position decreased: ${position.title} - ${position.outcome}: ${previousSize} → ${currentSize} (${delta.toFixed(4)})`);
                }

                // Emit event for trade executor
                const changeEvent: PositionChangeEvent = {
                    asset: position.asset,
                    previousSize,
                    currentSize,
                    delta,
                    position,
                    changeType
                };
                positionChangeEmitter.emitPositionChange(changeEvent);
            }

            // Update current positions map
            currentTargetPositions.set(position.asset, position);
        }

        // Detect closed positions
        for (const [asset, previousPosition] of previousTargetPositions.entries()) {
            if (!userPositions.find(p => p.asset === asset)) {
                console.log(`❌ Position closed: ${previousPosition.title} - ${previousPosition.outcome}`);
                
                // Create a modified position object with size = 0 to represent closure
                const closedPosition: UserPositionInterface = {
                    ...previousPosition,
                    size: 0
                };
                
                // Emit closed position event
                const changeEvent: PositionChangeEvent = {
                    asset,
                    previousSize: previousPosition.size,
                    currentSize: 0,
                    delta: -previousPosition.size,
                    position: closedPosition,  // Send modified position with size = 0
                    changeType: 'closed'
                };
                positionChangeEmitter.emitPositionChange(changeEvent);
                
                currentTargetPositions.delete(asset);
            }
        }


    } catch (error) {
        console.error('Error fetching position data:', error);
    }
};

const tradeMonitor = async () => {
    // Check if already initialized (by external call to initializeMonitor)
    if (!isInitialized) {
        console.log('Trade Monitor is initializing...');
        await init();
    }
    
    console.log('Position Monitor is running every', FETCH_INTERVAL, 'seconds');
    console.log('Tracking position changes via Positions API only\n');

    // Start monitoring loop
    while (true) {
        await fetchPositionData();
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
