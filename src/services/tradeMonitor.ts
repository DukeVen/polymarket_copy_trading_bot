import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!TARGET_ADDRESS) {
    throw new Error('TARGET_ADDRESS is not defined');
    console.log('TARGET_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(TARGET_ADDRESS);
const UserPosition = getUserPositionModel(TARGET_ADDRESS);
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

let target_activities: UserActivityInterface[] = [];
let isInitialized = false;
let currentTargetPositions: Map<string, UserPositionInterface> = new Map(); // key: asset (token ID)

const init = async () => {
    target_activities = (await UserActivity.find().exec()).map((trade) => trade as UserActivityInterface);
    
    // Check if we've already saved initial positions
    const existingInitialPositions = await InitialTargetPosition.find().exec();
    
    if (existingInitialPositions.length === 0) {
        console.log('📸 Taking snapshot of target\'s initial positions...');
        
        // Fetch and save target's current positions as initial state
        const userPositions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${TARGET_ADDRESS}`
        );
        
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
        }
        
        console.log(`✅ Snapshot complete. Bot will only copy NEW trades from now on.\n`);
    } else {
        console.log('✅ Initial positions already saved. Resuming from previous state.\n');
    }
    
    // Fetch initial trade data before executor starts
    console.log('Fetching latest trades from API...');
    await fetchTradeData();
    console.log('✅ Initial fetch complete.\n');
    
    isInitialized = true;
};

const fetchTradeData = async () => {
    try {
        // Fetch target activities from Polymarket API
        const userActivities: UserActivityInterface[] = await fetchData(
            `https://data-api.polymarket.com/activity?user=${TARGET_ADDRESS}`
        );

        // Fetch target positions
        const userPositions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${TARGET_ADDRESS}`
        );

        // Filter and process new trades
        for (const activity of userActivities) {
            // Skip if not a trade
            if (activity.type !== 'TRADE') continue;

            // Skip if trade is too old // TODO ADJUST?
            const hoursDiff = moment().diff(moment.unix(activity.timestamp), 'hours');
            if (hoursDiff > TOO_OLD_TIMESTAMP) continue;

            // Check if trade already exists in database
            const existingTrade = target_activities.find(
                (trade) => trade.transactionHash === activity.transactionHash
            );

            if (!existingTrade) {
                // Save new trade to database
                const newTrade = new UserActivity({
                    ...activity,
                    bot: false,
                    botExcutedTime: 0,
                });
                await newTrade.save();
                target_activities.push(newTrade as UserActivityInterface);
                console.log('🆕 New trade detected:', {
                    title: activity.title,
                    side: activity.side,
                    size: activity.size,
                    price: activity.price,
                    timestamp: moment.unix(activity.timestamp).format('YYYY-MM-DD HH:mm:ss'),
                });
            }
        }

        // Update positions in database
        for (const position of userPositions) {
            await UserPosition.findOneAndUpdate(
                { conditionId: position.conditionId },
                { ...position },
                { upsert: true, new: true }
            );
            
            if (!currentTargetPositions.has(position.asset)) {
                console.log(`🔄 Added new position: ${position.title} - ${position.outcome}: ${position.size} shares`);
            }

            // Update current positions map (keyed by asset/token ID)
            currentTargetPositions.set(position.asset, position);
        }
    } catch (error) {
        console.error('Error fetching trade data:', error);
    }
};

const tradeMonitor = async () => {
    // Check if already initialized (by external call to initializeMonitor)
    if (!isInitialized) {
        console.log('Trade Monitor is initializing...');
        await init();
    }
    
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');

    // Start monitoring loop
    while (true) {
        await fetchTradeData();     // Fetch all target activities
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));     //Fetch target activities every second
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
