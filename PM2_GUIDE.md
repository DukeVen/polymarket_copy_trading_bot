# PM2 Deployment Guide

## Setup on VPS

### 1. Install PM2 globally
```bash
npm install -g pm2
```

### 2. Build the project
```bash
npm run build
```

### 3. Create logs directory
```bash
mkdir -p logs
```

### 4. Start the bot with PM2
```bash
pm2 start ecosystem.config.js
```

## Useful PM2 Commands

### Monitor the bot
```bash
pm2 status                  # Check status
pm2 logs polymarket-copy-bot  # View logs
pm2 monit                   # Real-time monitoring
```

### Control the bot
```bash
pm2 restart polymarket-copy-bot   # Restart
pm2 stop polymarket-copy-bot      # Stop
pm2 delete polymarket-copy-bot    # Remove from PM2
```

### Auto-start on server reboot
```bash
pm2 startup                # Generate startup script
pm2 save                   # Save current process list
```

### Update and restart
```bash
git pull
npm run build
pm2 restart polymarket-copy-bot
```

## Configuration

Edit `.env` file with your settings before starting:
- `TARGET_ADDRESS` - Wallet to copy
- `PROXY_WALLET` - Your bot wallet
- `DRY_RUN=false` - Set to false for live trading
- `FETCH_INTERVAL=2` - Polling interval in seconds
