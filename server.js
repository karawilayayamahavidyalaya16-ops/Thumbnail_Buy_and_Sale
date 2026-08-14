/**
 * ============================================================================
 *  THUMBNAILHUB LK - COMPLETE FULL STACK SINGLE-FILE APPLICATION
 *  - Customer Buy Section & Designer Upload System
 *  - Automated 10% Platform Commission / 90% Designer Payout
 *  - PayHere Integration (Sri Lankan Banks, Visa/Master, Mobile Wallets)
 *  - Watermarking, File Uploads & Image Protection Guards
 *  - Interactive Animations & 6-Second Welcome Screen Included
 * ============================================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// 1. CONFIGURATION, PAYHERE & PLATFORM BANK CREDENTIALS
// ============================================================================
const PAYHERE_CONFIG = {
    merchant_id: '1234567', // <-- ඔයාගේ PayHere Merchant ID එක මෙතනට දාන්න
    merchant_secret: 'YOUR_PAYHERE_MERCHANT_SECRET_HERE', // <-- PayHere Secret එක දාන්න
    currency: 'LKR',
    return_url: 'http://localhost:5000/payment-success',
    cancel_url: 'http://localhost:5000/payment-cancel',
    notify_url: 'http://localhost:5000/api/payment/notify'
};

// PLATFORM OWNER BANK DETAILS (FOR 10% COMMISSION)
const PLATFORM_BANK = {
    account_no: '0096112406',
    bank_name: 'Bank of Ceylon',
    branch: 'Embilipitiya Branch (535)',
    account_holder: 'MS P D T PRIYADARSHANI'
};

const PORT = process.env.PORT || 5000;

// Auto Create Folders
const dirs = ['./uploads/previews', './uploads/originals'];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

// Multer Storage Configuration (For Image Uploads)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'preview_img') cb(null, './uploads/previews');
        else cb(null, './uploads/originals');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});
const upload = multer({ storage: storage });

// ============================================================================
// 2. DATABASE CONNECTION & AUTO SCHEMA SETUP
// ============================================================================
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'thumbnail_hub',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        role ENUM('designer', 'buyer') NOT NULL,
        bank_name VARCHAR(100),
        account_no VARCHAR(50),
        branch VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => { if(err) console.error("Users Table Error:", err); });

db.query(`
    CREATE TABLE IF NOT EXISTS thumbnails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        designer_id INT,
        title VARCHAR(150) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        preview_url VARCHAR(255) NOT NULL,
        original_url VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => { if(err) console.error("Thumbnails Table Error:", err); });

db.query(`
    CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        thumbnail_id INT,
        buyer_email VARCHAR(100) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        commission_amount DECIMAL(10,2) NOT NULL,
        designer_amount DECIMAL(10,2) NOT NULL,
        status ENUM('pending', 'paid', 'delivered') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => { if(err) console.error("Orders Table Error:", err); });

// ============================================================================
// 3. FILE SERVING & SECURITY MIDDLEWARE
// ============================================================================
app.use('/uploads/previews', express.static(path.join(__dirname, 'uploads/previews')));

// BLOCK DIRECT ACCESS TO HD ORIGINALS
app.use('/uploads/originals', (req, res) => {
    res.status(403).send("🔒 Security Alert: Direct download of HD originals is restricted until payment confirmation!");
});

// ============================================================================
// 4. BACKEND API ROUTES
// ============================================================================

// Get All Marketplace Thumbnails
app.get('/api/thumbnails', (req, res) => {
    const query = `SELECT t.*, u.name as designer_name FROM thumbnails t JOIN users u ON t.designer_id = u.id ORDER BY t.id DESC`;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Designer Thumbnail Upload Portal Endpoint
app.post('/api/designer/upload', upload.fields([{ name: 'preview_img' }, { name: 'original_img' }]), (req, res) => {
    const { designer_name, designer_email, bank_name, account_no, branch, title, price } = req.body;

    if (!req.files['preview_img'] || !req.files['original_img']) {  
        return res.status(400).send("❌ පින්තූර දෙකම Upload කිරීම අනිවාර්ය වේ!");  
    }  

    const previewUrl = '/uploads/previews/' + req.files['preview_img'][0].filename;  
    const originalUrl = '/uploads/originals/' + req.files['original_img'][0].filename;  

    // Register / Update Designer  
    const userQuery = `INSERT INTO users (name, email, role, bank_name, account_no, branch) VALUES (?, ?, 'designer', ?, ?, ?) ON DUPLICATE KEY UPDATE bank_name=?, account_no=?, branch=?`;  
      
    db.query(userQuery, [designer_name, designer_email, bank_name, account_no, branch, bank_name, account_no, branch], (err, userRes) => {  
        if (err) return res.status(500).send("User Error: " + err.message);  
          
        const designerId = userRes.insertId || userRes.id;  
          
        // Save Thumbnail Metadata  
        const thumbQuery = `INSERT INTO thumbnails (designer_id, title, price, preview_url, original_url) VALUES (?, ?, ?, ?, ?)`;  
        db.query(thumbQuery, [designerId, title, price, previewUrl, originalUrl], (err2) => {  
            if (err2) return res.status(500).send("Thumbnail Save Error: " + err2.message);  
            res.redirect('/?success=upload');  
        });  
    });
});

// PayHere Checkout Initialization (Automated 10% Platform Fee Split)
app.post('/api/payment/checkout', (req, res) => {
    const { orderId, amount, thumbnailId, buyerEmail } = req.body;

    const commission = (parseFloat(amount) * 0.10).toFixed(2); // 10% Platform Fee  
    const designerPayout = (parseFloat(amount) - parseFloat(commission)).toFixed(2); // 90% Designer Amount  
    const amountFormatted = parseFloat(amount).toFixed(2);  

    const hashedSecret = crypto.createHash('md5').update(PAYHERE_CONFIG.merchant_secret).digest('hex').toUpperCase();  
    const hash = crypto.createHash('md5')  
        .update(PAYHERE_CONFIG.merchant_id + orderId + amountFormatted + PAYHERE_CONFIG.currency + hashedSecret)  
        .digest('hex').toUpperCase();  

    const query = `INSERT INTO orders (id, thumbnail_id, buyer_email, total_price, commission_amount, designer_amount, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`;  
    db.query(query, [orderId, thumbnailId, buyerEmail, amountFormatted, commission, designerPayout], (err) => {  
        if (err) return res.status(500).json({ error: err.message });  

        res.json({  
            merchant_id: PAYHERE_CONFIG.merchant_id,  
            return_url: PAYHERE_CONFIG.return_url,  
            cancel_url: PAYHERE_CONFIG.cancel_url,  
            notify_url: PAYHERE_CONFIG.notify_url,  
            order_id: orderId,  
            items: `Thumbnail Purchase (#${thumbnailId})`,  
            currency: PAYHERE_CONFIG.currency,  
            amount: amountFormatted,  
            hash: hash  
        });  
    });
});

// PayHere Payment Webhook Notification
app.post('/api/payment/notify', (req, res) => {
    const { merchant_id, order_id, payhere_amount, payhere_currency, status_code, md5sig } = req.body;

    const hashedSecret = crypto.createHash('md5').update(PAYHERE_CONFIG.merchant_secret).digest('hex').toUpperCase();  
    const localSig = crypto.createHash('md5')  
        .update(merchant_id + order_id + payhere_amount + payhere_currency + status_code + hashedSecret)  
        .digest('hex').toUpperCase();  

    if (localSig === md5sig && status_code == '2') {  
        db.query(`UPDATE orders SET status = 'paid' WHERE id = ?`, [order_id], (err) => {  
            if (err) console.error("Order Update Error:", err);  
            else console.log(`✅ Order ${order_id} Paid Successfully! 10% Platform Fee allocated to ${PLATFORM_BANK.account_holder}`);  
        });  
    }  
    res.sendStatus(200);
});

// Success & Cancel Status Handlers
app.get('/payment-success', (req, res) => res.send("<h1 style='text-align:center; padding-top:50px; font-family:sans-serif;'>🎉 ගෙවීම සාර්ථකයි! ඔබගේ HD Thumbnail එක Download කිරීමට Email පණිවිඩයක් එවනු ලැබේ.</h1>"));
app.get('/payment-cancel', (req, res) => res.send("<h1 style='text-align:center; padding-top:50px; font-family:sans-serif;'>❌ ගෙවීම අවලංගු කරන ලදී. නැවත උත්සාහ කරන්න.</h1>"));

// ============================================================================
// 5. FRONTEND HTML / UI INTEGRATION WITH ANIMATIONS
// ============================================================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>  
<html lang="si">  
<head>  
    <meta charset="UTF-8">  
    <meta name="viewport" content="width=device-width, initial-scale=1.0">  
    <title>ThumbnailHub LK - යූටියුබ් තම්බ්නෙයිල් වෙළඳපොළ</title>  
    <link href="https://fonts.googleapis.com/css2?family=Gemunu+Libre:wght@400;600;800&family=Plus+Jakarta+Sans:wght@300;400;600;700;800&display=swap" rel="stylesheet">  
    <script type="text/javascript" src="https://www.payhere.lk/payhere.js"></script>  
    
    <style>  
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', 'Gemunu Libre', sans-serif; }  
        body { background: #020617; color: #fff; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding-bottom: 50px; overflow-x: hidden; }  

        /* 6-Second Welcome Screen */
        #welcome-screen {
            position: fixed;
            inset: 0;
            background: #020617;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            transition: opacity 1s ease-out, visibility 1s;
        }
        .welcome-title {
            font-size: 3.5rem;
            font-weight: 800;
            background: linear-gradient(90deg, #00f2fe, #7928ca, #ff007f);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: pulseText 2s infinite alternate;
        }
        .welcome-sub {
            margin-top: 15px;
            font-size: 1.2rem;
            color: #94a3b8;
        }
        .timer-bar {
            width: 250px;
            height: 4px;
            background: rgba(255,255,255,0.1);
            margin-top: 25px;
            border-radius: 10px;
            overflow: hidden;
        }
        .timer-progress {
            width: 0%;
            height: 100%;
            background: linear-gradient(90deg, #00f2fe, #ff007f);
            animation: loadProgress 6s linear forwards;
        }

        @keyframes loadProgress { 0% { width: 0%; } 100% { width: 100%; } }
        @keyframes pulseText { 0% { transform: scale(0.98); opacity: 0.8; } 100% { transform: scale(1.02); opacity: 1; } }

        /* Liquid Animations */
        .bg-liquid-container { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }  
        .liquid-blob { position: absolute; filter: blur(90px); opacity: .6; border-radius: 50%; animation: float 10s ease-in-out infinite alternate; }  
        .blob-1 { width: 450px; height: 450px; background: #00f2fe; top: -5%; left: -5%; }  
        .blob-2 { width: 500px; height: 500px; background: #ff007f; bottom: -10%; right: -5%; animation-delay: -5s; }  
        .blob-3 { width: 350px; height: 350px; background: #7928ca; top: 40%; left: 30%; animation-duration: 14s; }  
        
        @keyframes float { 
            0% { transform: translate(0,0) scale(1); } 
            50% { transform: translate(60px, -40px) scale(1.1); } 
            100% { transform: translate(-30px, 30px) scale(0.95); } 
        }  

        .header { margin: 40px 0 10px; z-index: 10; text-align: center; }  
        .header h1 { font-size: 3rem; background: linear-gradient(90deg, #00f2fe, #ff007f); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }  

        .nav-tabs { display: flex; gap: 15px; margin: 20px 0; z-index: 10; }  
        .tab-btn { padding: 14px 28px; border: 1px solid rgba(255,255,255,0.2); background: rgba(15,23,42,0.8); color: #fff; border-radius: 14px; font-weight: 700; cursor: pointer; transition: all 0.4s ease; backdrop-filter: blur(10px); }  
        .tab-btn:hover { transform: translateY(-3px); box-shadow: 0 10px 25px rgba(0,242,254,0.3); }
        .tab-btn.active { background: linear-gradient(90deg, #00f2fe, #7928ca); border-color: transparent; box-shadow: 0 0 20px rgba(121,40,202,0.5); }  

        .glass-card { position: relative; z-index: 10; width: 90%; max-width: 950px; background: rgba(15,23,42,.85); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,.12); border-radius: 24px; padding: 30px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }  

        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 20px; margin-top: 20px; }  
        .card { background: rgba(2,6,23,.8); border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.1); transition: transform 0.3s, box-shadow 0.3s; }  
        .card:hover { transform: translateY(-5px); box-shadow: 0 10px 25px rgba(255,0,127,0.3); }
        
        .card-img-wrap { position: relative; width: 100%; height: 160px; overflow: hidden; }  
        .card img { width: 100%; height: 100%; object-fit: cover; }  
        .watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; font-weight: 800; color: rgba(255,255,255,0.4); transform: rotate(-25deg); pointer-events: none; user-select: none; background: repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(0,0,0,0.15) 10px, rgba(0,0,0,0.15) 20px); }  

        .card-body { padding: 15px; }  
        .price { color: #4ade80; font-weight: 800; font-size: 1.3rem; margin: 8px 0; }  

        /* Forms Styling */  
        .form-group { margin-bottom: 15px; text-align: left; }  
        .form-group label { display: block; margin-bottom: 5px; font-size: 0.9rem; color: #cbd5e1; }  
        .form-group input { width: 100%; padding: 12px; background: rgba(2,6,23,0.6); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; outline: none; transition: 0.3s; }  
        .form-group input:focus { border-color: #00f2fe; box-shadow: 0 0 10px rgba(0,242,254,0.4); }

        .btn-glow { width: 100%; padding: 14px; border: none; border-radius: 12px; font-weight: 800; color: #fff; background: linear-gradient(135deg, #00f2fe, #7928ca, #ff007f); cursor: pointer; transition: all 0.3s ease; background-size: 200% 200%; }  
        .btn-glow:hover { transform: translateY(-2px); background-position: right center; box-shadow: 0 0 25px rgba(0,242,254,.6); }  
    </style>  
</head>  
<body oncontextmenu="return false;">  

    <!-- 6-Second Welcome Screen Overlay -->
    <div id="welcome-screen">
        <div class="welcome-title">ThumbnailHub LK</div>
        <div class="welcome-sub">ලංකාවේ අංක 1 යූටියුබ් තම්බ්නෙයිල් Marketplace එකට සාදරයෙන් පිළිගනිමු!</div>
        <div class="timer-bar"><div class="timer-progress"></div></div>
    </div>

    <!-- Animated Background -->
    <div class="bg-liquid-container">  
        <div class="liquid-blob blob-1"></div>  
        <div class="liquid-blob blob-2"></div>  
        <div class="liquid-blob blob-3"></div>  
    </div>  

    <div class="header">  
        <h1>ThumbnailHub LK</h1>  
        <p>ඔබේ YouTube Videos වලට ඉහළම Quality එකේ Thumbnails ලබාගන්න</p>  
    </div>  

    <div class="nav-tabs">  
        <button class="tab-btn active" onclick="switchTab('buy', event)">🛒 තම්බ්නෙයිල් මිලදී ගන්න (Customer)</button>  
        <button class="tab-btn" onclick="switchTab('sell', event)">🎨 තම්බ්නෙයිල් විකුණන්න (Designer)</button>  
    </div>  

    <!-- BUYER MARKETPLACE TAB -->  
    <div class="glass-card" id="buyTab">  
        <h2>🔥 සියලුම තම්බ්නෙයිල් නිර්මාණ</h2>  
        <div class="grid" id="marketGrid">Loading Thumbnails...</div>  
    </div>  

    <!-- DESIGNER UPLOAD TAB -->  
    <div class="glass-card" id="sellTab" style="display: none;">  
        <h2>📤 ඔබේ නිර්මාණය විකිණීමට එක් කරන්න</h2>  
        <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px;">ඔබගේ නිර්මාණය අලෙවි වූ පසු 10% Platform ගාස්තුව කැපී ඉතිරි 90% මුදල පහත බැංකු ගිණුමට ලැමේ.</p>  

        <form action="/api/designer/upload" method="POST" enctype="multipart/form-data">  
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">  
                <div class="form-group"><label>ඔබගේ නම:</label><input type="text" name="designer_name" required></div>  
                <div class="form-group"><label>Email ලිපිනය:</label><input type="email" name="designer_email" required></div>  
            </div>  

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">  
                <div class="form-group"><label>බැංකුවේ නම:</label><input type="text" name="bank_name" placeholder="Commercial / BOC" required></div>  
                <div class="form-group"><label>Account Number:</label><input type="text" name="account_no" required></div>  
                <div class="form-group"><label>Branch:</label><input type="text" name="branch" required></div>  
            </div>  

            <hr style="border: 0.5px solid rgba(255,255,255,0.1); margin: 15px 0;">  

            <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px;">  
                <div class="form-group"><label>Thumbnail Title:</label><input type="text" name="title" placeholder="3D Gaming Thumbnail" required></div>  
                <div class="form-group"><label>මිල (LKR):</label><input type="number" name="price" placeholder="2000" required></div>  
            </div>  

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">  
                <div class="form-group"><label>Preview Image (Low Res / Sample):</label><input type="file" name="preview_img" accept="image/*" required></div>  
                <div class="form-group"><label>Original HD Image (Full Res):</label><input type="file" name="original_img" accept="image/*" required></div>  
            </div>  

            <button type="submit" class="btn-glow" style="margin-top: 10px;">Thumbnail එක Marketplace එකට ඇතුළත් කරන්න 🚀</button>  
        </form>  
    </div>

    <script>  
        // 6-Second Welcome Screen Hide Logic
        setTimeout(() => {
            const welcome = document.getElementById('welcome-screen');
            welcome.sty
