package app.freefield.field;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;

/**
 * Persistent record of WebView renderer deaths. The renderer can be killed by the system under memory
 * pressure (lmkd) or crash; {@link FfmWebViewClient} records it here and recreates the activity, the fresh
 * page then reads and clears the pending flag through FfmFiles.takeRendererGone().
 */
final class RendererRecovery {
    private static final String PREFS = "ffm_recovery";
    /** Deaths older than this no longer count as a loop. */
    static final long WINDOW_MS = 2 * 60 * 1000L;

    private RendererRecovery() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized void record(Context c, boolean crashed, long now) {
        SharedPreferences p = prefs(c);
        JSONArray kept = new JSONArray();
        try {
            JSONArray old = new JSONArray(p.getString("deaths", "[]"));
            for (int i = 0; i < old.length(); i++) {
                long t = old.getLong(i);
                if (now - t < WINDOW_MS) kept.put(t);
            }
        } catch (Exception ignored) {
        }
        kept.put(now);
        p.edit().putBoolean("pending", true).putBoolean("crashed", crashed).putString("deaths", kept.toString()).apply();
    }

    /** {gone, crashed, recent} and clears the pending flag (the death history stays for the loop window). */
    static synchronized long[] take(Context c, long now) {
        SharedPreferences p = prefs(c);
        boolean gone = p.getBoolean("pending", false);
        boolean crashed = p.getBoolean("crashed", false);
        long recent = 0;
        try {
            JSONArray a = new JSONArray(p.getString("deaths", "[]"));
            for (int i = 0; i < a.length(); i++) if (now - a.getLong(i) < WINDOW_MS) recent++;
        } catch (Exception ignored) {
        }
        if (gone) p.edit().putBoolean("pending", false).apply();
        return new long[] {gone ? 1 : 0, crashed ? 1 : 0, recent};
    }
}
