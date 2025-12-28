// API Rate Limiter for tracking and warning about Polymarket API rate limits
class APIRateLimiter {
    private calls: number[] = [];
    private limit: number;
    private window: number = 10000; // 10 seconds in ms
    private name: string;

    constructor(name: string, limit: number) {
        this.name = name;
        this.limit = limit;
    }

    track() {
        const now = Date.now();
        // Remove calls older than 10 seconds
        this.calls = this.calls.filter(timestamp => now - timestamp < this.window);
        // Add current call
        this.calls.push(now);
        
        const count = this.calls.length;
        const percentage = (count / this.limit) * 100;

        //console.log("API COUNT: ", count);
        
        // Warning at 80%
        if (percentage >= 80 && percentage < 100) {
            console.warn(`⚠️  ${this.name} API: ${count}/${this.limit} calls in 10s (${percentage.toFixed(0)}%)`);
        }
        // Error at 100%+
        else if (percentage >= 100) {
            console.error(`🚨 ${this.name} API RATE LIMIT EXCEEDED: ${count}/${this.limit} calls in 10s!`);
        }
    }

    getStats(): { count: number; limit: number; percentage: number } {
        const now = Date.now();
        this.calls = this.calls.filter(timestamp => now - timestamp < this.window);
        const count = this.calls.length;
        return {
            count,
            limit: this.limit,
            percentage: (count / this.limit) * 100
        };
    }
}

export default APIRateLimiter;
