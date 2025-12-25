import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const DRY_RUN = ENV.DRY_RUN;
const SIZE_MULTIPLIER = ENV.SIZE_MULTIPLIER;
const MAX_ORDER_AMOUNT = ENV.MAX_ORDER_AMOUNT;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    //Merge strategy
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position) {
            console.log('my_position is undefined');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log('Max price bid:', maxPriceBid);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            console.log('Order args:', order_arges);
            if (DRY_RUN) {
                console.log('🔷 [DRY RUN] Would post MERGE order:', {
                    side: 'SELL',
                    tokenID: order_arges.tokenID,
                    amount: order_arges.amount,
                    price: order_arges.price,
                    orderType: 'FOK'
                });
                remaining -= order_arges.amount;
                retry = 0;
            } else {
                const signedOrder = await clobClient.createMarketOrder(order_arges);
                const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
                if (resp.success === true) {
                    retry = 0;
                    console.log('Successfully posted order:', resp);
                    remaining -= order_arges.amount;
                } else {
                    retry += 1;
                    console.log('Error posting order: retrying...', resp);
                }
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'buy') {       //Buy strategy
        console.log('Buy Strategy...');
        const ratio = my_balance / (user_balance + trade.usdcSize);
        console.log('ratio', ratio);
        let calculatedAmount = trade.usdcSize * ratio * SIZE_MULTIPLIER;
        let remaining = Math.min(calculatedAmount, MAX_ORDER_AMOUNT);
        console.log(`Calculated: ${calculatedAmount.toFixed(2)}, Capped at: ${remaining.toFixed(2)} USDC`);
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            console.log('Min price ask:', minPriceAsk);
            if (parseFloat(minPriceAsk.price) - 0.05 > trade.price) {
                console.log('Too big different price - do not copy');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            let order_arges;
            if (remaining <= parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price)) {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(minPriceAsk.price),
                };
            } else {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price),
                    price: parseFloat(minPriceAsk.price),
                };
            }
            console.log('Order args:', order_arges);
            if (DRY_RUN) {
                console.log('🔷 [DRY RUN] Would post BUY order:', {
                    side: 'BUY',
                    tokenID: order_arges.tokenID,
                    amount: order_arges.amount,
                    price: order_arges.price,
                    orderType: 'FOK'
                });
                remaining -= order_arges.amount;
                retry = 0;
            } else {
                const signedOrder = await clobClient.createMarketOrder(order_arges);
                const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
                if (resp.success === true) {
                    retry = 0;
                    console.log('Successfully posted order:', resp);
                    remaining -= order_arges.amount;
                } else {
                    retry += 1;
                    console.log('Error posting order: retrying...', resp);
                }
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'sell') {          //Sell strategy
        console.log('Sell Strategy...');
        let remaining = 0;
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        } else if (!user_position) {
            remaining = my_position.size * SIZE_MULTIPLIER;
        } else {
            const ratio = trade.size / (user_position.size + trade.size);
            console.log('ratio', ratio);
            remaining = my_position.size * ratio * SIZE_MULTIPLIER;
        }
        console.log(`Sell amount with multiplier: ${remaining.toFixed(2)}`);
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log('Max price bid:', maxPriceBid);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            console.log('Order args:', order_arges);
            if (DRY_RUN) {
                console.log('🔷 [DRY RUN] Would post SELL order:', {
                    side: 'SELL',
                    tokenID: order_arges.tokenID,
                    amount: order_arges.amount,
                    price: order_arges.price,
                    orderType: 'FOK'
                });
                remaining -= order_arges.amount;
                retry = 0;
            } else {
                const signedOrder = await clobClient.createMarketOrder(order_arges);
                const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
                if (resp.success === true) {
                    retry = 0;
                    console.log('Successfully posted order:', resp);
                    remaining -= order_arges.amount;
                } else {
                    retry += 1;
                    console.log('Error posting order: retrying...', resp);
                }
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        console.log('condition not supported');
    }
};

export default postOrder;
