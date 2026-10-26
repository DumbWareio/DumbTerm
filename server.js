require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const pty = require('node-pty');
const os = require('os');
const { generatePWAManifest } = require("./scripts/pwa-manifest-generator");
const { originValidationMiddleware, getCorsOptions, validateOrigin } = require('./scripts/cors');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'TRUE';
const NODE_ENV = process.env.NODE_ENV || 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const SITE_TITLE = DEMO_MODE ? `${process.env.SITE_TITLE || 'DumbTerm'} (DEMO)` : (process.env.SITE_TITLE || 'DumbTerm');
const APP_VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ptyModule = DEMO_MODE ? require('./scripts/demo/terminal') : pty;
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const CACHE_NAME = `DUMBTERM_CACHE_V${APP_VERSION}`;

generatePWAManifest(SITE_TITLE);

function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args);
    }
}

// Base URL configuration
const BASE_PATH = (() => {
    if (!BASE_URL) {
        debugLog('No BASE_URL set, using empty base path');
        return '';
    }
    try {
        const url = new URL(BASE_URL);
        const path = url.pathname.replace(/\/$/, ''); // Remove trailing slash
        debugLog('Base URL Configuration:', {
            originalUrl: BASE_URL,
            extractedPath: path,
            protocol: url.protocol,
            hostname: url.hostname
        });
        return path;
    } catch {
        // If BASE_URL is just a path (e.g. /app)
        const path = BASE_URL.replace(/\/$/, '');
        debugLog('Using direct path as BASE_URL:', path);
        return path;
    }
})();

// Get the project name from package.json to use for the PIN environment variable
const projectName = require('./package.json').name.toUpperCase().replace(/-/g, '_');
const PIN = process.env[`${projectName}_PIN`];
const isPinRequired = PIN && PIN.trim() !== '';

// Log whether PIN protection is enabled
if (isPinRequired) {
    debugLog('PIN protection is enabled, PIN length:', PIN.length);
} else {
    debugLog('PIN protection is disabled');
}

// Brute force protection
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = (process.env.LOCKOUT_TIME || 15) * 60 * 1000; // default 15 minutes in milliseconds
const MAX_SESSION_AGE = (process.env.MAX_SESSION_AGE || 24) * 60 * 60 * 1000 // default 24 hours

function resetAttempts(ip) {
    debugLog('Resetting login attempts for IP:', ip);
    loginAttempts.delete(ip);
}

function isLockedOut(ip) {
    const attempts = loginAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= MAX_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < LOCKOUT_TIME) {
            debugLog('IP is locked out:', ip, 'Time remaining:', Math.ceil((LOCKOUT_TIME - timeElapsed) / 1000 / 60), 'minutes');
            return true;
        }
        resetAttempts(ip);
    }
    return false;
}

function recordAttempt(ip) {
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);
    debugLog('Login attempt recorded for IP:', ip, 'Count:', attempts.count);
}

// Security middleware
// Express reads NODE_ENV itself and defaults to development, which puts stack traces in error pages
app.set('env', NODE_ENV);
app.set('trust proxy', 1);
app.use(cors(getCorsOptions(BASE_URL)));
app.use(express.json());
app.use(cookieParser());

// Session configuration with secure settings
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        httpOnly: true,
        sameSite: 'strict',
        maxAge: MAX_SESSION_AGE
    }
}));

const requirePin = (req, res, next) => {
    if (!PIN || !isValidPin(PIN)) {
        return next();
    }

    const authCookie = req.cookies[COOKIE_NAME];
    if (!authCookie || !secureCompare(authCookie, PIN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Constant-time PIN comparison to prevent timing attacks
const verifyPin = (storedPin, providedPin) => {
    if (!storedPin || !providedPin) return false;
    if (storedPin.length !== providedPin.length) return false;
    
    try {
        return crypto.timingSafeEqual(
            Buffer.from(storedPin),
            Buffer.from(providedPin)
        );
    } catch {
        return false;
    }
}

// Authentication middleware
const authMiddleware = (req, res, next) => {
    debugLog('Auth check for path:', req.path, 'Method:', req.method);
    
    // If no PIN is set or PIN is empty, bypass authentication completely
    if (!PIN || PIN.trim() === '') {
        debugLog('Auth bypassed - No PIN configured');
        req.session.authenticated = true; // Set session as authenticated
        return next();
    }

    // First check if user is authenticated via session
    if (req.session.authenticated) {
        debugLog('Auth successful - Valid session found');
        return next();
    }

    // If not authenticated via session, check for valid PIN cookie
    const pinCookie = req.cookies[`${projectName}_PIN`];
    if (pinCookie && verifyPin(PIN, pinCookie)) {
        debugLog('Auth successful - Valid PIN cookie found, restoring session');
        req.session.authenticated = true;
        return next();
    }

    // No valid session or PIN cookie found
    debugLog('Auth failed - No valid session or PIN cookie, redirecting to login');
    return res.redirect(BASE_PATH + '/login');
};

// Global middleware for origin validation and authentication
app.use(BASE_PATH, (req, res, next) => {
    // List of paths that should be publicly accessible
    const publicPaths = [
        '/login',
        '/pin-length',
        '/verify-pin',
        '/config.js',
        '/assets/',
        '/fonts/',
        '/styles.css',
        '/manifest.json',
        '/asset-manifest.json',
    ];

    // Check if the current path matches any of the public paths
    if (publicPaths.some(path => req.path.startsWith(path))) {
        return next();
    }

    // For all other paths, apply both origin validation and auth middleware
    originValidationMiddleware(req, res, () => {
        authMiddleware(req, res, next);
    });
});

// Routes start here...
app.get(BASE_PATH + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve config.js for frontend
app.get(BASE_PATH + '/config.js', (req, res) => {
    debugLog('Serving config.js with basePath:', BASE_PATH);
    const appConfig = {
        basePath: BASE_PATH,
        debug: DEBUG,
        siteTitle: SITE_TITLE,
        isPinRequired: isPinRequired,
        isDemoMode: DEMO_MODE,
        version: APP_VERSION,
        cacheName: CACHE_NAME
    }

    res.type('application/javascript').send(`
        window.appConfig = ${JSON.stringify(appConfig)};
    `);
});

// Serve static files for public assets
app.use(BASE_PATH + '/', express.static(path.join(PUBLIC_DIR)));
app.get(BASE_PATH + "/manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "manifest.json"));
});
app.get(BASE_PATH + "/asset-manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "asset-manifest.json"));
});
// Serve font files
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts')));
app.use('/node_modules/@xterm/', express.static(
    path.join(__dirname, 'node_modules/@xterm/')
));

// Routes
app.get(BASE_PATH + '/login', (req, res) => {
    // Check if PIN is required
    if (!PIN || PIN.trim() === '') {
        return res.redirect(BASE_PATH + '/');
    }

    // Check authentication first
    if (req.session.authenticated) {
        return res.redirect(BASE_PATH + '/');
    }


    // Check if user is already authenticated by PIN
    const pinCookie = req.cookies[`${projectName}_PIN`];
    if (verifyPin(PIN, pinCookie)) {
        return res.redirect(BASE_PATH + '/');
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get(BASE_PATH + '/pin-length', (req, res) => {
    // If no PIN is set, return 0 length
    if (!PIN || PIN.trim() === '') {
        return res.json({ length: 0 });
    }
    res.json({ length: PIN.length });
});

app.post(BASE_PATH + '/verify-pin', (req, res) => {
    debugLog('PIN verification attempt from IP:', req.ip);
    
    // If no PIN is set, authentication is successful
    if (!PIN || PIN.trim() === '') {
        debugLog('PIN verification bypassed - No PIN configured');
        req.session.authenticated = true;
        return res.status(200).json({ success: true });
    }

    const ip = req.ip;
    
    // Check if IP is locked out
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((LOCKOUT_TIME - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        debugLog('PIN verification blocked - IP is locked out:', ip);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${timeLeft} minutes.`
        });
    }

    const { pin } = req.body || {};
    
    if (!pin || typeof pin !== 'string') {
        debugLog('PIN verification failed - Invalid PIN format');
        return res.status(400).json({ error: 'Invalid PIN format' });
    }

    // Verify PIN first
    const isPinValid = verifyPin(PIN, pin);
    
    if (isPinValid) {
        debugLog('PIN verification successful');
        // Reset attempts on successful login
        resetAttempts(ip);
        
        // Set authentication in session immediately
        req.session.authenticated = true;
        
        // Set secure cookie
        res.cookie(`${projectName}_PIN`, pin, {
            httpOnly: true,
            secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
            sameSite: 'strict',
            maxAge: MAX_SESSION_AGE
        });
        
        // Add artificial delay before sending response
        setTimeout(() => {
            // Redirect to main page on success
            res.redirect(BASE_PATH + '/');
        }, crypto.randomInt(50, 150));
    } else {
        debugLog('PIN verification failed - Invalid PIN');
        // Record failed attempt
        recordAttempt(ip);
        
        const attempts = loginAttempts.get(ip);
        const attemptsLeft = MAX_ATTEMPTS - attempts.count;
        
        // Add artificial delay before sending error response
        setTimeout(() => {
            res.status(401).json({ 
                error: 'Invalid PIN',
                attemptsLeft: Math.max(0, attemptsLeft)
            });
        }, crypto.randomInt(50, 150));
    }
});

app.get(BASE_PATH + '/api/require-pin', (req, res) => {
    // If no PIN is set, return success
    if (!PIN || PIN.trim() === '') {
        return res.json({ success: true, required: false });
    }

    // Check for PIN cookie
    const pinCookie = req.cookies[`${projectName}_PIN`];
    if (!pinCookie || !verifyPin(PIN, pinCookie)) {
        return res.json({ success: false, required: true });
    }

    // Valid PIN cookie found
    return res.json({ success: true, required: true });
});

// Logout endpoint
app.post(BASE_PATH + '/logout', (req, res) => {
    debugLog('Logout request received');
    
    const cookieOptions = {
        httpOnly: true,
        secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        sameSite: 'strict',
        path: BASE_PATH || '/',  // Match the path used when setting cookies
        expires: new Date(0),    // Immediately expire the cookie
        maxAge: 0               // Belt and suspenders - also set maxAge to 0
    };
    
    // Clear both cookies with consistent options
    res.clearCookie(`${projectName}_PIN`, cookieOptions);
    res.clearCookie('connect.sid', cookieOptions);
    
    // Destroy the session and wait for it to be destroyed before sending response
    req.session.destroy((err) => {
        if (err) {
            debugLog('Error destroying session:', err);
            return res.status(500).json({ success: false, error: 'Failed to logout properly' });
        }
        debugLog('Session and cookies cleared successfully');
        res.json({ success: true });
    });
});

// WebSocket server configuration
const wss = new WebSocketServer({ 
    server,
    verifyClient: (info, callback) => {
        debugLog('Verifying WebSocket connection from:', info.req.headers.origin);
        
        const isOriginValid = validateOrigin(info.req.headers.origin);
        if (isOriginValid) callback(true); // allow the connection
        else {
            console.warn("Blocked connection from origin:", info.req.headers.origin);
            callback(false, 403, 'Forbidden'); // reject the connection
        }
    }
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    debugLog('New WebSocket connection attempt');
    
    // Keep track of connection status
    ws.isAlive = true;
    
    // Setup ping/pong heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
        debugLog('Received pong from client');
    });

    // Handle connection errors
    ws.on('error', (error) => {
        debugLog('WebSocket error:', error);
        ws.terminate();
    });

    // If no PIN is set, allow the connection
    if (!PIN || PIN.trim() === '') {
        debugLog('No PIN required, creating terminal');
        createTerminal(ws);
        return;
    }

    if (!req.headers.cookie) {
        debugLog('No cookies found, closing connection');
        ws.close(1008, 'Authentication required'); // Use 1008 for policy violation
        return;
    }

    // Parse the cookies
    const parsedCookies = {};
    req.headers.cookie.split(';').forEach(cookie => {
        // Split on the first '=' only; skip nameless cookies (no '=') instead of crashing the server
        const separatorIndex = cookie.indexOf('=');
        if (separatorIndex === -1) return;
        parsedCookies[cookie.slice(0, separatorIndex).trim()] = cookie.slice(separatorIndex + 1).trim();
    });

    // Check if the user has the correct PIN cookie
    const pinCookie = parsedCookies[`${projectName}_PIN`];
    if (!pinCookie || !verifyPin(PIN, pinCookie)) {
        debugLog('Invalid PIN cookie, closing connection');
        ws.close(1008, 'Authentication required'); // Use 1008 for policy violation
        return;
    }

    debugLog('Authentication successful, creating terminal');
    createTerminal(ws);
});

// Heartbeat check interval with more frequent checks
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            debugLog('Terminating inactive WebSocket connection');
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (err) {
            debugLog('Error sending ping:', err);
            ws.terminate();
        }
    });
}, 15000); // Check every 15 seconds

// Clean up interval on server shutdown
process.on('SIGTERM', () => {
    clearInterval(heartbeatInterval);
    wss.close();
});

// Terminal creation helper function
function createTerminal(ws) {
    // Create terminal process
    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
    
    let term;
    try {
        term = ptyModule.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: DEMO_MODE ? '/home/demo' : (process.env.HOME || '/root'),
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                LANG: 'en_US.UTF-8',
                // Force buffer flushing for better alternate buffer handling
                STDBUF: 'L',
                // Ensure proper handling of alternate buffer in applications
                TERM_PROGRAM: 'xterm-256color'
            }
        });
    } catch (error) {
        // A failed spawn (bad SHELL, broken node-pty install) must not take down every other session
        console.error(`Failed to start terminal shell "${shell}":`, error.message);
        ws.close(1011, 'Failed to start terminal');
        return;
    }

    debugLog(`Terminal created with PID: ${term.pid}${DEMO_MODE ? ' (Demo Mode)' : ''}`);

    // Handle incoming data from client
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            switch(message.type) {
                case 'input':
                    term.write(message.data);
                    break;
                case 'resize':
                    term.resize(message.cols, message.rows);
                    break;
            }
        } catch (error) {
            debugLog('Error processing WebSocket message:', error);
        }
    });

    // Handle terminal data with control sequence filtering
    term.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
            // Raw send without any filtering - let the client handle buffer switches
            ws.send(JSON.stringify({ 
                type: 'output',
                data: data
            }));
        }
    });

    // Clean up on close
    ws.on('close', () => {
        debugLog('WebSocket closed, killing terminal process:', term.pid);
        term.kill();
    });

    // Handle terminal exit
    term.on('exit', (code) => {
        debugLog('Terminal process exited with code:', code);
        if (ws.readyState === ws.OPEN) {
            ws.close();
        }
    });
}

// Cleanup old lockouts periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts.entries()) {
        if (now - attempts.lastAttempt >= LOCKOUT_TIME) {
            loginAttempts.delete(ip);
        }
    }
}, 60000); // Clean up every minute

// Update server.listen to use the http server
server.listen(PORT, () => {
    debugLog('Server Configuration:', {
        port: PORT,
        basePath: BASE_PATH,
        pinProtection: isPinRequired,
        nodeEnv: NODE_ENV,
        debug: DEBUG,
        demoMode: DEMO_MODE,
        version: APP_VERSION,
        cacheName: CACHE_NAME
    });
    console.log(`Server running on: ${BASE_URL}`);
});