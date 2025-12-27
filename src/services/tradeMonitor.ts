import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel, getInitialTargetPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
    console.log('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);
const InitialTargetPosition = getInitialTargetPositionModel(USER_ADDRESS);

let temp_trades: UserActivityInterface[] = [];
let isInitialized = false;
let currentTargetPositions: Map<string, UserPositionInterface> = new Map(); // key: asset (token ID)

const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map((trade) => trade as UserActivityInterface);
    
    // Check if we've already saved initial positions
    const existingInitialPositions = await InitialTargetPosition.find().exec();
    
    if (existingInitialPositions.length === 0) {
        console.log('📸 Taking snapshot of target\'s initial positions...');
        
        // Fetch and save target's current positions as initial state
        const userPositions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
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
    
    isInitialized = true;
};

const fetchTradeData = async () => {
    try {
        // Fetch user activities from Polymarket API
        const userActivities: UserActivityInterface[] = await fetchData(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}`
        );

        // Fetch user positions
        const userPositions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );

        // Filter and process new trades
        for (const activity of userActivities) {
            // Skip if not a trade
            if (activity.type !== 'TRADE') continue;

            // Skip if trade is too old
            const hoursDiff = moment().diff(moment.unix(activity.timestamp), 'hours');
            if (hoursDiff > TOO_OLD_TIMESTAMP) continue;

            // Check if trade already exists in database
            const existingTrade = temp_trades.find(
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
                temp_trades.push(newTrade as UserActivityInterface);
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
            
            // Update current positions map (keyed by asset/token ID)
            currentTargetPositions.set(position.asset, position);
        }
    } catch (error) {
        console.error('Error fetching trade data:', error);
    }
};

const tradeMonitor = async () => {
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    await init();    //Load my oders before sever downs
    while (true) {
        await fetchTradeData();     //Fetch all user activities
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));     //Fetch user activities every second
    }
};

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
