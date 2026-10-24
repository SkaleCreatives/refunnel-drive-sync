# refunnel-drive-sync

Your Refunnel UGC library in Google Drive, with a Google Sheet your media buyers can work in.

- Every video and image from a Refunnel export lands in your Drive, one folder per month of the post date
  (`2026-10/2026-10-22_tiktok_creator_tk_7123….mp4`).
- A Google Sheet lists every file: creator, products, rights status, GMV, impressions, likes, comments, shares,
  caption, a clickable Drive link and a Launch Status dropdown. Metrics are coloured white to green, so top
  performers stand out. A second tab shows live counts and what is missing.
- Run it again with a newer export: new files are added, known files get fresh numbers, your Launch Status and
  your own columns stay. Already have a Refunnel sheet? Point it there and it is extended, not replaced.

It runs in GitHub Actions in your own GitHub account and moves files from Refunnel's CDN straight into Drive.
Nothing passes through your computer, and 10,000 files (about 190 GB) take around 10 minutes.

Not affiliated with Refunnel.

## Setup (about 10 minutes, once)

**1. Copy this repository.** Click **Use this template** › **Create a new repository**. Public or private both work
(see [Cost](#cost)).

**2. Create a Google service account** (a robot account that writes into your Drive).
1. [console.cloud.google.com](https://console.cloud.google.com) › create a project, e.g. `refunnel-drive-sync`.
   Do not add a billing account: without one, the project cannot cost anything.
2. **APIs & Services › Library**: enable **Google Drive API** and **Google Sheets API**.
3. **IAM & Admin › Service Accounts › Create service account**. No roles needed.
4. Open it › **Keys › Add key › Create new key › JSON**. A `.json` file downloads.

**3. Give it access to your Drive folder.** Service accounts have no storage of their own, so the folder has to be in
a **shared drive**. Add the service account's e-mail (`…@….iam.gserviceaccount.com`) to the shared drive or the
folder as **Contributor** (or Content manager).
On Google Workspace you can instead let it act as a user (domain-wide delegation, scope
`https://www.googleapis.com/auth/drive`) and set `GOOGLE_SUBJECT` below; then any folder that user can edit works.

**4. Add the settings to your new repository** (Settings › Secrets and variables › Actions):

| Where | Name | Value |
| --- | --- | --- |
| Secret | `GOOGLE_SERVICE_ACCOUNT` | the whole content of the `.json` file |
| Secret (optional) | `GOOGLE_SUBJECT` | Workspace user to act as (only with domain-wide delegation) |
| Variable | `DRIVE_FOLDER` | link of the Drive folder, e.g. `https://drive.google.com/drive/folders/1AbC…` |
| Variable (optional) | `SHEET` | link of an existing sheet to extend. Empty = a sheet "Refunnel Content" is created in the folder |

## Every time you sync

**1. Export from Refunnel.** Export your content library as CSV in Refunnel. The right file has columns such as
`id`, `media_url`, `created_at` and `rights_status`.

**2. Put the CSV into the folder `_exports`** inside your Drive folder (create it the first time). The newest CSV there
is used. Keep old exports there or delete them, both are fine.

**3. Run it.** In your repository: **Actions › Refunnel sync › Run workflow**. Leave the fields empty to use your
settings. `limit` uploads only the first n files, handy for a first test.

When it is done, the run summary shows how many files were added and the link to the sheet.

## What you get

```
Your folder/
├── Refunnel Content          the sheet
├── _exports/                 your Refunnel CSVs
├── 2026-09/                  one folder per month of the post date
└── 2026-10/
    └── 2026-10-22_tiktok_creatorname_tk_7123456789012345678.mp4
```

Visible columns: Launch Status · Month · Created At · Creator · Drive Link · Type · Products · Rights Status · GMV ·
Impressions · Likes · Comments · Shares · Caption · ID · Updated At. Everything else from the export (platform, post
link, followers, hashtags, …) is there too, in hidden columns.

An existing sheet keeps its columns and order; the missing ones are added at the end. Columns are found by name, so
both Refunnel's names (`media_url`, `created_at`, …) and the names above work.

## Cost

Built to cost nothing:

- **Google:** Drive and Sheets APIs are free. A project without a billing account cannot be charged.
- **GitHub Actions:** free and unlimited in public repositories. In private ones a sync of 10,000 files uses about
  40 of the 2,000 free minutes per month; when free minutes run out, GitHub stops the run instead of charging, unless
  you have added a payment method and raised your budget.
- **Refunnel:** only reads the export you give it.

## Good to know

- Drive accepts up to 750 GB of uploads per account per day.
- Files that are gone on Refunnel's side (404) cannot be copied; the run lists them under `failed-*` (Artifacts).
- Usage rights: a file in your Drive is not a licence to run it as an ad. Check Rights Status first.

## How it works

`sync.mjs` (Node, no dependencies) reads the export, writes the sheet and lists what is missing in Drive.
`upload.sh` streams each file from `cdn.refunnel.com` into Drive with [rclone](https://rclone.org) in parallel.
`.github/workflows/sync.yml` ties it together. Run `node sync.mjs` for the commands.

## License

MIT
