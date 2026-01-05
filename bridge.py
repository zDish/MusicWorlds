import os
import time
import requests
import urllib.parse
from dotenv import load_dotenv

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
# In a real production env, store this in a file or DB to persist across restarts.
last_processed_id = None 

def fetch_logs():
    try:
        # Fetch recent logs
        # limit=20 is usually enough for polling every few seconds
        response = requests.get(f"{API_BASE}/management/logs?limit=20", headers=HEADERS, timeout=10)
        
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

    # Logs usually come newest first.
    # If this is the first run, we don't want to process old logs (history).
    # We just mark the latest log as the starting point.
    if last_processed_id is None:
        # Assuming logs[0] is the newest (standard API behavior)
        # We need to find the absolute latest ID in this batch
        latest_log = logs[0]
        # Try multiple common fields for ID/Time
        last_processed_id = latest_log.get("id") or latest_log.get("timestamp") or latest_log.get("created_at")
        
        if last_processed_id is None:
            print(f"DEBUG: Could not find ID in log entry. Keys: {list(latest_log.keys())}")
            # If we can't find an ID, we can't track state. 
            # We'll just return and try again next loop, hoping for a better log or user intervention.
            return
        
        print(f"Bridge initialized. Last Log ID: {last_processed_id}. Waiting for new commands...")
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
                        else:
                            print(f"VPS Error: {vps_res.status_code} - {vps_res.text}")
                    except Exception as vps_e:
                        print(f"Failed to connect to VPS: {vps_e}")
                        
            except Exception as e:
                print(f"Error processing log message '{message}': {e}")
        
        # Update last processed
        last_processed_id = current_id

def main():
    print("Starting Highrise-VPS Bridge (Python)...")
    print(f"Target VPS: {VPS_URL}")
    
    while True:
        process_logs()
        time.sleep(3) # Poll every 3 seconds

if __name__ == "__main__":
    main()
