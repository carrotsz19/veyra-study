package app.veyra.study;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the screen on while Veyra is open (Settings → Phone → Keep the screen on while focusing),
 * and colours the status bar and the navigation bar like the page under them, light or dark.
 */
@CapacitorPlugin(name = "Screen")
public class ScreenPlugin extends Plugin {
    private Integer barColor = null;
    private boolean barDark = false;
    @PluginMethod
    public void keepOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    /** The page's background colour ("#rrggbb") and whether it's dark (light icons on the bars). */
    @PluginMethod
    public void bars(PluginCall call) {
        try {
            barColor = Color.parseColor(call.getString("color", "#f3f1ec"));
        } catch (IllegalArgumentException e) {
            call.reject("Not a colour.");
            return;
        }
        barDark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getActivity().runOnUiThread(() -> {
            applyBars();
            call.resolve();
        });
    }

    // Android's own bar handling (Capacitor's SystemBars) puts its colours back when the phone
    // turns or switches light/dark; put Veyra's back after it.
    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        View decor = getActivity().getWindow().getDecorView();
        decor.post(this::applyBars);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        getActivity().getWindow().getDecorView().post(this::applyBars);
    }

    @SuppressWarnings("deprecation")
    private void applyBars() {
        if (barColor == null) return;
        Window window = getActivity().getWindow();
        View decor = window.getDecorView();
        decor.setBackgroundColor(barColor);
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setBackgroundColor(barColor);
        if (Build.VERSION.SDK_INT < 35) {
            window.setStatusBarColor(barColor);
            window.setNavigationBarColor(barColor);
        }
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, decor);
        bars.setAppearanceLightStatusBars(!barDark);
        bars.setAppearanceLightNavigationBars(!barDark);
    }
}
