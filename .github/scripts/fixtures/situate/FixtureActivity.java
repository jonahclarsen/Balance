package app.balance.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Empty CI-only apps. No storage, permissions, network, or personal data. */
public class FixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView label = new TextView(this);
        label.setText(getPackageName());
        layout.addView(label);
        EditText edit = new EditText(this);
        edit.setHint("Synthetic input");
        layout.addView(edit);
        setContentView(layout);
        if (getIntent().getBooleanExtra("spoof_resume", false)) new Handler(getMainLooper()).postDelayed(() -> {
            sendBroadcast(new android.content.Intent("app.balance.local.SITUATE_APP_RESUMED").setPackage("app.balance.local"));
        }, 1000);
        if (getIntent().getBooleanExtra("keyboard", false)) {
            edit.requestFocus();
            edit.postDelayed(() -> ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(edit, InputMethodManager.SHOW_IMPLICIT), 400);
        }
    }
    @Override public void onStop() {
        super.onStop();
        // Reproduce a late background pane event after switching to an allowed app.
        if (getIntent().getBooleanExtra("late_pane", false)) new Handler(getMainLooper()).postDelayed(() -> {
            AccessibilityEvent event = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED);
            event.setPackageName(getPackageName());
            event.setClassName("android.widget.FrameLayout");
            event.setContentChangeTypes(AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_DISAPPEARED);
            AccessibilityManager manager = (AccessibilityManager)getSystemService(ACCESSIBILITY_SERVICE);
            if (manager.isEnabled()) manager.sendAccessibilityEvent(event);
        }, 700);
    }
}
