import { Wallet } from 'ethers';
import { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';

const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;

    const wallet = new Wallet(PRIVATE_KEY);
    const PROXY_WALLET = ENV.PROXY_WALLET || wallet.address;

    console.log('Using proxy wallet:', PROXY_WALLET);

    let creds: ApiKeyCreds;
    
    console.log(ENV.CLOB_API_KEY, ENV.CLOB_API_SECRET, ENV.CLOB_API_PASSPHRASE);

    // Check if API credentials are available in environment
    if (ENV.CLOB_API_KEY && ENV.CLOB_API_SECRET && ENV.CLOB_API_PASSPHRASE) {
        creds = {
            key: ENV.CLOB_API_KEY,
            secret: ENV.CLOB_API_SECRET,
            passphrase: ENV.CLOB_API_PASSPHRASE,
        };
        console.log('Using stored API credentials');
    } else {
        console.error('No API credentials found in environment variables. Exiting.');
        process.exit(1);
    }

    const client = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        2, // Deployed Safe proxy wallet
    );

    return client;
};

export default createClobClient;
