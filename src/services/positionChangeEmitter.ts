import { EventEmitter } from 'events';
import { UserPositionInterface } from '../interfaces/User';

// Define the event payload interface
export interface PositionChangeEvent {
    asset: string;
    previousSize: number;
    currentSize: number;
    delta: number;
    position: UserPositionInterface;
    changeType: 'new' | 'increase' | 'decrease' | 'closed';
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
