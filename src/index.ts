import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';
import test from './test/test';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    await connectDB();

    console.log(`\n${'='.repeat(50)}`);
    if (ENV.DRY_RUN) {
        console.log(`🔷 DRY RUN MODE: Orders will be simulated only`);
    } else {
        console.log(`✅ LIVE MODE: Orders will be executed`);
    }
    console.log(`${'='.repeat(50)}\n`);
    
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);


    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);



    const clobClient = await createClobClient();
    tradeMonitor();  //Monitor target user's transactions
    //tradeExecutor(clobClient);  //Execute transactions on your wallet
};

main();
