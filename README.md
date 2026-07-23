# Viento OS

Viento OS is the automation base for Viento Art's social media agents.

## What is active now

- Generates one daily bilingual Instagram/TikTok content concept with Gemini.
- Renders a vertical branded image by default.
- Can render MP4 video too by setting repository variable `SOCIAL_ASSET_TYPE=video`.
- Uploads the image/video to Cloudinary with a stable public HTTPS URL.
- Adds the post to the connected Instagram and TikTok Buffer queues.
- Runs every day at 09:00 Europe/Istanbul through GitHub Actions.

## Required GitHub secrets

Add these in `Settings > Secrets and variables > Actions`:

- `BUFFER_API_KEY`
- `GEMINI_API_KEY`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## Manual test

Open `Actions > Viento Social Agent > Run workflow`.

For the first test, choose:

- `dry_run`: `true`

If it works, run again with:

- `dry_run`: `false`

## Notes

This first version is intentionally free-first. It creates a simple branded visual card. Later versions can add a real asset library, higher-quality AI video generation, Buffer analytics learning, trend tracking, and approval gates for paid ads.
