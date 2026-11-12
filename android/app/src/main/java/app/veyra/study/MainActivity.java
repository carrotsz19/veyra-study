package app.veyra.study;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are registered before the bridge starts.
        registerPlugin(UpdateInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
