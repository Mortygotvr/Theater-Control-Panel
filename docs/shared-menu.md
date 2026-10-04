# The shared "Theater" menu

All our OBS plugins put their options in one top-level menu, **🎭 Theater**, in
OBS's menu bar. Each plugin adds its options directly to it (no submenus), as
a group of its own. A line separates the groups:

```
File  Edit  View  Docks  Profile  Scene Collection  Tools  Help  🎭 Theater
                                                                  ├─ Show Control Panel        ┐
                                                                  ├─ Settings…                 │ Theater Control Panel
                                                                  ├─ Reload                    ┘
                                                                  ├──────────────────────
                                                                  ├─ Scene Studio Window       ┐
                                                                  ├─ Scene Switching Dock      │ Theater Scene
                                                                  └─ Redeems Dock              ┘
```

The icon is an emoji in the title. Qt's menu bar shows a menu's image icon
*instead of* its text, so an image would hide the word "Theater".

No plugin owns the menu and there's no shared code or library. Every plugin
follows the same short contract and finds the menu by its Qt object name. The
menu grows with each plugin that's installed, whatever order OBS loads them in.

## The contract

These names are the whole protocol. Never change them once a plugin ships with
them.

| What | Value |
|---|---|
| Object name of the shared menu | `theater_menu` |
| Title of the shared menu | `🎭 Theater`, in UTF-8. A C++ file compiled without `/utf-8` must spell it `"\xF0\x9F\x8E\xAD Theater"`. |
| Object name of every item (action or separator) a plugin adds | the plugin's id, e.g. `theater-control-panel`, `theater-scene` |

On OBS's UI thread (in `obs_module_load`, or in a task queued with
`obs_queue_task(OBS_TASK_UI, …)`):

1. Get the menu bar: `static_cast<QMainWindow *>(obs_frontend_get_main_window())->menuBar()`.
2. Look for a direct child `QMenu` of the menu bar named `theater_menu`. If there
   isn't one, create it with `menuBar->addMenu("🎭 Theater")` and give it that
   object name. It lands at the end of the menu bar.
3. Remove your items from an earlier registration: every direct child `QAction`
   of the menu named with your plugin's id. For each one, call
   `menu->removeAction(item)`, clear its object name, then `item->deleteLater()`.
   This matters when your plugin registers again, or a second copy of it is loaded.
4. Start your group with a separator: `menu->addSeparator()`, named with your id.
   QMenu hides a separator at the top or bottom of a menu, so the first group
   shows no line.
5. Add your items with `menu->addAction(text)`, name each one with your id, give
   it your program's icon (`item->setIcon(QIcon(path))`), and connect its
   `triggered` signal. Separators inside your group are fine, but name them with
   your id too.

Icons: every item shows its program's icon, so users can tell the groups apart.
Ship the icon image in your plugin's data folder, and find it from your DLL's
location or with `obs_find_module_file`. A missing file just means no icon.

| Program | Icon |
|---|---|
| Theater Control Panel | `data\control-panel\icon.png` (512×512, from the Control Panel app) |
| Theater Scene | `data\assets\icon_32.png` |
| Theater Reader | `data\icon.png` (the Theater Reader app's) |

Rules:

- Only touch items named with your own id. Never rename, `clear()` or delete the
  shared menu, and never touch another plugin's items.
- Qt owns everything (menu bar → Theater menu → items), so there's nothing to
  free. But your items call into your DLL, so either pin the DLL
  (`GetModuleHandleExW` with `GET_MODULE_HANDLE_EX_FLAG_PIN`, as the Theater Control Panel and
  Theater Scene do) or remove your items (step 3) in `obs_module_unload`.
- Use direct-children lookups only (`Qt::FindDirectChildrenOnly`).
- Groups appear in the order plugins register. A plugin that registers again
  moves to the end. There's no sorting.
- `QMenu::addAction` and `addSeparator` parent the new item to the menu. That's
  what makes step 3's lookup work, so don't add items created elsewhere.

## Code

### With Qt headers (a normal C++ Qt plugin such as obs-starter)

```cpp
#include <QAction>
#include <QIcon>
#include <QMainWindow>
#include <QMenuBar>
#include <QMenu>
#include <obs-frontend-api.h>

static const char *kPluginId = "obs-starter";

// The shared Theater menu, with this plugin's group (re)started in it (see docs/shared-menu.md).
static QMenu *theater_menu()
{
	auto *main = static_cast<QMainWindow *>(obs_frontend_get_main_window());
	QMenuBar *bar = main->menuBar();

	auto *menu = bar->findChild<QMenu *>("theater_menu", Qt::FindDirectChildrenOnly);
	if (!menu) {
		menu = bar->addMenu(QString::fromUtf8("\xF0\x9F\x8E\xAD Theater")); // "🎭 Theater"
		menu->setObjectName("theater_menu");
	}
	while (auto *item = menu->findChild<QAction *>(kPluginId, Qt::FindDirectChildrenOnly)) {
		menu->removeAction(item);
		item->setObjectName(QString());
		item->deleteLater();
	}
	menu->addSeparator()->setObjectName(kPluginId);
	return menu;
}

static QAction *add_item(QMenu *menu, const char *text)
{
	QAction *item = menu->addAction(QString::fromUtf8(text));
	item->setObjectName(kPluginId);
	char *icon = obs_module_file("icon.png"); // the program's icon, in its data folder
	if (icon) {
		item->setIcon(QIcon(QString::fromUtf8(icon)));
		bfree(icon);
	}
	return item;
}

// In obs_module_load:
QMenu *menu = theater_menu();
QObject::connect(add_item(menu, "OBS Starter Config…"), &QAction::triggered, show_config_dialog);
```

### Header-free shims (the Theater Control Panel's, and Theater Scene's trust_qt)

These shims declare Qt classes by hand and link against OBS's own Qt DLLs.
Reference implementations:

- Theater Control Panel: `control_panel_qt_plugin_menu`, `control_panel_qt_add_menu_item` and
  `control_panel_qt_add_menu_separator` in [qt/control_panel_qt.cpp](../qt/control_panel_qt.cpp).
- Theater Scene: `get_shared_menu`, `start_own_group` and `remove_own_items` in
  `theater scene(rust)/Trust/src/qt_dialog_win.cpp`.

Extra declarations they need:

```cpp
namespace Qt { enum FindChildOption { FindDirectChildrenOnly = 0x0 }; }
struct QMetaObject;

class __declspec(dllimport) QIcon {   // Qt6Gui
public:
    void *d;
    QIcon(const QString &fileName);
    ~QIcon();
};

class __declspec(dllimport) QAction : public QObject {   // Qt6Gui
public:
    static const QMetaObject staticMetaObject;
    void setIcon(const QIcon &icon);
};

class __declspec(dllimport) QWidget : public QObject {
    // …
    void removeAction(QAction *action);
};

class __declspec(dllimport) QMenu : public QWidget {
public:
    static const QMetaObject staticMetaObject;
    QAction *addAction(const QString &text);
    QAction *addSeparator();
};

// What QObject::findChild<T>() calls. OBS 32's Qt 6.11 still exports this
// QString overload (next to the QAnyStringView one).
__declspec(dllimport) QObject *qt_qFindChild_helper(const QObject *parent, const QString &name,
                                                    const QMetaObject &mo, QFlags<Qt::FindChildOption> options);
```

The link fails if a declaration doesn't match an export of OBS's Qt 6, so a
wrong one can't slip through.

- `QIcon` and `QAction` live in Qt6Gui, so link Qt6Gui too. The Theater Control Panel's
  build.rs generates import libraries for Qt6Core, Qt6Gui and Qt6Widgets.
- A shim linked with `/DELAYLOAD` (trust_qt) must get `QMenu::staticMetaObject`
  and `QAction::staticMetaObject` through `GetProcAddress`
  (`"?staticMetaObject@QMenu@@2UQMetaObject@@B"` from Qt6Widgets.dll,
  `"?staticMetaObject@QAction@@2UQMetaObject@@B"` from Qt6Gui.dll), because data
  can't be imported through delay-loading.

### Rust side (Theater Control Panel)

[src/menu.rs](../src/menu.rs) holds the names from the table. `PluginMenu::new`
starts the group, and `add_item` and `add_separator` add to it.
[src/panel.rs](../src/panel.rs) fills it.

## Which plugins use it

| Plugin | Status |
|---|---|
| Theater Control Panel | Uses it (id `theater-control-panel`): Show Control Panel, Settings…, Reload. |
| Theater Scene (Windows) | Uses it (id `theater-scene`): Scene Studio Window, Scene Switching Dock, Redeems Dock. Its docks aren't in OBS's Docks menu (see below). |
| Theater Scene (Linux) | Not yet: `Trust/src/qt_dialog.cpp` still adds its own top-level menu and Docks-menu docks. |
| Theater Reader (Windows) | Uses it (id `theater-reader`): 📡 Chat & Alerts…, through its own copy of Theater Scene's trust_qt (`trust_ui_menu_start_group` / `trust_ui_menu_add_item`, which take any plugin's id and icon). Without the shim it goes in OBS's Tools menu. |
| obs-starter | Not yet: adds `OBS Starter Config` to OBS's Tools menu. The Qt-headers code above fits it as is. |

### Theater Scene

Theater's menu is built by its C++ shim trust_qt (`qt_dialog_win.cpp`). Trust
(Rust) calls `trust_ui_set_menu_title`, which joins the Theater menu (the title
it passes isn't shown any more), and `trust_ui_add_menu_action`.
`trust_ui_clear_menu` and `trust_ui_cleanup` only remove Theater Scene's own
items.

The Theater repo's rules require explaining why and getting the user's explicit
permission before any C++ change there. Ask first.

trust_qt.dll isn't built by `cargo build`. Build it with
`Trust/build_trust_qt.ps1`, then deploy it to both plugin folders with
`deploy_user.ps1` while OBS is closed.

## Docks opened from the menu

A plugin whose docks open from the Theater menu can keep them out of OBS's Docks
menu. Create the `QDockWidget` yourself and add it with
`obs_frontend_add_custom_qdock(id, dock)` (OBS 30+) instead of
`obs_frontend_add_dock_by_id`. OBS still saves and restores its position under
`id`, and adds no toggle to the Docks menu. To match `add_dock_by_id` docks, call
`hide()` and `setFloating(true)` on it after adding it. To reopen it, show and
raise the `QDockWidget`. Theater Scene does this in `trust_ui_create_dock` and
`trust_ui_show_dock`.

If that id is already taken, OBS refuses the dock. The dock is then still yours,
so delete it.
