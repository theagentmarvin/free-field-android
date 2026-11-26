# What to ask IT for (field app on company tablets)

Copy this into an e-mail, fill every `{{...}}`, delete what does not apply. Nothing in it is secret.

---

**Subject:** Request: build and install our FreeField field app on company tablets ({{N_TABLETS}} devices)

Hi {{IT_CONTACT}},

We want to use the FreeField field app (an open-source Android app for site tasks, plans and 3D models that also works offline) on {{N_TABLETS}} company tablets, starting {{START_DATE}}. We build it ourselves on {{BUILD_COMPUTER, e.g. my work laptop}}, signed with our own key, and it signs in against our FreeField website `{{WEBSITE_ADDRESS}}`, which already runs in our own Firebase project. It is not published in any public store.

What we need from you:

1. **Downloads allowed through the proxy/firewall** (HTTPS) on the build computer, for the one-time tool setup and the builds:
   - `github.com` and `objects.githubusercontent.com` (the Java 21 runtime, Eclipse Temurin, and our repository)
   - `dl.google.com`, `maven.google.com`, `dl-ssl.google.com` (Android SDK) and `repo.maven.apache.org`, `repo1.maven.org` (libraries)
   - `services.gradle.org` and `downloads.gradle.org` (the build tool), `plugins.gradle.org`
   - `registry.npmjs.org` (JavaScript packages), `api.adoptium.net` if your tool needs it
   - for sign-in set-up only: `accounts.google.com`, `oauth2.googleapis.com`, `firebase.googleapis.com`
   The setup needs about 6 GB of free disk space and **no administrator rights** (everything is installed in the user's home folder). Please do not block `.apk` files or `adb`/USB debugging on the build computer.
2. **Permission to install our company app on the tablets.** The file is a signed `.apk` (app id `{{APPLICATION_ID}}`). Please tell us which way you prefer and enable it:
   - [ ] USB cable with "USB debugging" for a few tablets, or "install from this source" for a download link, or
   - [ ] your device-management (MDM) tool: please upload the `.apk` as a private/in-house app and assign it to the group {{TABLET_GROUP}}. We will send each new version with the same app id and signing key, and
   - [ ] a private Google Play listing for our organization (we would upload an `.aab`; we need a Google Play Console developer account, or access to the company's existing one).
3. **Network access from the tablets** to `{{WEBSITE_ADDRESS}}` and the Google services the FreeField website already uses (`identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com`, `firebasestorage.googleapis.com`), over HTTPS.
4. **E-mail delivery:** sign-in links are e-mailed by Firebase. Please make sure they are not blocked by the mail filter (`noreply@{{FIREBASE_PROJECT_ID}}.firebaseapp.com`).
5. **A website deploy window**, because the website must publish `/.well-known/assetlinks.json` so that sign-in links open the app.
6. *(Only if you want builds on GitHub instead of a laptop)* **GitHub Actions minutes for a private repository**: about {{BUILD_MINUTES, estimate 10-20}} minutes per build, {{BUILDS_PER_MONTH}} builds per month.

Questions for you: {{e.g. Does the tablet policy block apps from outside the Play Store? Is there a managed Google Play account we should publish into?}}

Thanks,
{{REQUESTER_NAME}}, {{REQUESTER_ROLE}}

---

Useful facts for IT:

- The app is open source; the signing key belongs to our company and is kept in our password manager.
- The app stores its working data on the tablet. Uninstalling it deletes that data, so please do not wipe or reinstall as a routine fix.
- Updates are installed over the old version (same app id and key).
