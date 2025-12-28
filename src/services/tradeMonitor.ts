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
}

// Initialize rate limiters
const positionsRateLimiter = new APIRateLimiter('Positions', 150);
const activitiesRateLimiter = new APIRateLimiter('Activities', 200);

const UserPosition = getUserPositionModel(TARGET_ADDRESS);
const InitialTargetPosition = getInitialTargetPositionModel(TARGET_ADDRESS);

let isInitialized = false;
let currentTargetPositions: Map<string, UserPositionInterface> = new Map(); // Track current positions
let lastProcessedActivityTimestamp = 0; // Track last activity we've processed

const init = () => {
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

        console.log(`\n${"═".repeat(60)}`);
        console.log(`📊 Processing ${newTrades.length} new trade ${newTrades.length === 1 ? 'activity' : 'activities'}`);
        console.log(`⏰ Timestamp: ${moment.unix(lastProcessedActivityTimestamp).format('YYYY-MM-DD HH:mm:ss')}`);
        console.log(`${"═".repeat(60)}`);

        // Process each asset's trades as a single net change
        // asset = assetId
        // trades = array of trade activities for that asset
        for (const [asset, trades] of tradesByAsset) {
            const firstTrade = trades[0];
            const netSizeChange = calcNetSizeChange(trades);
            
            console.log(`\n┌${"─".repeat(58)}┐`);
            console.log(`│ Market: ${firstTrade.title}`);
            console.log(`│ Outcome: ${firstTrade.outcome}`);
            console.log(`└${"─".repeat(58)}┘`);
            
            // Log individual trades
            if (trades.length > 1) {
                console.log(`\n  Individual Trades (${trades.length} total):`);
            }
            for (const trade of trades) {
                const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
                console.log(`  ${emoji} ${trade.side.padEnd(4)} │ ${trade.size.toString().padStart(10)} shares @ $${trade.price}`);
            }

            // Determine verdict
            let tradeVerdict = '';
            let verdictEmoji = '';
            if (netSizeChange > POSITION_CLOSE_THRESHOLD) {
                tradeVerdict = 'BUY';
                verdictEmoji = '🟢';
            } else if (netSizeChange < -POSITION_CLOSE_THRESHOLD) {
                tradeVerdict = 'SELL';
                verdictEmoji = '🔴';
            } else {
                tradeVerdict = 'NO CHANGE';
                verdictEmoji = '⚪';
            }

            console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`  Net Position Change: ${netSizeChange > 0 ? '+' : ''}${netSizeChange} shares`);
            console.log(`  ${verdictEmoji} VERDICT: ${tradeVerdict}`);
            console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        }

        console.log(`✅ Processing Complete`);
        console.log(`${"═".repeat(60)}\n`);


    } catch (error) {
        console.error('Error fetching activities:', error);
    }
};

const tradeMonitor = async () => {
    // Check if already initialized (by external call to initializeMonitor)
    if (!isInitialized) {
        console.log('Trade Monitor is initializing...');
        init();
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

    for (const trade of trades) {
        if (trade.side === 'BUY') {
            netSizeChange += trade.size;
        } else if (trade.side === 'SELL') {
            netSizeChange -= trade.size;
        }
    }
    netSizeChange = Math.round(netSizeChange * PRECISION_MULTIPLIER) / PRECISION_MULTIPLIER;

    return netSizeChange;
}

const determineChangeType = (trades: UserActivityInterface[], firstTrade: UserActivityInterface, previousSize: number, newSize: number, delta: number): 'new' | 'increase' | 'decrease' | 'closed' | 'none' => {
    let changeType: 'new' | 'increase' | 'decrease' | 'closed' | 'none' = 'none';
    const tradeInfo = trades.length > 1 ? ` (${trades.length} trades combined)` : '';

    // Check if this was a position we weren't tracking AND previous size was very small/zero
    if (previousSize < POSITION_CLOSE_THRESHOLD && newSize > 0) {
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
