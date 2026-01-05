import os
import sys
import time
import json
import requests
import urllib.parse
from dotenv import load_dotenv

# Force unbuffered output for Railway logs
sys.stdout.reconfigure(line_buffering=True)

print("Initializing Bridge Script...")

# Load environment variables
load_dotenv()

# Configuration
HR_API_KEY = os.getenv("HR_API_KEY")
API_BASE = "https://api.worlds.highrise.game/api"
VPS_URL = "http://46.224.123.14:5000/play"

if not HR_API_KEY:
    print("CRITICAL: HR_API_KEY is missing! Make sure it is set in your Railway variables.")
    # We don't exit here to allow the script to run and print the error logs, 
    # but it won't work without the key.
    
HEADERS = {
    "Authorization": f"Bearer {(HR_API_KEY or '').strip()}",
    "Content-Type": "application/json"
}

# State
last_processed_id = None 
music_queue = []
is_playing = False
playing_until = 0
queue_version = None

def fetch_storage(key):
    try:
        res = requests.get(f"{API_BASE}/storage/object/{key}", headers=HEADERS, timeout=10)
        if res.status_code == 404: return None
        if res.status_code == 200: return res.json()
        return None
    except Exception as e:
        print(f"Error fetching storage {key}: {e}")
        return None

def update_storage(key, value, version):
    try:
        # Wrap in Lua string block to prevent parsing errors
        # Format: return [[ { "q": [...] } ]]
        json_val = json.dumps(value)
        payload_str = f"return [[{json_val}]]"
        
        payload = {
            "value": payload_str,
            "attributes": []
        }
        
        # Only include version if we have it. 
        # Sending 'null' can cause 400 Bad Request.
        if version is not None:
            payload["version"] = version
            
        res = requests.put(f"{API_BASE}/storage/object/{key}", json=payload, headers=HEADERS, timeout=10)
        if res.status_code == 200:
            # The response for PUT returns the metadata directly (created_at, updated_at, version)
            # according to some docs, OR it returns the full object.
            # Let's safely check for version in both places.
            resp_data = res.json()
            if "version" in resp_data:
                return resp_data["version"]
            elif "metadata" in resp_data and "version" in resp_data["metadata"]:
                return resp_data["metadata"]["version"]
            return None
        else:
            print(f"Failed to update storage {key}: {res.status_code} - {res.text}")
            return None
    except Exception as e:
        print(f"Exception updating storage {key}: {e}")
        return None

def sync_queue():
    global music_queue, queue_version
    data = fetch_storage("music_queue")
    if data:
        # Version is nested in metadata in the GET response
        # Structure: { "key": "...", "value": "...", "metadata": { "version": 1, ... } }
        meta = data.get("metadata", {})
        queue_version = meta.get("version")
        
        raw_val = data.get("value")
        
        # Unwrap Lua string block: return [[...]]
        if raw_val and isinstance(raw_val, str) and raw_val.startswith("return [["):
            try:
                # Extract content between [[ and ]]
                # Simple parsing assuming no nested ]]
                content = raw_val.replace("return [[", "").replace("]]", "")
                parsed = json.loads(content)
                if isinstance(parsed, dict) and "q" in parsed:
                    music_queue = parsed["q"]
                else:
                    music_queue = []
            except:
                music_queue = []
        else:
            # Fallback for old format or empty
            music_queue = []
    else:
        music_queue = []
        queue_version = None

def fetch_logs():
    try:
        # Fetch recent logs
        # Increased limit to 50 to catch logs during high traffic
        response = requests.get(f"{API_BASE}/management/logs?limit=50", headers=HEADERS, timeout=10)
        
        if response.status_code == 429:
            print("Rate limited (429). Waiting 10 seconds...")
            time.sleep(10)
            return []
            
        if response.status_code != 200:
            print(f"Error fetching logs: {response.status_code} - {response.text}")
            return []
            
        data = response.json()
        # Highrise logs are in 'values' array
        return data.get("values", [])
        
    except Exception as e:
        print(f"Exception fetching logs: {e}")
        return []

def process_logs():
    global last_processed_id
    
    logs = fetch_logs()
    if not logs:
        return

    # Debug: Print the newest log to verify connectivity
    # (Only print if it's different from the last one we saw to avoid spam)
    newest_log = logs[0]
    newest_id = newest_log.get("id") or newest_log.get("timestamp") or newest_log.get("created_at")
    
    # Logs usually come newest first.
    # If this is the first run, we don't want to process old logs (history).
    # We just mark the latest log as the starting point.
    if last_processed_id is None:
        last_processed_id = newest_id
        
        if last_processed_id is None:
            print(f"DEBUG: Could not find ID in log entry. Keys: {list(newest_log.keys())}")
            return
        
        print(f"Bridge initialized. Last Log ID: {last_processed_id}")
        print(f"DEBUG: Newest Log Message: {newest_log.get('message')}")
        return

    # If we have a last_processed_id, we process only newer logs.
    # Reverse to process oldest -> newest
    logs.reverse()
    
    for log in logs:
        # Use 'id' if available, otherwise fallback to timestamp or created_at
        current_id = log.get("id") or log.get("timestamp") or log.get("created_at")
        
        if not current_id:
            continue

        # Skip if already processed (or older)
        # Ensure we are comparing same types (strings vs strings)
        if last_processed_id and str(current_id) <= str(last_processed_id):
            continue
            
        message = log.get("message", "")
        
        # Debug: Print all new messages to see what we are receiving
        print(f"DEBUG: Processing Log: {message}")
        
        # Look for our specific pattern from Lua: "!play <song> | <user> | <userid>"
        if message.startswith("!play "):
            print(f"Found command: {message}")
            
            try:
                # Parse: !play Song Name | User | UserID
                parts = message.split("|")
                if len(parts) >= 3:
                    # !play Song Name -> remove "!play " prefix
                    raw_query = parts[0].strip()[6:] 
                    user = parts[1].strip()
                    userid = parts[2].strip()
                    
                    # Send to VPS
                    print(f"Forwarding to VPS: '{raw_query}' from {user}")
                    
                    try:
                        vps_res = requests.get(
                            f"{VPS_URL}",
                            params={"q": raw_query, "user": user, "userid": userid},
                            timeout=10
                        )
                        
                        if vps_res.status_code == 200:
                            print("VPS accepted request.")
                            
                            # Add to Highrise Queue
                            # We assume the VPS returns song info, or we mock it
                            # For now, we create a song object
                            song_info = {
                                "title": raw_query, # Ideally get real title from VPS response
                                "user": user,
                                "userid": userid,
                                "duration": 30, # Mock duration or get from VPS
                                "url": "http://46.224.123.14:8000/radio"
                            }
                            
                            # Try to parse VPS response for real info
                            try:
                                vps_data = vps_res.json()
                                if vps_data:
                                    if "title" in vps_data: song_info["title"] = vps_data["title"]
                                    if "duration" in vps_data: song_info["duration"] = vps_data["duration"]
                            except:
                                pass
                                
                            music_queue.append(song_info)
                            print(f"Added to queue: {song_info['title']}")
                            
                            # Update Storage
                            new_ver = update_storage("music_queue", {"q": music_queue}, queue_version)
                            if new_ver: queue_version = new_ver
                            
                        else:
                            print(f"VPS Error: {vps_res.status_code} - {vps_res.text}")
                    except Exception as vps_e:
                        print(f"Failed to connect to VPS: {vps_e}")
                        
            except Exception as e:
                print(f"Error processing log message '{message}': {e}")
        
        # Update last processed
        last_processed_id = current_id

def manage_playback():
    global is_playing, playing_until, current_song, music_queue, queue_version
    
    if is_playing:
        if time.time() > playing_until:
            print("Song finished.")
            if music_queue:
                music_queue.pop(0) # Remove finished song
                
                # Update Storage
                new_ver = update_storage("music_queue", {"q": music_queue}, queue_version)
                if new_ver: queue_version = new_ver
            
            is_playing = False
    else:
        if music_queue:
            current_song = music_queue[0]
            duration = current_song.get("duration", 30)
            print(f"Now Playing: {current_song.get('title')} ({duration}s)")
            
            playing_until = time.time() + duration
            is_playing = True

def main():
    print("Starting Highrise-VPS Bridge (Python)...")
    print(f"Target VPS: {VPS_URL}")
    
    # Initial Sync
    sync_queue()
    print(f"Queue synced. {len(music_queue)} songs.")
    
    # FORCE CLEANUP: Overwrite storage with correct format to stop Lua errors
    # The current errors in logs ([string "music_queue"]:1: Expected '}') mean the storage 
    # has raw JSON instead of the Lua wrapper. We must overwrite it to fix the game server.
    print("Sanitizing storage to ensure correct format...")
    global queue_version
    # Even if queue is empty, we write it back wrapped in return [[...]]
    new_ver = update_storage("music_queue", {"q": music_queue}, queue_version)
    if new_ver:
        queue_version = new_ver
        print("Storage sanitized successfully. Lua errors should stop.")
    else:
        print("Warning: Failed to sanitize storage.")
    
    while True:
        process_logs()
        manage_playback()
        time.sleep(3) # Poll every 3 seconds

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"CRITICAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        # Sleep to prevent rapid restart loops if it crashes immediately
        time.sleep(10)
