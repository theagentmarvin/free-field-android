# Source me: toolchain for local Android work.
export JAVA_HOME="${FFM_JAVA_HOME:-$HOME/local/jdk-21-full}"
export ANDROID_HOME="${FFM_ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
