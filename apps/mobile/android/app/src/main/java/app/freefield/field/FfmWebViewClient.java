package app.freefield.field;

import android.app.Activity;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Keeps the app alive when the WebView renderer dies. Without an override the default returns false and
 * Android kills the whole app process together with the renderer (what lmkd's "min2x watermark is breached" kill
 * of the sandboxed renderer did to the 3-model scene on the tablet). Here the death is recorded and the activity is
 * recreated: a fresh WebView, and the page reopens the last route with a notice (see recovery/ in the web code).
 */
public class FfmWebViewClient extends BridgeWebViewClient {
    private final Activity activity;
    private final Bridge bridge;

    public FfmWebViewClient(Bridge bridge, Activity activity) {
        super(bridge);
        this.bridge = bridge;
        this.activity = activity;
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        final boolean crashed = detail != null && detail.didCrash();
        Log.w("FFM-RECOVERY", "render process gone (crashed=" + crashed + "), recreating the activity");
        RendererRecovery.record(activity.getApplicationContext(), crashed, System.currentTimeMillis());
        activity.runOnUiThread(() -> {
            if (!activity.isFinishing() && !activity.isDestroyed()) activity.recreate();
        });
        // true = handled: the app process survives. The dead WebView is destroyed with the activity.
        return true;
    }
}
