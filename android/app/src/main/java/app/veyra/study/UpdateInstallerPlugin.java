package app.veyra.study;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.List;

/**
 * Hands a downloaded update (an APK in the app's cache) straight to Android's
 * own package installer, so the "Install this update?" screen opens without
 * an "Open with" chooser (other apps, like Termux, also accept APK files).
 */
@CapacitorPlugin(name = "UpdateInstaller")
public class UpdateInstallerPlugin extends Plugin {

    /** Whether Android lets this app install updates (Settings → Install unknown apps). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    /** Opens the "Install unknown apps" switch for this app. */
    @PluginMethod
    public void openPermission(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn’t open the setting.");
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        File apk = new File(path);
        if (!apk.exists()) {
            call.reject("The downloaded update is missing. Download it again.");
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

        // Prefer the system installer when there is one.
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> handlers = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
        for (ResolveInfo h : handlers) {
            String pkg = h.activityInfo.packageName;
            if (pkg.contains("packageinstaller")) {
                intent.setPackage(pkg);
                break;
            }
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No installer was found on this phone.");
        }
    }
}
