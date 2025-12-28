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

        processTrades(newTrades, tradesByAsset);


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

const processTrades = (newTrades: UserActivityInterface[], tradesByAsset: Map<string, UserActivityInterface[]>) => {
    console.log(`\n[MONITOR] ${"═".repeat(60)}`);
    console.log(`[MONITOR] 📊 Processing ${newTrades.length} new trade ${newTrades.length === 1 ? 'activity' : 'activities'}`);
    console.log(`[MONITOR] ⏰ Timestamp: ${moment.unix(lastProcessedActivityTimestamp).format('YYYY-MM-DD HH:mm:ss')}`);

    // Process each asset's trades as a single net change
    // asset = assetId
    // trades = array of trade activities for that asset
    for (const [asset, trades] of tradesByAsset) {
        const firstTrade = trades[0];
        const netSizeChange = calcNetSizeChange(trades);

        console.log(`[MONITOR] ${"─".repeat(58)}┐`);
        console.log(`[MONITOR] │ Market: ${firstTrade.title}`);
        console.log(`[MONITOR] │ Outcome: ${firstTrade.outcome}`);
        console.log(`[MONITOR] └${"─".repeat(58)}┘`);

        // Log individual trades
        if (trades.length > 1) {
            console.log(`[MONITOR] \n  Individual Trades (${trades.length} total):`);
        }
        for (const trade of trades) {
            const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
            console.log(`[MONITOR]   ${emoji} ${trade.side.padEnd(4)} │ ${trade.size.toString().padStart(10)} shares @ $${trade.price}`);
        }

        // Determine verdict
        let tradeVerdict = '';
        let verdictEmoji = '';
        let changeType: 'new' | 'increase' | 'decrease' | 'closed' | 'none' = 'none';
        
        if (netSizeChange > POSITION_CLOSE_THRESHOLD) {
            tradeVerdict = 'BUY';
            verdictEmoji = '🟢';
            changeType = 'increase';
        } else if (netSizeChange < -POSITION_CLOSE_THRESHOLD) {
            tradeVerdict = 'SELL';
            verdictEmoji = '🔴';
            changeType = 'decrease';
        } else {
            tradeVerdict = 'NO CHANGE';
            verdictEmoji = '⚪';
            changeType = 'none';
        }

        console.log(`[MONITOR] \n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[MONITOR]   Net Position Change: ${netSizeChange > 0 ? '+' : ''}${netSizeChange} shares`);
        console.log(`[MONITOR]   ${verdictEmoji} VERDICT: ${tradeVerdict}`);
        console.log(`[MONITOR]   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        // Emit position change event if there's a meaningful change
        if (changeType !== 'none') {
            const positionChangeEvent: PositionChangeEvent = {
                asset: firstTrade.asset,
                conditionId: firstTrade.conditionId,
                outcomeIndex: firstTrade.outcomeIndex,
                title: firstTrade.title,
                outcome: firstTrade.outcome,
                avgPrice: firstTrade.price,
                curPrice: firstTrade.price,
                changeType,
                sizeChange: netSizeChange,
            };

            console.log(`[MONITOR]   🔔 Emitting position change event to executor...\n`);
            positionChangeEmitter.emitPositionChange(positionChangeEvent);
        }
    }

    console.log(`[MONITOR] ✅ Processing Complete`);
    console.log(`[MONITOR] ${"═".repeat(60)}\n\n`);

}


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




// Export init function for manual initialization
export const initializeMonitor = init;

export default tradeMonitor;
