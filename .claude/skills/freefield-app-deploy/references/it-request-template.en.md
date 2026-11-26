# Request to IT: our FreeField field app on company tablets (English)

Fill every `{{…}}`, delete what does not apply. Nothing in it is secret. The agent writes **two pieces**: a short cover email (what people actually read) and the technical annex. Never invent hosts, ids or numbers: ask the user or leave the placeholder. Do not quote prices.

## Piece 1: cover email (at most 15 lines)

**Subject:** Request: install our FreeField field app on {{N_TABLETS}} company tablets

Hi {{IT_CONTACT}},

We want to use the FreeField field app (an open-source Android app for site tasks, plans and 3D models that also works without a connection) on {{N_TABLETS}} company tablets from {{START_DATE}}. We build it ourselves, signed with our own key, and it signs in against our own FreeField website `{{WEBSITE_ADDRESS}}`, which already runs on our Firebase project. It is not published in any public store.

We need four things from you:
1. Downloads allowed through the proxy or firewall on the build computer ({{BUILD_COMPUTER}}) for the one-time tool setup and for each build.
2. A way to install the app on the tablets: {{PREFERRED_INSTALL_METHOD}}.
3. Network access from the tablets to our website and the Google services it uses.
4. A short website deploy window, so the website can publish the file that makes the sign-in link open the app.

Open questions: {{OPEN_QUESTIONS}}. Details are in the attached annex.

Thanks,
{{REQUESTER_NAME}}, {{REQUESTER_ROLE}}

## Piece 2: technical annex

### 1. What this is
- App: {{APP_NAME}}, application id `{{APPLICATION_ID}}`, Android 8 or newer, tablets: {{TABLET_MODEL_OR_FLEET}}.
- Built on one computer with Node.js 20, Java 21 and the Android SDK, all installed in the user's own folder (about 6 GB, **no administrator rights**). Signed with a company key kept in the company password manager.
- The app stores its working data on the tablet and syncs with our Firebase project through the existing website backend (Authentication, Firestore, Storage).

### 2. Downloads allowed on the build computer (HTTPS)
- `github.com`, `objects.githubusercontent.com`: Java 21 runtime (Eclipse Temurin) and our repository.
- `dl.google.com`, `maven.google.com`, `dl-ssl.google.com`: Android SDK and libraries.
- `repo.maven.apache.org`, `repo1.maven.org`, `plugins.gradle.org`, `services.gradle.org`, `downloads.gradle.org`: build tool and libraries.
- `registry.npmjs.org`: JavaScript packages. `api.adoptium.net` if the proxy needs it.
- For the one-time Firebase sign-in: `accounts.google.com`, `oauth2.googleapis.com`, `firebase.googleapis.com`.
- Please do not block `.apk` files, `adb`, or USB debugging on this computer.

### 3. Installing on the tablets (choose one and tell us)
- [ ] **USB cable with USB debugging** for a few tablets (policy must allow Developer options).
- [ ] **File copy / download link**: allow "install from this source" for the file manager or browser.
- [ ] **Our device-management tool**: upload the signed `.apk` as a private (in-house) app, assign it to group {{TABLET_GROUP}}. Each update has the same application id and signing key and a higher version number.
- [ ] **A private Google Play listing** for our organization: we upload an `.aab`; we need a Google Play Console developer account (one-time registration fee, whoever pays) or access to the company's. Google signs with its own key, so we will give you that fingerprint for the website file.

### 4. Tablet network access (HTTPS, port 443)
`{{WEBSITE_ADDRESS}}`, `{{FIREBASE_PROJECT_ID}}.firebaseapp.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com`, `firebasestorage.googleapis.com`. If TLS inspection is on, tell us: it can break these connections.

### 5. E-mail
Sign-in links come from Firebase (`noreply@{{FIREBASE_PROJECT_ID}}.firebaseapp.com`). Please make sure the mail filter and link protection do not block or rewrite them.

### 6. Website deploy window
The website must serve `https://{{WEBSITE_ADDRESS}}/.well-known/assetlinks.json` (a small public file with the app id and the key's public fingerprint). It is added to the website repository and deployed with the normal website deploy. Window: {{DEPLOY_WINDOW}}.

### 7. Facts for IT
- Open source, MIT licence, no support SLA. The signing key belongs to the company.
- Uninstalling the app or wiping a tablet deletes its offline data and any unsynced changes. Please do not do either as a routine fix.
- Updates install over the old version (same application id, same key).
- Optional, only if builds should run on GitHub instead of a laptop: GitHub Actions minutes for a private repository (about {{BUILD_MINUTES}} minutes per build).
