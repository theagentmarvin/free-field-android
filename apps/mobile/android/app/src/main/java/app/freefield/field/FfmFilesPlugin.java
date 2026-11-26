package app.freefield.field;

import android.content.Intent;
import android.net.Uri;
import android.os.StatFs;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Streaming file primitives for offline packages. Nothing here ever holds a whole file in memory:
 * downloads copy through a 256 KB buffer straight to disk (HTTP Range resume), hashing reads 1 MB
 * slices into a MessageDigest. Paths are relative to the app files dir (Capacitor Directory.Data).
 */
@CapacitorPlugin(name = "FfmFiles")
public class FfmFilesPlugin extends Plugin {
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final ConcurrentHashMap<String, Boolean> cancelled = new ConcurrentHashMap<>();

    private File resolve(String rel) {
        File root = getContext().getFilesDir();
        File f = new File(root, rel);
        try {
            if (!f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) {
                throw new IllegalArgumentException("path escapes app dir");
            }
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
        return f;
    }

    /** takeRendererGone() -> {gone, crashed, recent}: did the previous WebView renderer die (see RendererRecovery)? Clears the flag. */
    @PluginMethod
    public void takeRendererGone(final PluginCall call) {
        long[] r = RendererRecovery.take(getContext(), System.currentTimeMillis());
        JSObject o = new JSObject();
        o.put("gone", r[0] == 1);
        o.put("crashed", r[1] == 1);
        o.put("recent", r[2]);
        call.resolve(o);
    }

    /** Called by MainActivity.onTrimMemory. */
    public void emitTrim(int level) {
        JSObject o = new JSObject();
        o.put("level", level);
        notifyListeners("trimMemory", o);
    }

    /** download({id, url, path, offset, headers}) -> {bytes, total}. Appends to `path` from `offset`. */
    @PluginMethod
    public void download(final PluginCall call) {
        final String id = call.getString("id", "");
        final String url = call.getString("url");
        final String path = call.getString("path");
        // PluginCall.getLong only accepts a JSON value parsed as Long; small numbers arrive as Integer and would
        // silently read as the default (every resume restarted from zero). optLong accepts any JSON number.
        final long offset = call.getData().optLong("offset", 0L);
        final JSObject headers = call.getObject("headers");
        if (url == null || path == null) {
            call.reject("url and path are required");
            return;
        }
        cancelled.remove(id);
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File file = resolve(path);
                File dir = file.getParentFile();
                if (dir != null) dir.mkdirs();
                long start = offset;
                long have = file.exists() ? file.length() : 0;
                if (start > have) start = have;
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        conn.setRequestProperty(k, headers.getString(k));
                    }
                }
                if (start > 0) conn.setRequestProperty("Range", "bytes=" + start + "-");
                int code = conn.getResponseCode();
                if (code != 200 && code != 206) {
                    call.reject("HTTP " + code, "http-" + code);
                    return;
                }
                if (start > 0 && code == 200) start = 0; // server ignored Range: restart
                long len = conn.getContentLengthLong();
                long total = len >= 0 ? start + len : -1;
                try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
                    raf.setLength(start);
                    raf.seek(start);
                    InputStream in = conn.getInputStream();
                    byte[] buf = new byte[256 * 1024];
                    long done = start;
                    long lastEmit = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled.remove(id) != null) {
                            call.reject("cancelled", "cancelled");
                            return;
                        }
                        raf.write(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 250) {
                            lastEmit = now;
                            JSObject ev = new JSObject();
                            ev.put("id", id);
                            ev.put("bytes", done);
                            ev.put("total", total);
                            notifyListeners("progress", ev);
                        }
                    }
                    raf.getFD().sync();
                    JSObject res = new JSObject();
                    res.put("bytes", done);
                    res.put("total", total);
                    call.resolve(res);
                }
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "io");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        cancelled.put(id, Boolean.TRUE);
        call.resolve();
    }

    /** hashFile({path}) -> {sha256, size}. Streams the file through SHA-256 in 1 MB slices. */
    @PluginMethod
    public void hashFile(final PluginCall call) {
        final String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        pool.execute(() -> {
            try {
                File f = resolve(path);
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                    byte[] buf = new byte[1024 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) sb.append(String.format("%02x", b));
                JSObject res = new JSObject();
                res.put("sha256", sb.toString());
                res.put("size", f.length());
                call.resolve(res);
            } catch (java.io.FileNotFoundException e) {
                call.reject("not found", "not-found");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "io");
            }
        });
    }

    /**
     * readRange({path, offset, length}) -> {data: base64}. Reads at most 8 MB at an offset (RandomAccessFile),
     * so JS can page through a big file (pdf.js range transport) without ever holding all of it.
     */
    @PluginMethod
    public void readRange(final PluginCall call) {
        final String path = call.getString("path");
        final long offset = call.getData().optLong("offset", 0L);
        final long length = Math.min(call.getData().optLong("length", 0L), 8L * 1024 * 1024);
        if (path == null || offset < 0 || length <= 0) {
            call.reject("path, offset and length are required");
            return;
        }
        pool.execute(() -> {
            try {
                File f = resolve(path);
                try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                    long size = raf.length();
                    int n = (int) Math.max(0, Math.min(length, size - offset));
                    byte[] buf = new byte[n];
                    if (n > 0) {
                        raf.seek(offset);
                        raf.readFully(buf);
                    }
                    JSObject res = new JSObject();
                    res.put("data", android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP));
                    call.resolve(res);
                }
            } catch (java.io.FileNotFoundException e) {
                call.reject("not found", "not-found");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "io");
            }
        });
    }

    /**
     * saveToDownloads({path, name, mime}) -> {name, where}. Streams a file from the app cache dir (relative `path`) into the
     * public Downloads folder through MediaStore (API 29+), so no storage permission is needed and nothing is read into memory.
     */
    @PluginMethod
    public void saveToDownloads(final PluginCall call) {
        final String path = call.getString("path");
        final String name = call.getString("name");
        final String mime = call.getString("mime", "application/octet-stream");
        if (path == null || name == null || name.contains("/") || path.contains("..")) {
            call.reject("path and name are required");
            return;
        }
        pool.execute(() -> {
            try {
                File src = new File(getContext().getCacheDir(), path);
                if (!src.isFile()) {
                    call.reject("not found", "not-found");
                    return;
                }
                if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
                    call.reject("Saving to Downloads needs Android 10 or newer; use Share instead.", "unsupported");
                    return;
                }
                android.content.ContentResolver cr = getContext().getContentResolver();
                android.content.ContentValues v = new android.content.ContentValues();
                v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS);
                v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
                Uri dst = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (dst == null) {
                    call.reject("Could not create the file in Downloads", "io");
                    return;
                }
                try (java.io.FileInputStream in = new java.io.FileInputStream(src);
                     java.io.OutputStream out = cr.openOutputStream(dst)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } catch (Exception e) {
                    cr.delete(dst, null, null);
                    throw e;
                }
                android.content.ContentValues done = new android.content.ContentValues();
                done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(dst, done, null, null);
                JSObject res = new JSObject();
                res.put("name", name);
                res.put("where", "Downloads/" + name);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "io");
            }
        });
    }

    /** freeSpace() -> {free, total} of the volume holding the app files dir. */
    @PluginMethod
    public void freeSpace(PluginCall call) {
        StatFs st = new StatFs(getContext().getFilesDir().getAbsolutePath());
        JSObject res = new JSObject();
        res.put("free", st.getAvailableBytes());
        res.put("total", st.getTotalBytes());
        call.resolve(res);
    }

    /** keepAwake({on}) keeps the screen on during big downloads. */
    /** Opens this app's page in Android settings (to re-allow a denied permission). */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings: " + e.getMessage());
        }
    }

    @PluginMethod
    public void keepAwake(final PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}
