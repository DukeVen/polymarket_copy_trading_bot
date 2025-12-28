import { UserPositionInterface } from '../interfaces/User';
import fetchData from './fetchData';

/**
 * Fetch ALL user positions from Polymarket Data API using pagination
 * @param walletAddress - The wallet address to fetch positions for
 * @returns Array of all user positions
 */
const fetchPositions = async (walletAddress: string): Promise<UserPositionInterface[]> => {
    try {
        const allPositions: UserPositionInterface[] = [];
        const limit = 500; // Max allowed by API
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            // redeemable=false to exclude positions that are resolved
            // _=${Date.now()} to bypass any HTTP caching
            const positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${walletAddress}&limit=${limit}&offset=${offset}&redeemable=false&_=${Date.now()}`
            );

            if (positions.length === 0) {
                hasMore = false;
            } else {
                allPositions.push(...positions);
                offset += limit;

                // If we got fewer than limit, we've reached the end
                if (positions.length < limit) {
                    hasMore = false;
                }
            }
        }

        return allPositions;
    } catch (error) {
        console.error('⚠️ Error fetching positions from API:', error);
        console.error('   Error details:', String(error));
        return [];
    }
};

export default fetchPositions;
