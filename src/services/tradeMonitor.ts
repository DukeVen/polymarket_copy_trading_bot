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

// Position size thresholds
const POSITION_CLOSE_THRESHOLD = 0.01; // Positions below this are considered closed
const POSITION_CHANGE_THRESHOLD = 0.01; // Minimum delta to be considered a meaningful change
const PRECISION_MULTIPLIER = 10000; // For rounding to 4 decimal places

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
            const initialPosition = createNewTargetPosition(position, startTimestamp);
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
        // TODO might need adjusting?
        const newTrades = activities
            .filter(a => a.type === 'TRADE' && a.timestamp > lastProcessedActivityTimestamp)
            .sort((a, b) => a.timestamp - b.timestamp); // Process oldest first

        if (newTrades.length === 0) {
            return;
        }

        // Group all new trades by asset - process the net change per asset (aggregation)
        // TODO add aggregation time window?
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
        // asset = assetId
        // trades = array of trade activities for that asset
        for (const [asset, trades] of tradesByAsset) {
            const firstTrade = trades[0];
            const lastTrade = trades[trades.length - 1];

            // Calculate net size change from all trades
            let netSizeChange = calcNetSizeChange(trades);

            // Handle initial position tracking - check if we had this position in our tracking
            // If not, this means that it is a new position
            // ==> need to add this position to our current tracking map
            const wasTracked = currentTargetPositions.has(asset);


            // Get current tracked position - this is our source of truth
            // We CANNOT fetch from Positions API here because it may have newer data
            // than what Activities API has returned, causing incorrect calculations
            const currentPosition = currentTargetPositions.get(asset);
            let previousSize = currentPosition?.size || 0;
            previousSize = Math.round(previousSize * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;


            // Calculate new size and round to avoid floating point issues
            let newSize = Math.max(0, previousSize + netSizeChange);
            newSize = Math.round(newSize * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;

            // Treat very small positions as fully closed
            if (newSize < POSITION_CLOSE_THRESHOLD) {
                newSize = 0;
            }

            const delta = Math.round((newSize - previousSize) * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;

            // Determine change type and log
            let changeType = determineChangeType(trades, firstTrade, previousSize, newSize, delta, wasTracked);

            // TODO
            if (changeType === 'closed') {
                // Reset initial position to 0 when fully closed
                // This ensures if position reopens later, we track it from the reopening point
                await InitialTargetPosition.findOneAndUpdate(
                    { asset },
                    { size: 0 },
                    { upsert: true }
                );
            }

            if (changeType === 'none') {
                // No meaningful net change, skip emitting event
                continue;
            }


            let positionForEvent: UserPositionInterface;

            // Already existing position - just copy and adjust size
            if (wasTracked && currentPosition) {
                positionForEvent = {
                    ...currentPosition,
                    size: newSize,
                };
            } else {
                // New position - TODO
            
            }


            // Update our local tracking
            // Keep position in map even at small sizes to maintain tracking continuity
            // Only remove when actually closed (rounded to 0)
            if (newSize > 0) {
                currentTargetPositions.set(asset, positionForEvent);
            } else {
                currentTargetPositions.delete(asset);
            }


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
    console.log('Tracking trades via Activities API\n');

    // Start monitoring loop
    while (true) {
        await fetchActivitiesAndProcessTrades();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};


const calcNetSizeChange = (trades: UserActivityInterface[]): number => {
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
    netSizeChange = Math.round(netSizeChange * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;

    return netSizeChange;
}

const determineChangeType = (trades: UserActivityInterface[], firstTrade: UserActivityInterface, previousSize: number, newSize: number, delta: number, wasTracked: boolean): 'new' | 'increase' | 'decrease' | 'closed' | 'none' => {
    let changeType: 'new' | 'increase' | 'decrease' | 'closed' | 'none' = 'none';
    const tradeInfo = trades.length > 1 ? ` (${trades.length} trades combined)` : '';

    // Check if this was a position we weren't tracking AND previous size was very small/zero
    if (!wasTracked && previousSize < POSITION_CLOSE_THRESHOLD && newSize > 0) {
        changeType = 'new';
        console.log(`🆕 New position opened: ${firstTrade.title} - ${firstTrade.outcome}: ${newSize} shares${tradeInfo}`);
    } else if (newSize < POSITION_CLOSE_THRESHOLD) {
        changeType = 'closed';
        console.log(`❌ Position closed: ${firstTrade.title} - ${firstTrade.outcome}${tradeInfo}`);
    } else if (delta > POSITION_CHANGE_THRESHOLD) {
        changeType = 'increase';
        console.log(`🟢 Position increased: ${firstTrade.title} - ${firstTrade.outcome}: ${previousSize} → ${newSize} (+${delta.toFixed(4)})${tradeInfo}`);
    } else if (delta < -POSITION_CHANGE_THRESHOLD) {
        changeType = 'decrease';
        console.log(`🔴 Position decreased: ${firstTrade.title} - ${firstTrade.outcome}: ${previousSize} → ${newSize} (${delta.toFixed(4)})${tradeInfo}`);
    } else {
        // No net change (e.g., bought 10 then sold 10)
        // Skip emitting event
    }

    return changeType;
}


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

export const createNewTargetPosition = (position: UserPositionInterface, startTimestamp: number) => {
    return new InitialTargetPosition({
        conditionId: position.conditionId,
        asset: position.asset,
        size: position.size,
        outcomeIndex: position.outcomeIndex,
        startTimestamp: startTimestamp,
    });
}

export default tradeMonitor;
