import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
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

let temp_trades: UserActivityInterface[] = [];

const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map((trade) => trade as UserActivityInterface);
    console.log('temp_trades', temp_trades);
};

const fetchTradeData = async () => {
    try {
        // Fetch user activities from Polymarket API
        const userActivities: UserActivityInterface[] = await fetchData(
            `https://data-api.polymarket.com/activities?user=${USER_ADDRESS}`
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

export default tradeMonitor;
