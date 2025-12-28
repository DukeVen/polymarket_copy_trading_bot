import * as dotenv from 'dotenv';
dotenv.config();

if (!process.env.TARGET_ADDRESS) {
    throw new Error('TARGET_ADDRESS is not defined');
}
if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is not defined');
}
if (!process.env.CLOB_HTTP_URL) {
    throw new Error('CLOB_HTTP_URL is not defined');
}
if (!process.env.CLOB_WS_URL) {
    throw new Error('CLOB_WS_URL is not defined');
}
if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined');
}
if (!process.env.RPC_URL) {
    throw new Error('RPC_URL is not defined');
}
if (!process.env.USDC_CONTRACT_ADDRESS) {
    throw new Error('USDC_CONTRACT_ADDRESS is not defined');
}

export const ENV = {
    TARGET_ADDRESS: process.env.TARGET_ADDRESS as string,
    PROXY_WALLET: process.env.PROXY_WALLET,
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    CLOB_API_KEY: process.env.API_KEY as string,
    CLOB_API_SECRET: process.env.API_SECRET as string,
    CLOB_API_PASSPHRASE: process.env.API_PASSPHRASE as string,
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    DRY_RUN: process.env.DRY_RUN === 'true',
    SIZE_MULTIPLIER: parseFloat(process.env.SIZE_MULTIPLIER || '1.0'),
    MAX_ORDER_AMOUNT: parseFloat(process.env.MAX_ORDER_AMOUNT || '100'),
    MAX_SPEND_24H: parseFloat(process.env.MAX_SPEND_24H || '1000'),
};
