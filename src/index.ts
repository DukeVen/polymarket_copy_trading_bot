import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { initializeExecutor } from './services/tradeExecutor';
import tradeMonitor, { initializeMonitor } from './services/tradeMonitor';
import test from './test/test';

const TARGET_ADDRESS = ENV.TARGET_ADDRESS;
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
    
    console.log(`Target User Wallet address is: ${TARGET_ADDRESS}`);
    console.log(`My Wallet address is: ${PROXY_WALLET}\n`);

    const clobClient = await createClobClient();
    
    // Initialize both services
    console.log('🔧 Initializing services...\n');
    
    // Initialize trade monitor (sets up activity tracking)
    console.log('📊 Initializing trade monitor...');
    initializeMonitor();
    console.log('✅ Trade monitor initialized\n');
    
    // Initialize trade executor (loads bot positions from API once)
    console.log('🤖 Initializing trade executor...');
    await initializeExecutor();
    console.log('✅ Trade executor initialized\n');
    
    console.log('🚀 Starting monitoring and execution...\n');
    console.log('='.repeat(50) + '\n');
    
    // Run both monitor and executor in parallel (both have infinite loops)
    await Promise.all([
        tradeMonitor(),           // Monitor target user's transactions
        tradeExecutor(clobClient)  // Execute transactions on your wallet
    ]);
};

main();
