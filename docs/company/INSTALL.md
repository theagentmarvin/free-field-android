# Install the FreeField field app on your company's tablets

This guide takes you from "nothing" to "the app runs on a tablet". The app is built **on your own computer**, driven step by step by the Claude Code agent (the FreeField "deploy" skill walks you through it). You type nothing technical yourself; you make a few decisions and click "Allow" in a browser a couple of times.

What you end up with: your own private copy of the app, named for your company, signed with **your** key, that signs people in against **your** FreeField website, installed on your tablets.

## 0. Before you start

- **A computer** with Windows, macOS or Linux, about **6 GB of free disk space** (the tools take about 3 GB, the first build about 2 GB more). No administrator rights are needed: everything is installed for your user only.
- **Node.js 20 or newer**, **pnpm** and **Git**: the same three things the FreeField website needs. (`node -v`, `pnpm -v`, `git --version` should all print a version.)
- Internet access to download tools (list for IT in `docs/company/IT-REQUEST.md`).
- Your company's **FreeField website already online** on its own Firebase project, with sign-in working (`docs/deploy/self-hosting.md` in the FreeField web repository).
- Android tablets, Android 8 or newer.

At any point, this tells you what is still missing, in plain words, without showing any secret:

```bash
node scripts/check-app-setup.mjs          # add --ascii on an old Windows console
```

## 1. Make your private copy

A *fork* of a public repository is always public, so **do not fork**. Use one of these:

- **"Use this template"**: on the public field-app repository click the green **Use this template** > **Create a new repository**, choose your company as owner and **Private**.
- **Import**: <https://github.com/new/import>, paste the address of the public repository, choose **Private**.

Then get it onto your computer **with the FreeField web code it is built from** (the `vendor/free-field` "submodule"):

```bash
git clone --recurse-submodules <address of your private repository>
cd <the folder>
```

If you already cloned without it: `git submodule update --init`. Check that the folder `vendor/free-field` is not empty.

## 2. Install the build tools (once)

```bash
pnpm install
node scripts/setup-android-toolchain.mjs --check              # what is missing; changes nothing
node scripts/setup-android-toolchain.mjs --accept-licenses
```

The agent shows you the two licences first (Google's Android SDK terms and the open-source Temurin Java licence). `--accept-licenses` means you accepted them. The script installs, into `~/.freefield-android` (on Windows `C:\Users\<you>\.freefield-android`):

- **Java 21** (a pinned Eclipse Temurin download, its checksum is verified), only if Java 21 is not already installed;
- the **Android SDK** command-line tools, the platform and build-tools this app needs, and **adb** (the USB install tool).

It reports progress as it goes and is safe to run again; finished parts are skipped. Nothing is changed outside that folder (it also writes `apps/mobile/android/local.properties`, which Git ignores).

## 3. Fill in `company.config.json`

Open `company.config.json` in the repository root (the agent edits it with you). Change the values on the right:

| Name | What to write | Notes |
|---|---|---|
| `appName` | The name under the app icon, up to 30 characters | Example: `Acme Field` |
| `applicationId` | The app's unique technical name: lowercase, parts separated by dots | Example: `com.acme.field`. **Choose it once. Changing it later makes a different app**: tablets treat it as new and the old one keeps its offline data |
| `versionName` | The version people see | Example: `1.0.0` |
| `versionCode` | A whole number. **Raise it by 1 for every new version you publish** | Tablets only accept updates with a higher number |
| `authLinkDomain` | Your company's FreeField website address, without `https://` | Example: `freefield.acme.com` or `acme-field.web.app`. Sign-in e-mail links point here |
| `signingCertSha256` | Leave empty: the key helper fills it in (part 5) | Public information |

With `authLinkDomain` empty or still `freefield.example.com`, the build stops with a clear message. The app never falls back to anybody else's website.

## 4. Firebase settings

The app must talk to the same Firebase project as your website. It needs the project's **web app configuration**: six values that are public by design (every browser that opens your website already downloads them). They go in the Git-ignored file `apps/mobile/.env.production`, with the same `VITE_*` names the website uses, plus the safety catch `VITE_EXPECTED_FIREBASE_PROJECT_ID` (it must equal the project id, or the build stops, so a build can never be made for the wrong project).

The easy way, with the Firebase tool (it opens a browser once to sign in with your company Google account; you click Allow; nobody sees your password):

```bash
npx firebase-tools login
node scripts/fetch-firebase-config.mjs --project <your-firebase-project-id>
```

Or, if you still have the website's `.env.production`: `node scripts/fetch-firebase-config.mjs --from <path to that file>`. Or copy `apps/mobile/.env.example` to `apps/mobile/.env.production` and fill it in from Firebase console > Project settings > Your apps > Web app > Config.

## 5. Create the signing key (once)

Every Android app must be signed. The key is **your company's identity for this app**:

> **Never lose the key and never change it.** A tablet only accepts an update signed with the same key as the installed app. With a different key, the only way forward is to uninstall the app, which **erases the tablet's offline data**. **Back the key up in your company password manager right away.**

```bash
node scripts/make-signing-key.mjs
```

It creates the key with Java's `keytool` in the folder `signing/`, with random passwords that are stored only in the file `signing.local.properties` (and are never printed on screen or sent anywhere). It prints the key's SHA-256 fingerprint, writes it into `company.config.json`, and writes `signing/assetlinks.json` for part 6.

Then, **right now**:
1. Save these two things in your company password manager: the key file `signing/<id>.p12` and the file `signing.local.properties` (they hold the passwords). Do not paste the passwords into chats or e-mails.
2. Commit the updated `company.config.json` (the fingerprint is not secret). Git ignores the key and the passwords file on purpose; never add them.

## 6. Make sign-in e-mail links open the app

Sign-in uses an e-mailed link. For Android to open that link **in the app** (not in a browser), your **website** has to publish a small file that says "this app, signed with this key, may open my links".

1. In your **FreeField web repository** (the one you deploy the website from) add `signing/assetlinks.json` as:

   `apps/settings/public/.well-known/assetlinks.json`

   (the folder name starts with a dot). You can regenerate it any time: `node scripts/make-assetlinks.mjs`.
2. Deploy the website again as usual.
3. Open `https://<your website>/.well-known/assetlinks.json` in a browser: you should see the JSON text, not the website's home page. (`node scripts/check-app-setup.mjs` checks this too.)

How the website serves it: the website build copies everything under `public/`, dot-folders included. FreeField's `firebase.json` does not exclude dot-files, and Firebase Hosting only uses its "send everything to index.html" rule when no real file exists, so the file is served as it is, typed `application/json` from the `.json` ending. Normally you do **not** need to change `firebase.json`. If the check says the type is wrong, or someone added `**/.*` to the `ignore` list, add this to the `headers` list in the `hosting` section of the web `firebase.json`, and make sure `.well-known` is not ignored:

```json
{
  "source": "/.well-known/assetlinks.json",
  "headers": [
    { "key": "Content-Type", "value": "application/json" },
    { "key": "Cache-Control", "value": "no-cache" }
  ]
}
```

The same content is also served on the project's `...firebaseapp.com` address, which the app also listens to, so one file is enough.

**What happens without this file?** The app still installs and works, offline too. But when someone taps the sign-in link in their e-mail, Android does **not** hand it to the app automatically. Depending on the tablet it opens in the browser or asks which app to use. Opening it in the browser signs the person in on the *website*, not in the app, and the app keeps showing its sign-in screen (the app has no "paste the link" box). Workaround on the tablet: Settings > Apps > your app > **Open by default** > add your website address, then tap the e-mail link again. Publishing the file is the proper fix and takes one website deploy. Android checks the file when the app is installed, so after publishing it, **reinstall** the app.

If your tablets get the app from a private Google Play listing, Google re-signs the app with its own key. Add Play's fingerprint too (Play Console > App integrity > App signing key certificate SHA-256) and run `node scripts/make-assetlinks.mjs --fingerprint <yours> --fingerprint <Play's>`.

## 7. Build the app

```bash
node scripts/build-android.mjs            # the .apk for tablets
node scripts/build-android.mjs --aab      # also the .aab, only for a private Google Play listing
```

It checks your settings first and tells you in plain words if anything is missing (settings, Firebase file, key, tools). Then it builds the app (the first build downloads a lot and takes 10 to 20 minutes; later ones are faster), signs it with your key, verifies the signature, the app id and the name, and writes:

`release/<AppName>-<version>.apk`

## 8. Install it on tablets

Pick what fits (more in `docs/company/IT-REQUEST.md`):

- **USB cable (a few tablets, fastest).** On the tablet: Settings > About tablet > tap **Build number** 7 times, then Settings > Developer options > **USB debugging** on. Connect the cable, accept the "Allow USB debugging?" box on the tablet. On the computer: `<home>/.freefield-android/sdk/platform-tools/adb install -r release/<AppName>-<version>.apk` (the setup script installed adb there; on Windows `adb.exe`).
- **Copy the file.** Put the `.apk` on the tablet (USB file transfer, a company file share, a download link). Open it; Android asks to **allow installs from this source** (the Files or browser app): allow for that one app, go back, tap **Install**. If a "Play Protect" box says the app is unknown: **More details > Install anyway** (it appears for every app that does not come from Google Play).
- **Your company's device-management tool.** Upload the `.apk` as an in-house (private) app and assign it to the tablets: installs and updates happen without touching them. Use the same app id and key for updates.
- **A private Google Play listing.** Build with `--aab`, upload the `.aab` to a Google Play Console developer account (one-time registration fee), published only to your organization. Google signs the installed app with its own key: add that fingerprint to `assetlinks.json` (end of part 6).

Then open the app and sign in with a work e-mail address that your FreeField project has invited.

Remember:
- **An older build with a different app id or key cannot be updated.** The tablet says "App not installed" / "conflicts with an existing package". Uninstall the old one first (this deletes its offline data), then install.
- **Keep the same app id and key for ever**, so updates install on top and keep the offline data.

## 9. Update the app later

1. **Get the newer app code** (the agent does this and tells you if your own changes collide with the update):
   ```bash
   git remote add upstream <address of the public repository>      # first time only
   git fetch upstream
   git merge upstream/main
   git submodule update --init
   pnpm install
   ```
2. In `company.config.json` raise `versionCode` by 1 and update `versionName`.
3. `node scripts/build-android.mjs`, then install the new `.apk` **over** the old one (part 8). Same app id, same key: the offline data stays.

A new version of the FreeField **website** does not need a new app build, unless the website address changes.

## 10. Troubleshooting

| What you see | What it means and what to do |
|---|---|
| The build stops with "The app cannot be built yet" and a list | Do what each line says. They point to `company.config.json`, `apps/mobile/.env.production`, the key, or the tools |
| "Java 21 was not found" / "The Android SDK was not found" | `node scripts/setup-android-toolchain.mjs --accept-licenses` |
| Download fails or a checksum does not match during setup | A company proxy blocks or alters downloads: ask IT (`docs/company/IT-REQUEST.md`) |
| "There is no signing key yet" | `node scripts/make-signing-key.mjs` (part 5). If you already have the key, restore `signing/` and `signing.local.properties` from the password manager |
| "This key is not the one named in company.config.json" | You are using another key than the one the website was told about. Use the original key |
| "VITE_EXPECTED_FIREBASE_PROJECT_ID must be exactly the same..." | Fix the typo in `apps/mobile/.env.production` |
| "The FreeField web code (vendor/free-field) is missing" | `git submodule update --init` |
| Out of disk space | Free about 6 GB, or install on another drive: `node scripts/setup-android-toolchain.mjs --dir D:\freefield-android --accept-licenses` and set `FFM_TOOLCHAIN_DIR` to the same folder |
| Tablet: "App not installed" | A build with another key or app id is installed: uninstall it first. Or the file is damaged: copy it again |
| Tablet blocks the file | Allow installs from that source (part 8), or a company policy blocks it: ask IT |
| Sign-in e-mail never arrives | Spam folder; was the address invited in FreeField; Firebase console > Authentication > Sign-in method: **Email link** on; your website address listed under Authentication > Settings > **Authorized domains** (custom domains are not added automatically) |
| Tapping the e-mail link opens the browser, not the app | `assetlinks.json` is missing or wrong on your website (part 6). `node scripts/check-app-setup.mjs` tests it. Then reinstall the app |
| The app shows a "configuration" or "tenant" error at start | The Firebase settings point at a different project than expected: fix `apps/mobile/.env.production` and build again |
