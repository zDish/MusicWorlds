require('dotenv').config();
const axios = require('axios');

// Configuration
const HR_API_KEY = process.env.HR_API_KEY;
const API_BASE = "https://api.worlds.highrise.game/api";

// State
let musicQueue = [];
let isPlaying = false;
let currentSong = null;
let playingUntil = 0; // Timestamp when current song ends

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
            return res.data; // Returns { key, value, version, ... }
        } catch (error) {
            if (error.response && error.response.status === 404) {
                // Key doesn't exist yet
                return null;
            }
            console.error(`Error fetching ${key}:`, error.message);
            return null;
        }
    };

    result.bot_inbox = await fetchKey('bot_inbox');
    result.music_queue = await fetchKey('music_queue');
    
    // Debug log every 10 polls (approx 30s) to show it's alive
    if (Math.random() < 0.1) {
        console.log("Polling... Inbox:", result.bot_inbox ? "Found" : "Empty", "Queue:", result.music_queue ? "Found" : "Empty");
    }

    return result;
}

// 2. Write to Storage
async function updateStorage(key, value, version, attributes = []) {
    try {
        const payload = {
            value: typeof value === 'string' ? value : JSON.stringify(value),
            attributes: attributes // Required by Highrise API
        };
        
        // Only include version if it's defined. 
        // If version is null/undefined, we omit it (treated as new object or force overwrite if API allows).
        if (version) {
            payload.version = version;
        }

        // console.log(`[DEBUG] Updating ${key} with version: ${version}`);
        
        const res = await axios.put(`${API_BASE}/storage/object/${key}`, payload, { headers: getHeaders() });
        return res.data; // Returns updated object with new version
    } catch (error) {
        console.error(`Error updating storage (${key}):`, error.message);
        if (error.response) {
            console.error("Response Status:", error.response.status);
            console.error("Response Data:", JSON.stringify(error.response.data));
        }
        throw error;
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
    // ... (Function body omitted for brevity, but kept in file)
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
    
    // Initial Load of Queue
    try {
        const initialStorage = await fetchStorage();
        if (initialStorage && initialStorage.music_queue && initialStorage.music_queue.value) {
            const storedQueue = JSON.parse(initialStorage.music_queue.value);
            if (Array.isArray(storedQueue)) {
                musicQueue = storedQueue;
                console.log(`Restored ${musicQueue.length} songs from storage.`);
            }
        }
    } catch (e) {
        console.error("Error restoring queue:", e);
    }
    
    while (true) {
        try {
            // Fetch logs to see if the game server is running/printing
            // await fetchGameLogs(); // Commented out to reduce noise/errors

            const storage = await fetchStorage();
            
            if (storage) {
                // --- CHECK INBOX ---
                const inboxData = storage.bot_inbox;
                const inboxValue = inboxData ? inboxData.value : "";
                // Version is nested in metadata
                const inboxVersion = (inboxData && inboxData.metadata) ? inboxData.metadata.version : null;

                if (inboxValue && inboxValue !== "") {
                    console.log("Raw Inbox Value:", inboxValue);
                    
                    try {
                        let request;
                        if (typeof inboxValue === 'string') {
                             // Handle potential double-encoding or just parse
                             try {
                                request = JSON.parse(inboxValue);
                             } catch (parseErr) {
                                 console.error("JSON Parse Error:", parseErr.message);
                                 // Fallback: maybe it's not JSON?
                                 request = { query: inboxValue, user: "Unknown", userid: "" };
                             }
                        } else {
                             request = inboxValue;
                        }
                        
                        if (typeof request === 'string') {
                            // Double encoded?
                            try {
                                request = JSON.parse(request);
                            } catch (e) {
                                // It's just a string
                                request = { query: request, user: "Unknown", userid: "" };
                            }
                        }

                        console.log("Parsed Request:", JSON.stringify(request));
                        
                        // Clear Inbox immediately
                        await updateStorage("bot_inbox", "", inboxVersion);
                        
                        // Resolve Song
                        const query = request.query || request; // Fallback if structure is different
                        const songInfo = await resolveSong(query);
                        songInfo.user = request.user || "Unknown";
                        songInfo.userid = request.userid || "";
                        
                        // Add to Queue
                        musicQueue.push(songInfo);
                        console.log(`Added to queue: ${songInfo.title}`);
                        
                        // Update Queue in Game
                        // Use the version from the fetch we just did
                        let queueVersion = (storage.music_queue && storage.music_queue.metadata) ? storage.music_queue.metadata.version : undefined;
                        
                        const newQueueObj = await updateStorage("music_queue", musicQueue, queueVersion);
                        
                        // Update local storage reference
                        if (storage.music_queue) {
                            if (!storage.music_queue.metadata) storage.music_queue.metadata = {};
                            storage.music_queue.metadata.version = newQueueObj.version;
                        } else {
                            storage.music_queue = { metadata: { version: newQueueObj.version } };
                        }
                        
                    } catch (e) {
                        console.error("Failed to process inbox:", e);
                        // Try to clear bad data
                        try {
                            await updateStorage("bot_inbox", "", inboxVersion);
                        } catch (clearErr) {
                            console.error("Failed to clear inbox:", clearErr.message);
                        }
                    }
                }
                
                // --- PLAYBACK LOGIC ---
                const now = Date.now();
                
                // Check if song finished
                if (isPlaying && now >= playingUntil) {
                    console.log("Song finished:", currentSong ? currentSong.title : "Unknown");
                    isPlaying = false;
                    currentSong = null;
                    
                    // Remove the finished song from the queue
                    musicQueue.shift();
                    
                    // Update Storage
                    let queueVersion = (storage.music_queue && storage.music_queue.metadata) ? storage.music_queue.metadata.version : undefined;
                    try {
                        const newQueueObj = await updateStorage("music_queue", musicQueue, queueVersion);
                        // Update local version
                        if (storage.music_queue) {
                            if (!storage.music_queue.metadata) storage.music_queue.metadata = {};
                            storage.music_queue.metadata.version = newQueueObj.version;
                        }
                    } catch (updateErr) {
                        console.error("Failed to update queue after song finish:", updateErr.message);
                    }
                }

                // Start playing next song if idle
                if (!isPlaying && musicQueue.length > 0) {
                    // Peek next song (keep it in queue so clients see it)
                    currentSong = musicQueue[0];
                    isPlaying = true;
                    playingUntil = now + (currentSong.duration * 1000);
                    
                    console.log(`Now Playing: ${currentSong.title} (Ends in ${currentSong.duration}s)`);
                    
                    // We don't strictly need to update storage here if the queue content hasn't changed.
                    // But if we want to add "status: playing" metadata, we would update here.
                    // For now, let's just leave it. The client assumes the first song is playing.
                }
            }
            
        } catch (err) {
            console.error("Main loop error:", err.message);
        }
        
        await sleep(3000); // Poll every 3 seconds
    }
}

main();
