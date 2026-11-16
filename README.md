# refunnel-drive-sync

Your Refunnel UGC library in your own Google Drive, plus a Google Sheet your media buyers can work in.

- Every video and image from your Refunnel export lands in your Drive folder, one folder per month
  (`2026-10/2026-10-22_tiktok_creatorname_tk_7123….mp4`).
- A Google Sheet lists every file: creator, products, rights status, GMV, impressions, likes, comments, shares,
  caption, a clickable Drive link and a Launch Status dropdown. Top performers are coloured green.
- Run it again with a newer export: new files are added, the rest gets fresh numbers. Your Launch Status and your own
  columns stay.

Free. You sign in with your normal Google account. Not affiliated with Refunnel.

## How to use

1. **Download this repository:** green **Code** button › **Download ZIP**, then unzip it.
2. **Install Node.js** once, if you do not have it: [nodejs.org](https://nodejs.org), the LTS button.
3. **Export your content from Refunnel** as CSV.
4. **Start it:** open the Terminal in the unzipped folder and run

   ```
   ./start.sh
   ```

   - The first time, a browser window opens: sign in with Google and click **Allow**.
   - Paste the link of the Drive folder the files should go into.
   - Drag the Refunnel CSV into the Terminal window and press Enter.
   - Paste the link of an existing sheet to extend, or just press Enter for a new one.

That's it. When it is done, it shows the link to your sheet.

Prefer an AI assistant? Open the folder in Claude (or any coding assistant) and say: *"Run ./start.sh with my
Refunnel export"*.

## Good to know

- The files go from Refunnel straight into Google Drive; nothing is stored on your computer. They do pass through
  your internet connection, so large libraries take a few hours. You can stop any time and run `./start.sh` again:
  it continues where it stopped.
- Files Refunnel no longer has cannot be copied; they are listed in `failed.txt`.
- Mac and Linux. On Windows use WSL.
- A file in your Drive is not a licence to use it in ads. Check the Rights Status column first.
- Your Google sign-in stays on your computer only (`rclone.conf` in this folder). Delete that file to sign out.

## License

MIT
