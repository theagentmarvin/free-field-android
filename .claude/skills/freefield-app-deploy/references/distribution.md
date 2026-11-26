# Getting the app onto the tablets: the options

All four options install the same signed app. Pick by how many tablets there are and what IT allows. Whatever you choose, **keep the same application id and the same signing key for ever**, so updates install over the old app and keep its offline data.

| Option | Good for | Plain pros | Plain cons |
|---|---|---|---|
| **A. USB cable with adb** | 1 to about 10 tablets, a pilot | Fastest. The agent can do it. No accounts, no IT tools. Shows the exact error if something is wrong | You must touch every tablet for each update. Needs Developer options and USB debugging on the tablet, which some company policies forbid |
| **B. Copy the file** (cable, file share, download link) | A few tablets, or people installing their own | Needs nothing but the file. Works with any file-sharing the company already has | Each person must allow "install from this source" once and may meet a "Play Protect" warning. Easy to end up with different versions on different tablets. Updates are manual |
| **C. The company's device-management tool** | Tens of tablets or more, anything IT manages | Install and update without touching tablets. IT controls who gets what. Best for a rollout | Needs IT: they upload the `.apk` as a private (in-house) app and assign it to a group. Slower to start. Must use the same id and key for updates |
| **D. A private Google Play listing** | A company that already works with a managed Google Play account and wants Google to deliver updates | Updates arrive by themselves. No "unknown source" warnings. Fits a managed fleet | A one-time registration fee for a Google Play developer account. Reviews and setup take days. Uses the `.aab` file. **Google re-signs the app with its own key**, so the sign-in link file must also list Google's key (below) |

## Which to suggest

- Pilot with a handful of tablets: **A**, and **B** for the rest.
- Company rollout with a device-management tool: **C**. Send IT `references/it-request-template.es.md` or `.en.md`.
- A company that already publishes private apps through a managed Google Play account: **D**.

## What each option needs from the user

- **A:** the cable, the tablet unlocked, "USB debugging" on, accept the prompt on the tablet. Steps in `build-steps.md` §3.
- **B:** after copying, open the `.apk`; allow installs from that source when asked; tap **Install**; if a Play Protect box says the app is unknown, **More details, Install anyway**.
- **C:** build the `.apk`, hand it to IT with the application id (`{{APPLICATION_ID}}`) and version. Every update uses a higher `versionCode`.
- **D:** build with `node scripts/build-android.mjs --aab`. A Google Play Console developer account (ask before anyone pays the fee), upload the `.aab` to a private or internal track limited to the company. In Play Console, **App integrity**, copy the **App signing key certificate SHA-256**, then:
  ```bash
  node scripts/make-assetlinks.mjs --fingerprint {{OUR_KEY_SHA256}} --fingerprint {{PLAY_KEY_SHA256}}
  ```
  Put the new `signing/assetlinks.json` in the website repository (`apps/settings/public/.well-known/assetlinks.json`) and redeploy the website, otherwise the sign-in link opens the browser on tablets installed from Play. This touches production: ask first.

## After installing, for every option

- The first launch asks for a sign-in with a work e-mail address that was **invited in FreeField**.
- Tablets need internet only for sign-in, for downloading buildings for offline use, and for syncing.
- Do not wipe, factory-reset or uninstall a tablet as a routine fix: unsynced changes and offline buildings live only on it. Check the **Sync** tab is empty first.
