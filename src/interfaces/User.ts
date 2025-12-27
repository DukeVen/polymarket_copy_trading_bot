import mongoose from 'mongoose';

export interface UserActivityInterface {
    _id: mongoose.Types.ObjectId;
    proxyWallet: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: string;
    outcomeIndex: number;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    name: string;
    pseudonym: string;
    bio: string;
    profileImage: string;
    profileImageOptimized: string;
    bot: boolean;
    botExcutedTime: number;
}

export interface UserPositionInterface {
    _id: mongoose.Types.ObjectId;
    proxyWallet: string;
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    redeemable: boolean;
    mergeable: boolean;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    oppositeOutcome: string;
    oppositeAsset: string;
    endDate: string;
    negativeRisk: boolean;
}

// Track bot's own positions
export interface BotPositionInterface {
    _id: mongoose.Types.ObjectId;
    conditionId: string;
    asset: string;
    size: number; // How many shares the bot actually owns
    outcomeIndex: number;
    title: string;
    outcome: string;
    lastUpdated: number; // Timestamp
}

// Track initial target positions when bot starts
export interface InitialTargetPositionInterface {
    _id: mongoose.Types.ObjectId;
    conditionId: string;
    asset: string;
    size: number; // Target's position size when bot started
    outcomeIndex: number;
    startTimestamp: number; // When bot started tracking
}
