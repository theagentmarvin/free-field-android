package app.freefield.field;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Remote debugging (chrome://inspect, Playwright _android) is for debug
        // builds only; release builds never expose the WebView.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        registerPlugin(FfmFilesPlugin.class);
        super.onCreate(savedInstanceState);
        // A renderer death (lmkd under memory pressure, or a crash) recreates the activity instead of killing the app.
        if (getBridge() != null) getBridge().setWebViewClient(new FfmWebViewClient(getBridge(), this));
        // Light theme only: light system bars with dark icons, white WebView behind the page
        // (no dark flash while the bundle loads), whatever the OS night mode says.
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(true);
        bars.setAppearanceLightNavigationBars(true);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(getColor(R.color.ff_bg_app)));
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(getColor(R.color.ff_bg_app));
        }
        // One behaviour on API 26-36: always draw edge-to-edge (Android 15+ enforces it, older
        // versions would otherwise fit the decor themselves) and pad the content root by the
        // system bars / cutout ourselves, because the WebView reports env(safe-area-inset-*) as 0.
        // The listener re-runs whenever the bars change (the status bar inset can arrive after the
        // first dispatch, e.g. when the display wakes). The padded areas show the white window
        // background, so the system-bar zones read as the app background.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            if (BuildConfig.DEBUG) logInsets("content", insets);
            Insets safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }

    /** Forward Android memory-pressure levels to the page (FfmFiles "trimMemory" event) so the 3D view can shed memory. */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        try {
            if (getBridge() != null && getBridge().getPlugin("FfmFiles") != null) {
                ((FfmFilesPlugin) getBridge().getPlugin("FfmFiles").getInstance()).emitTrim(level);
            }
        } catch (Exception e) {
            Log.w("FFM-RECOVERY", "trim forward failed: " + e);
        }
    }

    private static void logInsets(String where, WindowInsetsCompat i) {
        Log.d("FFM-INSETS", where
            + " statusBars=" + i.getInsets(WindowInsetsCompat.Type.statusBars())
            + " systemBars=" + i.getInsets(WindowInsetsCompat.Type.systemBars())
            + " tappable=" + i.getInsets(WindowInsetsCompat.Type.tappableElement())
            + " cutout=" + i.getInsets(WindowInsetsCompat.Type.displayCutout())
            + " visStatus=" + i.isVisible(WindowInsetsCompat.Type.statusBars()));
    }
}
