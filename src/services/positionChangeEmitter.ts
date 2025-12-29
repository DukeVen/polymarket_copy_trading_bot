import { EventEmitter } from 'events';

// Define the event payload interface - only essential trade info needed
export interface PositionChangeEvent {
    asset: string;
    conditionId: string;
    outcomeIndex: number;
    title: string;
    outcome: string;
    avgPrice: number;
    curPrice: number;
    changeType: 'new' | 'increase' | 'decrease' | 'closed' | 'none';
    sizeChange: number; // Net change in position size (positive = buy, negative = sell)
    usdcSize: number; // Actual USD amount spent/received from activity API
}

// Create a singleton event emitter for position changes
class PositionChangeEmitter extends EventEmitter {
    constructor() {
        super();
        // Increase max listeners if needed (default is 10)
        this.setMaxListeners(20);
    }

    emitPositionChange(change: PositionChangeEvent) {
        this.emit('positionChanged', change);
    }

    onPositionChange(listener: (change: PositionChangeEvent) => void) {
        this.on('positionChanged', listener);
    }

    removePositionChangeListener(listener: (change: PositionChangeEvent) => void) {
        this.removeListener('positionChanged', listener);
    }
}

// Export singleton instance
export const positionChangeEmitter = new PositionChangeEmitter();
