# Deployment Guide

Deploy Opengravity for 24/7 remote access from anywhere.

---

## Local Development

```bash
npm run dev   # Auto-restart on file changes
```

## Production (VPS / Cloud)

### Option A: Systemd Service (Linux VPS)

```bash
# 1. Upload to your VPS
scp -r . user@your-vps:/opt/opengravity/

# 2. SSH in
ssh user@your-vps

# 3. Install dependencies
cd /opt/opengravity
npm install --production

# 4. Create .env
cp .env.example .env
nano .env  # Configure your settings

# 5. Create systemd service
sudo nano /etc/systemd/system/opengravity.service
```

```ini
[Unit]
Description=Opengravity AI Gateway
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/opt/opengravity
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# 6. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable opengravity
sudo systemctl start opengravity

# 7. Check status
sudo systemctl status opengravity
journalctl -u opengravity -f  # View logs
```

### Option B: Docker

```dockerfile
# Dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
# Build and run
docker build -t opengravity .
docker run -d \
  --name opengravity \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  opengravity
```

### Option C: PM2 Process Manager

```bash
npm install -g pm2

# Start
pm2 start server.js --name opengravity

# Auto-start on reboot
pm2 startup
pm2 save

# Monitor
pm2 logs opengravity
pm2 monit
```

---

## Reverse Proxy (Nginx + HTTPS)

For secure external access:

```nginx
# /etc/nginx/sites-available/opengravity
server {
    listen 443 ssl http2;
    server_name og.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/og.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/og.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# Enable HTTPS with Let's Encrypt
sudo certbot --nginx -d og.yourdomain.com
```

---

## Remote Access via Tailscale

For accessing without exposing to the internet:

1. Install [Tailscale](https://tailscale.com) on both machines
2. Your Opengravity is now accessible at `http://100.x.x.x:3000`
3. No reverse proxy or HTTPS needed (Tailscale handles encryption)

---

## Security Checklist for Production

- [ ] Set `API_KEY` in `.env`
- [ ] Set `API_SECRET` for JWT support  
- [ ] Set `ALLOWED_USER_IDS` for Telegram
- [ ] Use HTTPS (via reverse proxy or Tailscale)
- [ ] Don't expose CDP ports (9000) externally
- [ ] Set `LOG_LEVEL=warn` for less noise
- [ ] Use a strong, random API key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
