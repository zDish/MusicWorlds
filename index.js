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
    }
    return {
        'highrise-api-key': HR_API_KEY,
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
            return res.data.value;
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
async function updateStorage(key, value) {
    try {
        const payload = {
            value: typeof value === 'string' ? value : JSON.stringify(value),
            version: undefined // Optional: Handle versioning if needed
        };
        
        await axios.put(`${API_BASE}/storage/object/${key}`, payload, { headers: getHeaders() });
        // console.log(`Updated storage: ${key}`);
    } catch (error) {
        console.error(`Error updating storage (${key}):`, error.message);
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

// Main Loop
async function main() {
    console.log("Highrise Music Bot Started...");
    
    while (true) {
        try {
            const storage = await fetchStorage();
            
            if (storage) {
                // --- CHECK INBOX ---
                if (storage.bot_inbox && storage.bot_inbox !== "") {
                    console.log("New Request found in Inbox:", storage.bot_inbox);
                    
                    try {
                        const request = JSON.parse(storage.bot_inbox);
                        
                        // Clear Inbox immediately
                        await updateStorage("bot_inbox", "");
                        
                        // Resolve Song
                        const songInfo = await resolveSong(request.query);
                        songInfo.user = request.user;
                        songInfo.userid = request.userid;
                        
                        // Add to Queue
                        musicQueue.push(songInfo);
                        console.log(`Added to queue: ${songInfo.title}`);
                        
                        // Update Queue in Game
                        await updateStorage("music_queue", musicQueue);
                        
                    } catch (e) {
                        console.error("Failed to process inbox:", e);
                        await updateStorage("bot_inbox", ""); // Clear bad data
                    }
                }
                
                // --- PLAYBACK LOGIC ---
                if (!isPlaying && musicQueue.length > 0) {
                    // Play next song
                    currentSong = musicQueue.shift();
                    isPlaying = true;
                    
                    console.log(`Now Playing: ${currentSong.title}`);
                    
                    // Update Game State (Clients listen to this to play music)
                    // We can reuse 'music_queue' or use a specific 'now_playing' key
                    // For now, we just updated the queue (removed the song).
                    // We should probably tell the game what to play.
                    
                    // Let's put the "Now Playing" song back at the top of the queue or use a separate key?
                    // The Lua script reads 'music_queue'. If we remove it, it disappears from UI.
                    // Usually, "Now Playing" is index 1.
                    
                    // Let's keep it simple: The top of the queue is playing.
                    // We wait for the duration, then remove it.
                    
                    // Update Storage with new Queue (Current song is gone? No, keep it while playing)
                    // Actually, let's keep it in the queue but mark it as playing?
                    // Or just remove it when it's done.
                    
                    // REVISED: Pop immediately, but maybe send a "Now Playing" signal?
                    // The Lua script just displays the list.
                    // Let's just wait.
                    
                    setTimeout(async () => {
                        console.log("Song finished.");
                        isPlaying = false;
                        currentSong = null;
                        // Update storage again (if we kept it in queue, remove it now)
                        // For this simple version, we popped it already.
                        await updateStorage("music_queue", musicQueue);
                    }, currentSong.duration * 1000);
                    
                    // Update Storage (Queue without the song? Or with it?)
                    // If we pop it, it disappears from UI.
                    // Let's add it back as "Playing" or just handle it.
                    // For now: Popped.
                    await updateStorage("music_queue", musicQueue);
                }
            }
            
        } catch (err) {
            console.error("Main loop error:", err);
        }
        
        await sleep(3000); // Poll every 3 seconds
    }
}

main();
