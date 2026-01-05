require('dotenv').config();
const axios = require('axios');

// Configuration
const HR_API_KEY = process.env.HR_API_KEY;
const API_BASE = "https://api.worlds.highrise.game/api";

// State
let musicQueue = [];
let isPlaying = false;
let currentSong = null;

// Helper: Headers for Highrise API
const getHeaders = () => {
    if (!HR_API_KEY) {
        console.error("CRITICAL: HR_API_KEY is missing! Check your Railway variables.");
        return {};
    }
    // Ensure no whitespace and use Bearer token (Standard for Worlds API)
    const cleanKey = HR_API_KEY.trim();
    return {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'application/json'
    };
};

// Helper: Delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Fetch Storage (Inbox & Queue)
async function fetchStorage() {
    const result = {};
    
    // Helper to fetch a single key safely
    const fetchKey = async (key) => {
        try {
            const res = await axios.get(`${API_BASE}/storage/object/${key}`, { headers: getHeaders() });
            return res.data; // Return full object { key, value, version }
        } catch (error) {
            if (error.response && error.response.status === 404) {
                // Key doesn't exist yet
                return null;
            }
            console.error(`Error fetching ${key}:`, error.message);
            return null;
        }
    };

    const inboxData = await fetchKey('bot_inbox');
    const queueData = await fetchKey('music_queue');

    result.bot_inbox = inboxData ? inboxData.value : null;
    result.bot_inbox_version = inboxData ? inboxData.version : null;
    
    try {
        let rawVal = queueData ? queueData.value : null;
        // Handle Lua-wrapped JSON (return [[...]])
        if (rawVal && typeof rawVal === 'string' && rawVal.startsWith("return [[")) {
             const match = rawVal.match(/return \[\[([\s\S]*)\]\]/);
             if (match) {
                 rawVal = match[1];
             }
        }
        result.music_queue = rawVal ? JSON.parse(rawVal) : null;
    } catch (e) {
        result.music_queue = null;
    }
    result.music_queue_version = queueData ? queueData.version : null;
    
    // Debug log every 10 polls (approx 30s) to show it's alive
    if (Math.random() < 0.1) {
        console.log("Polling... Inbox:", result.bot_inbox ? "Found" : "Empty", "Queue:", result.music_queue ? "Found" : "Empty");
    }

    return result;
}

// 2. Write to Storage
async function updateStorage(key, value, version) {
    try {
        const payload = {
            value: typeof value === 'string' ? value : JSON.stringify(value),
            version: version, // Optimistic locking
            attributes: [] // Required by Highrise API
        };
        
        const res = await axios.put(`${API_BASE}/storage/object/${key}`, payload, { headers: getHeaders() });
        return res.data.version; // Return new version
    } catch (error) {
        console.error(`Error updating storage (${key}):`, error.message);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }
        return null;
    }
}

// 3. Resolve Song (Placeholder - You need a real music API here)
async function resolveSong(query) {
    console.log(`Resolving song: ${query}`);
    // TODO: Replace this with your actual Music API (e.g. YouTube DL, SoundCloud, etc.)
    // For now, we mock a response.
    return {
        title: `Song: ${query}`,
        url: "http://46.224.123.14:8000/radio", // Default to radio for testing
        duration: 30, // 30 seconds mock duration
        user: "Unknown"
    };
}

// 4. Fetch Game Logs (Debug)
async function fetchGameLogs() {
    try {
        const res = await axios.get(`${API_BASE}/management/logs?limit=5`, { headers: getHeaders() });
        if (res.data && res.data.values && res.data.values.length > 0) {
            console.log("--- Recent Game Logs ---");
            res.data.values.forEach(log => {
                console.log(`[${log.created_at}] ${log.message}`);
            });
            console.log("------------------------");
        }
    } catch (error) {
        // 403/401 means key doesn't have permission, which is fine, just ignore
        if (error.response && (error.response.status === 403 || error.response.status === 401)) {
            console.warn("Log fetch failed: Invalid permissions (Check API Key scopes)");
        } else {
            console.error("Error fetching logs:", error.message);
        }
    }
}

// Main Loop
async function main() {
    console.log("Highrise Music Bot Started...");
    if (HR_API_KEY) {
        console.log(`API Key loaded (Length: ${HR_API_KEY.length}). First 4 chars: ${HR_API_KEY.substring(0, 4)}...`);
    } else {
        console.error("API Key NOT loaded.");
    }
    
    let playingUntil = 0;

    while (true) {
        try {
            // Fetch logs to see if the game server is running/printing
            await fetchGameLogs();

            const storage = await fetchStorage();
            
            if (storage) {
                // Sync local queue with remote
                if (storage.music_queue) {
                    if (Array.isArray(storage.music_queue)) {
                        musicQueue = storage.music_queue;
                    } else if (storage.music_queue.q && Array.isArray(storage.music_queue.q)) {
                        musicQueue = storage.music_queue.q;
                    } else {
                        musicQueue = [];
                    }
                } else {
                    musicQueue = [];
                }

                let queueVersion = storage.music_queue_version;

                // --- CHECK INBOX ---
                if (storage.bot_inbox && storage.bot_inbox !== "") {
                    console.log("New Request found in Inbox:", storage.bot_inbox);
                    
                    try {
                        // Handle double-encoded JSON if necessary
                        let request;
                        try {
                            request = JSON.parse(storage.bot_inbox);
                            if (typeof request === 'string') request = JSON.parse(request);
                        } catch (e) {
                            request = storage.bot_inbox; // Fallback
                        }
                        
                        // Clear Inbox immediately
                        await updateStorage("bot_inbox", "", storage.bot_inbox_version);
                        
                        if (request && request.query) {
                            // Resolve Song
                            const songInfo = await resolveSong(request.query);
                            songInfo.user = request.user || "Unknown";
                            songInfo.userid = request.userid || "";
                            
                            // Add to Queue
                            musicQueue.push(songInfo);
                            console.log(`Added to queue: ${songInfo.title}`);
                            
                            // Update Queue in Game
                            // Wrap in Lua string block to prevent parsing errors
                            const payloadStr = `return [[${JSON.stringify({ q: musicQueue })}]]`;
                            const newVer = await updateStorage("music_queue", payloadStr, queueVersion);
                            if (newVer) queueVersion = newVer;
                        }
                        
                    } catch (e) {
                        console.error("Failed to process inbox:", e);
                        await updateStorage("bot_inbox", "", storage.bot_inbox_version); // Clear bad data
                    }
                }
                
                // --- PLAYBACK LOGIC ---
                if (isPlaying) {
                    // Check if song finished
                    if (Date.now() > playingUntil) {
                        console.log("Song finished:", currentSong ? currentSong.title : "Unknown");
                        
                        // Remove the top song (it was playing)
                        if (musicQueue.length > 0) {
                            musicQueue.shift();
                        }
                        
                        isPlaying = false;
                        currentSong = null;
                        
                        // Update Storage
                        // Wrap in Lua string block to prevent parsing errors
                        const payloadStr = `return [[${JSON.stringify({ q: musicQueue })}]]`;
                        await updateStorage("music_queue", payloadStr, queueVersion);
                    }
                } else {
                    // Not playing, check if we should start
                    if (musicQueue.length > 0) {
                        currentSong = musicQueue[0]; // Peek at top song
                        isPlaying = true;
                        playingUntil = Date.now() + (currentSong.duration * 1000);
                        
                        console.log(`Now Playing: ${currentSong.title} (Ends in ${currentSong.duration}s)`);
                        
                        // We keep it in the queue so clients can see it and play it.
                        // No storage update needed here unless we want to store "status".
                    }
                }
            }
            
        } catch (err) {
            console.error("Main loop error:", err);
        }
        
        await sleep(3000); // Poll every 3 seconds
    }
}

main();
