# Highrise Music Bot (Railway)

This is the backend service for your Highrise World Music Player. It connects to the Highrise Web API to manage the music queue.

## Setup on Railway

1.  **Create a New Project** on [Railway.app](https://railway.app/).
2.  **Upload this folder** (or connect a GitHub repo with these files).
3.  **Add Environment Variables** in Railway:
    *   `HR_API_KEY`: Your Highrise API Key (Permissions: `storage:read`, `storage:write`).
    *   (No `ROOM_ID` needed anymore).

## How it Works

1.  **Polling**: The bot checks the `bot_inbox` storage key every 3 seconds.
2.  **Processing**: If it finds a request, it clears the inbox and adds the song to the `music_queue`.
3.  **Playback**: It manages the queue and updates the `music_queue` storage key so players can see what's playing.

## Customization

*   **Music Source**: Currently, `resolveSong` in `index.js` is a placeholder. You need to integrate a real music API (like YouTube DL or a search API) to get actual MP3 URLs and durations.
