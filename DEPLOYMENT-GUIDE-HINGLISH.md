# Live Chat CRM — Server Par Install Karne Ki Guide (Hinglish)

Ye guide tumhe batayegi ki ye system apne khud ke server (VPS) par kaise chadhaye, taaki
`localhost` ki jagah asli domain (jaise `chat.tumhari-company.com`) par live ho jaye.
Push notifications (mobile pe alert) **sirf HTTPS domain par kaam karti hain** — isiliye
production mein domain + SSL lagana zaroori hai, sirf IP address se push notification kaam nahi karegi.

---

## Cheezein jo chahiye honge (ek baar)

1. Ek **VPS / Cloud server** — jaise DigitalOcean, Hostinger VPS, AWS Lightsail, Contabo, etc.
   - Minimum: 1 GB RAM, Ubuntu 22.04 (sabse aasan)
   - Cost: roughly ₹400-800/month ke plans kaafi hain shuru mein
2. Ek **domain name** (jaise `chat.mycompany.com`) — GoDaddy, Namecheap, ya kahin se bhi khareed sakte ho
3. SSH se server access (VPS provider tumhe login details email karega)

---

## Step 1: Server se connect karo

Apne computer ke terminal mein (Windows par PowerShell, Mac/Linux par Terminal):

```bash
ssh root@YOUR_SERVER_IP
```

Password daalo jo VPS provider ne diya tha.

---

## Step 2: Server ready karo (Node.js, Git, PM2, Nginx install)

Ek-ek line copy-paste karo aur Enter dabao:

```bash
apt update && apt upgrade -y
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Check karo install hua ya nahi:
```bash
node --version
```

Ab **PM2** install karo (ye tumhare server ko hamesha chalu rakhta hai, crash hone par khud restart kar deta hai):
```bash
npm install -g pm2
```

Ab **Nginx** install karo (ye traffic ko tumhare domain se app tak pahuchayega, aur SSL/HTTPS handle karega):
```bash
apt install -y nginx
```

---

## Step 3: Apna project server par upload karo

Apne computer se (jaha zip file hai), terminal mein:

```bash
scp livechat-crm.zip root@YOUR_SERVER_IP:/root/
```

Wapas server ke SSH session mein:

```bash
cd /root
apt install -y unzip
unzip livechat-crm.zip -d livechat-crm
cd livechat-crm
npm install
```

---

## Step 4: App ko PM2 se start karo

```bash
pm2 start server/index.js --name livechat-crm
pm2 save
pm2 startup
```

`pm2 startup` chalane ke baad ek command dikhega jo shuru hota hai `sudo env PATH=...` — usko copy karke paste kar do aur Enter dabao. Isse app server restart hone par khud-ba-khud chalu ho jayega.

Check karo chal raha hai ya nahi:
```bash
pm2 status
pm2 logs livechat-crm
```

Yahan wahi widget key aur admin login wali lines dikhni chahiye jo local pe dikhi thi.

---

## Step 5: Domain ko server se connect karo

Apne domain provider (GoDaddy/Namecheap) ke DNS settings mein jao aur ek **A record** add karo:

| Type | Name/Host | Value |
|------|-----------|-------|
| A    | chat (ya @ agar root domain use karna hai) | YOUR_SERVER_IP |

Ye change hone mein 5 minute se 2 ghante tak lag sakta hai.

---

## Step 6: Nginx configure karo (domain → app)

```bash
nano /etc/nginx/sites-available/livechat-crm
```

Ye poora paste kar do (`chat.mycompany.com` ki jagah apna domain likhna):

```nginx
server {
    listen 80;
    server_name chat.mycompany.com;

    location / {
        proxy_pass http://localhost:4000;
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

Save karo: `Ctrl+O`, Enter, `Ctrl+X`

Ab is config ko activate karo:
```bash
ln -s /etc/nginx/sites-available/livechat-crm /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

Agar `nginx -t` "syntax is ok" bole, matlab sahi hai.

---

## Step 7: Free SSL (HTTPS) lagao — Certbot se

HTTPS ke bina push notifications kaam nahi karengi, isiliye ye step zaroor karo:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d chat.mycompany.com
```

Ye tumse email poochega aur terms accept karne ko kahega — bas follow karo. Certbot khud Nginx config update kar dega HTTPS ke liye.

---

## Step 8: Test karo!

Browser mein jao:
```
https://chat.mycompany.com/demo.html
https://chat.mycompany.com/admin
```

Agar dono khul rahe hain aur padlock icon (🔒) dikh raha hai address bar mein, matlab sab set hai.

---

## Widget embed code kahan se milega ab?

Admin panel → **Widget Customizer** page par jao, wahan har widget ka apna alag live domain
wala script tag milega:
```html
<script src="https://chat.mycompany.com/widget.js" data-company="YOUR_KEY"></script>
```
Isko apni asli website mein paste kar do.

---

## Telegram integration (optional) — HTTPS zaroori hai

Agar tum Admin → Settings mein Telegram bot connect karte ho, to Telegram tumhare server ko
seedha messages bhejta hai ek **webhook URL** par — aur Telegram sirf **HTTPS** webhook URLs
accept karta hai. Matlab:
- Ye feature `localhost` par test nahi ho sakta (koi real Telegram bot connect nahi kar payega)
- Domain + SSL lagne ke baad hi (upar wale Steps 5-7 ke baad) Telegram feature try karna
- Bot token save karte hi system khud webhook register kar deta hai — koi extra step nahi


## Roz-marra ke useful commands

| Kaam | Command |
|------|---------|
| App restart karo | `pm2 restart livechat-crm` |
| Live logs dekho | `pm2 logs livechat-crm` |
| App band karo | `pm2 stop livechat-crm` |
| Server reboot ke baad bhi chalu rahega | `pm2 startup` + `pm2 save` (ek baar kar diya hai) |
| Database backup lo | `cp /root/livechat-crm/data/chat.db /root/backup-$(date +%F).db` |

---

## Update kaise karein (naya code chadhana ho to)

1. Naya zip apne computer par download karo
2. `scp` se server pe bhejo (Step 3 jaisa)
3. Extract karke purani files replace karo — **`data/` folder ko mat chhuna**, usme tumhara live database hai
4. `pm2 restart livechat-crm`

---

## Agar kuch atke

- **"Connection error" widget mein**: `pm2 logs livechat-crm` chalao, error dekho
- **Nginx error**: `nginx -t` chalao, ye batayega config mein kya galat hai
- **SSL renew nahi ho raha**: Certbot khud renew karta hai, check karne ke liye `certbot renew --dry-run`
- **Push notification nahi aa rahi**: Confirm karo HTTPS use ho raha hai (http nahi), aur browser mein notification permission allow ki hai

Koi bhi step mein fasoge to error ka text/screenshot bhejo, turant help karunga.
