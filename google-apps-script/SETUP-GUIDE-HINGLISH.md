# Google Sheets Sync — Setup Guide (Hinglish)

Ye guide tumhe batayegi ki apne Live Chat CRM ko Google Sheets se kaise connect karo, taaki
naye leads (visitors) aur baaki data automatically ek Google Sheet mein save hote rahein —
ek live backup ki tarah.

⚠️ **Zaroori baat samajh lo pehle**: Google Sheet yahan sirf ek **backup/export** ki tarah
kaam karta hai. Tumhara asli data hamesha CRM ke apne database mein rehta hai (jo fast aur
reliable hai) — Sheet sirf ek copy save karta hai taaki tumhe Excel jaisi jagah pe bhi data
mile. Isliye admin panel Sheet se data **fetch nahi karta** — balki CRM Sheet ko **bhejta**
hai jab bhi naya lead aaye ya jab tum "Sync Now" dabao.

🔒 **Security note**: Is system se agent ke passwords ya koi bhi secret/token Google Sheet
mein **kabhi nahi jaata** — sirf naam, email, role, status jaisi normal jaankari jaati hai.

---

## Step 1: Naya Google Sheet banao

1. [sheets.google.com](https://sheets.google.com) par jao
2. **Blank spreadsheet** banao
3. Naam do jaise "Live Chat CRM Data"

## Step 2: Apps Script kholo

1. Sheet ke andar top menu se **Extensions** → **Apps Script** click karo
2. Ek naya tab khulega jisme code editor hoga
3. Jo bhi default code (`function myFunction() {}`) already likha hai, use **pura delete** kar do

## Step 3: Script code paste karo

1. Is package ke `google-apps-script/Code.gs` file ko kholo
2. Poora code copy karo
3. Apps Script editor mein paste kar do
4. Upar **"Untitled project"** par click karke naam do jaise "LiveChat Sync"
5. **Save** icon (💾) dabao ya `Ctrl+S`

## Step 4: Web App ke roop mein Deploy karo

1. Top-right **Deploy** button → **New deployment**
2. Gear icon (⚙️) click karo type select karne ke liye → **Web app** choose karo
3. Settings bharo:
   - **Description**: "LiveChat CRM Sync" (kuch bhi likh sakte ho)
   - **Execute as**: **Me** (apni Google account)
   - **Who has access**: **Anyone** ⚠️ (ye zaroori hai — warna CRM server data nahi bhej payega. Tension mat lo, is URL ko koi bina jaane guess nahi kar sakta, aur script sirf tumhare hi Sheet mein likhta hai)
4. **Deploy** dabao
5. Pehli baar mein Google permission maangega — **Authorize access** → apni Google account select karo → "Advanced" → "Go to [project name] (unsafe)" → **Allow**
   (Ye warning normal hai kyunki script khud tumne banaya hai, Google ko bas pata nahi ki ye trusted hai ya nahi — allow karna safe hai)
6. Deploy hone ke baad ek **Web app URL** milega jaisa:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```
   **Ise copy kar lo** — agla step mein chahiye hoga

## Step 5: URL ko Admin panel mein daalo

1. Live Chat CRM admin panel kholo → **Settings** page
2. **📊 Google Sheets Sync** section mein jao
3. Wahi copied URL paste karo "Apps Script Web App URL" field mein
4. Neeche do checkboxes hain:
   - "Sync new leads/visitors automatically" — on rakho agar chaho har naya lead turant Sheet mein jaye
   - "Include agents/departments/widgets/stats on manual sync" — on rakho agar poora admin data bhi chahiye (passwords ke bina)
5. **Save** dabao

## Step 6: Test karo

1. Save karne ke baad ek **"🔄 Sync Now"** button dikhega — usse dabao
2. Apni Google Sheet wapas kholo — kuch second mein naye tabs ban jayenge: **Leads**, **Agents**, **Departments**, **Widgets**, **Stats**
3. Agar data dikh raha hai, matlab sab sahi connect ho gaya

## Step 7: Naye leads automatically aate rahenge

Ab jab bhi koi visitor tumhari website ke widget se **Lead Capture Form** bharega (naam,
mobile, email, interested-in), uska data automatically **"Leads"** tab mein ek nayi row
ki tarah add ho jayega — bina kuch kiye.

---

## Kya-kya sync hota hai

| Sheet Tab | Kya hota hai | Kab update hota hai |
|-----------|--------------|----------------------|
| **Leads** | Har naye visitor/lead ki jaankari (naam, mobile, email, interested in) | Turant, jab bhi koi form submit kare |
| **Agents** | Naam, email, role, status, kitni chats handle kar rahe hain, Telegram linked hai ya nahi | Jab bhi "Sync Now" dabao |
| **Departments** | Sabhi departments ke naam | Jab bhi "Sync Now" dabao |
| **Widgets** | Har widget ka naam, color, position, icon type | Jab bhi "Sync Now" dabao |
| **Stats** | Total visitors, total conversations, closed conversations | Jab bhi "Sync Now" dabao |

**Kabhi sync nahi hota** (jaan-boojh kar): Agent passwords, SMTP passwords, Telegram bot
token, Telegram chat IDs (raw), JWT secrets — koi bhi sensitive/security-related cheez.

---

## Agar kuch atke

- **"Sync failed" error aaye**: Confirm karo ki Web App URL sahi paste hua hai aur usme
  `https://script.google.com/` se shuru hota hai
- **Deploy karte waqt "Anyone" option na dikhe**: Apni Google account ke domain restrictions
  check karo — kabhi kabhi organization/work accounts mein ye option limited hota hai;
  personal Gmail account use karke try karo
- **Data Sheet mein nahi aa raha lekin error bhi nahi**: Apps Script editor mein **Executions**
  tab (left sidebar) check karo — wahan har call ka log milega, error dikhega agar koi hai
- **Naya code paste karna ho baad mein** (update): Apps Script editor mein purana code replace
  karo, Save karo, phir **Deploy → Manage deployments → ✏️ Edit → New version → Deploy**
  (naya deployment banane ki zaroorat nahi, existing wala hi update ho jayega, URL wahi rahega)

Koi bhi step mein fasoge to error ka text/screenshot bhejna.
