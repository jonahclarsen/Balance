package app.balance.local

import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView

/** Extend Chromium's selection menu while retaining its clipboard actions and geometry. */
internal class BalanceSelectionFormatting(
    private val webView: WebView,
    private val delegate: ActionMode.Callback,
) : ActionMode.Callback2() {
    private var destroyed = false
    private var eligible = false
    private var request = 0
    private val formats = listOf("bold" to "Bold", "italic" to "Italic", "underline" to "Underline")

    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        val created = delegate.onCreateActionMode(mode, menu)
        if (created) refresh(mode)
        return created
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        val changed = delegate.onPrepareActionMode(mode, menu)
        var updated = false
        formats.forEachIndexed { index, (_, title) ->
            val id = FIRST_ITEM_ID + index
            if (eligible && menu.findItem(id) == null) {
                menu.add(GROUP_ID, id, Menu.CATEGORY_SECONDARY + index, title)
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
                updated = true
            } else if (!eligible && menu.findItem(id) != null) {
                menu.removeItem(id)
                updated = true
            }
        }
        refresh(mode)
        return changed || updated
    }

    private fun refresh(mode: ActionMode) {
        val current = ++request
        webView.evaluateJavascript("($SCRIPT)(null)") { result ->
            if (!destroyed && current == request) {
                val next = result == "true"
                if (eligible != next) {
                    eligible = next
                    mode.invalidate()
                }
            }
        }
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        val index = item.itemId - FIRST_ITEM_ID
        if (item.groupId != GROUP_ID || index !in formats.indices) {
            return delegate.onActionItemClicked(mode, item)
        }
        // Keep the native selection alive until the editor has applied and saved
        // the format; finishing first would collapse Chromium's DOM selection.
        webView.evaluateJavascript("($SCRIPT)('${formats[index].first}')") {
            if (!destroyed) mode.finish()
        }
        return true
    }

    override fun onDestroyActionMode(mode: ActionMode) {
        destroyed = true
        request++
        delegate.onDestroyActionMode(mode)
    }

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
        if (delegate is ActionMode.Callback2) delegate.onGetContentRect(mode, view, outRect)
        else super.onGetContentRect(mode, view, outRect)
    }

    companion object {
        private const val GROUP_ID = 0x42460000
        private const val FIRST_ITEM_ID = GROUP_ID + 1
        private const val SCRIPT = __SELECTION_SCRIPT__
    }
}
