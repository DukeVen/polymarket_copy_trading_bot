import { UserPositionInterface } from '../interfaces/User';
import fetchData from './fetchData';

/**
 * Fetch user positions from Polymarket Data API
 * @param walletAddress - The wallet address to fetch positions for
 * @param limit - Maximum number of positions to fetch (default: 500)
 * @returns Array of user positions
 */
const fetchPositions = async (walletAddress: string, limit: number = 500): Promise<UserPositionInterface[]> => {
    try {
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${walletAddress}&limit=${limit}`
        );
        return positions;
    } catch (error) {
        console.error('⚠️ Error fetching positions from API:', error);
        console.error('   Error details:', String(error));
        return [];
    }
};

export default fetchPositions;
