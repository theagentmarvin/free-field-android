# Source me: build-time env for the Firebase-emulator e2e APK (cloud mode, no demo auth).
# Values are fake: the emulators accept any API key and never talk to a real project.
export VITE_FIREBASE_API_KEY="fake-api-key"
export VITE_FIREBASE_AUTH_DOMAIN="demo-freefield.firebaseapp.com"
export VITE_FIREBASE_PROJECT_ID="demo-freefield"
export VITE_FIREBASE_STORAGE_BUCKET="demo-freefield.appspot.com"
export VITE_FIREBASE_MESSAGING_SENDER_ID="000000000000"
export VITE_FIREBASE_APP_ID="1:000000000000:web:0000000000000000"
export VITE_EXPECTED_FIREBASE_PROJECT_ID="demo-freefield"
export VITE_FIREBASE_USE_EMULATOR="true"
export VITE_FIREBASE_EMULATOR_HOST="localhost"
export VITE_FFM_TEST_HOOKS="true"
export FFM_EMULATOR_BUILD="true"
unset VITE_FF_DEMO_AUTH
