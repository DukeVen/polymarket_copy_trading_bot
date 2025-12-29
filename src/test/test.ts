import { ClobClient, OrderType, Side, UserMarketOrder } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import getMyBalance from '../utils/getMyBalance';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

const test = async (clobClient: ClobClient) => {

    console.log("testing...");

    try {
        const price = (
            await clobClient.getLastTradePrice(
                '33937734450055362023094845664587432566259541722569464798773247925805151729394'
            )
        ).price;

        console.log(`✅ Last trade price fetched: $${price}`);

        const userMarketOrder: UserMarketOrder = {
            tokenID: '33937734450055362023094845664587432566259541722569464798773247925805151729394',
            amount: 0.1, // USD amount
            side: Side.BUY,
        };

        console.log(`\n📤 Submitting market order: ${userMarketOrder.side} $${userMarketOrder.amount}...`);

        const resp = await clobClient.createAndPostMarketOrder(
            userMarketOrder,
            { tickSize: '0.001', negRisk: true },
            OrderType.FAK
        );

        if (resp && resp.orderID) {
            console.log(`✅ Order successfully created!`);
            console.log(`   Order ID: ${resp.orderID}`);
            console.log(`   Status: ${resp.status || 'Submitted'}`);
            if (resp.transactionHash) {
                console.log(`   Transaction: ${resp.transactionHash}`);
            }
        } else {
            console.log(`⚠️  Order response received but no order ID:`);
            console.log(JSON.stringify(resp, null, 2));
        }
    } catch (error: any) {
        console.error(`\n❌ Test failed with error:`);
        console.error(`   Message: ${error.message || 'Unknown error'}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
        }
        if (error.stack) {
            console.error(`   Stack: ${error.stack}`);
        }
    }
};

export default test;
