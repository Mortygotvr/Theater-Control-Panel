// Header-free Qt shim, adapted from theater scene(rust)/Trust/src/qt_dialog_win.cpp.
//
// Passive container only: it creates the plain QWidget that OBS wraps in a
// dock and hands back that widget's native HWND, and adds this plugin's items to
// the Theater menu shared by all our plugins; the items call back into Rust. The Rust side registers the docks with obs-frontend-api and hosts the
// WebView2s.
//
// Qt classes are declared by hand and imported from OBS's own Qt6*.dll (the
// import libs are generated from those DLLs by build.rs), so no Qt SDK is
// needed. Only non-virtual methods may be declared here, and the layouts must
// match the 64-bit Qt6 ABI.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdint>

template <typename Enum>
class QFlags {
    int i;
public:
    QFlags(int val = 0) : i(val) {}
};

namespace Qt {
    enum WindowType {
        Widget = 0x00000000
    };
    enum WidgetAttribute {
        WA_OpaquePaintEvent = 4,
        WA_NoSystemBackground = 9,
        WA_NativeWindow = 100,
        WA_DontCreateNativeAncestors = 101
    };
    enum FindChildOption {
        FindDirectChildrenOnly = 0x0,
        FindChildrenRecursively = 0x1
    };
}

struct QMetaObject;

class __declspec(dllimport) QString {
public:
    void *d;
    void *ptr;
    size_t size;
    QString();
    ~QString();
    static QString fromUtf8(const char *str, int64_t size = -1);
};

class __declspec(dllimport) QObject {
public:
    void *vptr;
    void *d_ptr;
    void setObjectName(const QString &name);
    void deleteLater();
};

class __declspec(dllimport) QIcon {
public:
    void *d;
    QIcon(const QString &fileName);
    ~QIcon();
};

class __declspec(dllimport) QAction : public QObject {
public:
    static const QMetaObject staticMetaObject;
    void setIcon(const QIcon &icon);
};

// QWidget in 64-bit Qt6: QObject (16 bytes) + QPaintDevice (16 bytes) + QWidgetData* (8 bytes) = 40 bytes
class __declspec(dllimport) QWidget : public QObject {
public:
    char _pad_paintdevice_and_data[24];
    QWidget(QWidget *parent = nullptr, QFlags<Qt::WindowType> flags = {});
    uintptr_t winId() const;
    void setAttribute(Qt::WidgetAttribute attribute, bool on = true);
    QWidget *parentWidget() const;
    void show();
    void raise();
    void activateWindow();
    void removeAction(QAction *action);
    void setMinimumSize(int minw, int minh);
};

class __declspec(dllimport) QDockWidget : public QWidget {
public:
    static const QMetaObject staticMetaObject;
};

class __declspec(dllimport) QMenu : public QWidget {
public:
    static const QMetaObject staticMetaObject;
    QAction *addAction(const QString &text);
    QAction *addSeparator();
};

class __declspec(dllimport) QMenuBar : public QWidget {
public:
    QMenu *addMenu(const QString &title);
};

class __declspec(dllimport) QMainWindow : public QWidget {
public:
    QMenuBar *menuBar() const;
};

// What QObject::findChild<T>() calls: the child of `parent` named `name` that
// `mo` can cast to, or null.
__declspec(dllimport) QObject *qt_qFindChild_helper(const QObject *parent, const QString &name,
                                                    const QMetaObject &mo, QFlags<Qt::FindChildOption> options);

static_assert(sizeof(QString) == 24, "QString size mismatch");
static_assert(sizeof(QIcon) == 8, "QIcon size mismatch");
static_assert(sizeof(QObject) == 16, "QObject size mismatch");
static_assert(sizeof(QWidget) == 40, "QWidget size mismatch");

// ============================================================================
// Connecting a Qt signal to a plain C callback, without moc or Qt headers:
// a hand-made QtPrivate::QSlotObjectBase handed to QObjectPrivate::connect()
// (the machinery behind connect() with a lambda). Same as qt_dialog_win.cpp.
// ============================================================================
typedef void (*MenuCallback)(void *user_data);

namespace QtPrivate {
    struct QSlotObjectBase;
    typedef void (*QSlotFunc)(int which, QSlotObjectBase *this_, QObject *r, void **a, bool *ret);

    // Qt6 layout: QAtomicInt m_ref, then the ImplFn pointer.
    struct QSlotObjectBase {
        int ref;
        int pad;
        QSlotFunc m_impl;
        QSlotObjectBase(QSlotFunc impl) : ref(1), pad(0), m_impl(impl) {}
    };
}

struct CallbackSlot : QtPrivate::QSlotObjectBase {
    MenuCallback cb;
    void *user_data;
    CallbackSlot(MenuCallback cb, void *user_data) : QSlotObjectBase(impl), cb(cb), user_data(user_data) {}

    static void impl(int which, QtPrivate::QSlotObjectBase *this_, QObject *, void **, bool *ret) {
        CallbackSlot *self = (CallbackSlot *)this_;
        switch (which) {
        case 0: delete self; break;                      // Destroy
        case 1: if (self->cb) self->cb(self->user_data); break; // Call
        case 2: if (ret) *ret = false; break;            // Compare
        }
    }
};

typedef void *(*QObjectPrivateGetFn)(const QObject *o);
typedef int (*SignalIndexFn)(const void *priv, const char *signalName, const void **meta);
typedef void *(*QObjectPrivateConnectFn)(void *out_connection, const QObject *sender, int signal_index, void *slot, int type);
typedef void (*ConnectionDtorFn)(void *connection);
typedef int (*IndexOfSignalFn)(const void *meta, const char *signal);

// Connects `sender`'s signal (the first of the two signatures it has) to `slot`.
// Takes ownership of `slot`: it's destroyed here if the connection can't be made.
static bool connect_signal(QObject *sender, const char *sig1, const char *sig2, QtPrivate::QSlotObjectBase *slot) {
    auto destroy_slot = [slot]() { slot->m_impl(0, slot, nullptr, nullptr, nullptr); };

    HMODULE qtCore = GetModuleHandleA("Qt6Core.dll");
    if (!qtCore) { destroy_slot(); return false; }

    static auto get_fn = (QObjectPrivateGetFn)GetProcAddress(qtCore, "?get@QObjectPrivate@@SAPEAV1@PEAVQObject@@@Z");
    static auto sig_fn = (SignalIndexFn)GetProcAddress(qtCore, "?signalIndex@QObjectPrivate@@QEBAHPEBDPEAPEBUQMetaObject@@@Z");
    static auto conn_fn = (QObjectPrivateConnectFn)GetProcAddress(qtCore, "?connect@QObjectPrivate@@SA?AVConnection@QMetaObject@@PEBVQObject@@HPEAVQSlotObjectBase@QtPrivate@@W4ConnectionType@Qt@@@Z");
    static auto conn_dtor_fn = (ConnectionDtorFn)GetProcAddress(qtCore, "??1Connection@QMetaObject@@QEAA@XZ");
    static auto index_of_signal_fn = (IndexOfSignalFn)GetProcAddress(qtCore, "?indexOfSignal@QMetaObject@@QEBAHPEBD@Z");
    if (!get_fn || !sig_fn || !conn_fn || !index_of_signal_fn) { destroy_slot(); return false; }

    void *priv = get_fn(sender);
    if (!priv) { destroy_slot(); return false; }

    // signalIndex() finds the signal and the class declaring it (`meta`) but
    // returns a *signal* index; QObjectPrivate::connect() takes the signal's
    // *method* index and converts it itself.
    const char *sig = nullptr;
    const void *meta = nullptr;
    if (sig1 && sig_fn(priv, sig1, &meta) >= 0) sig = sig1;
    else if (sig2 && sig_fn(priv, sig2, &meta) >= 0) sig = sig2;
    int methodIdx = (sig && meta) ? index_of_signal_fn(meta, sig) : -1;
    if (methodIdx < 0) { destroy_slot(); return false; }

    char connection[32] = {0};
    conn_fn(connection, sender, methodIdx, slot, 0); // 0 = Qt::AutoConnection
    // Releases the returned QMetaObject::Connection handle; the connection stays.
    if (conn_dtor_fn) conn_dtor_fn(connection);
    return true;
}

extern "C" {

// Creates the dock's content widget, parented to `main_window` (the QMainWindow*
// from obs_frontend_get_main_window). Ownership passes to OBS once the widget is
// registered with obs_frontend_add_dock_by_id; otherwise release it with
// control_panel_qt_delete_widget.
void *control_panel_qt_create_dock_widget(void *main_window, const char *object_name) {
    QWidget *widget = new QWidget((QWidget *)main_window);
    if (object_name && *object_name) {
        widget->setObjectName(QString::fromUtf8(object_name));
    }
    // The WebView2 child window covers the whole widget, so Qt must not paint
    // a background underneath it.
    widget->setAttribute(Qt::WA_NoSystemBackground);
    widget->setAttribute(Qt::WA_OpaquePaintEvent);
    return widget;
}

// Gives the widget its own native window (without making its ancestors native,
// same as obs-browser's QCefWidget) and returns that HWND. Native child windows
// flagged WA_NativeWindow keep their HWND when Qt reparents them, e.g. when the
// dock is floated or re-docked.
uintptr_t control_panel_qt_native_handle(void *widget) {
    if (!widget) return 0;
    QWidget *w = (QWidget *)widget;
    w->setAttribute(Qt::WA_DontCreateNativeAncestors);
    w->setAttribute(Qt::WA_NativeWindow);
    return w->winId();
}

void control_panel_qt_delete_widget(void *widget) {
    if (widget) ((QObject *)widget)->deleteLater();
}

static void set_name(QObject *object, const char *object_name) {
    if (object && object_name) object->setObjectName(QString::fromUtf8(object_name));
}

// Adds a separator named `object_name` to `menu`.
void control_panel_qt_add_menu_separator(void *menu, const char *object_name) {
    if (menu) set_name(((QMenu *)menu)->addSeparator(), object_name);
}

// Returns the menu shared by all our plugins (see docs/shared-menu.md),
// creating it at the end of OBS's menu bar if no plugin has yet, ready for this
// plugin's group of items: the items named `plugin_name` from an earlier
// registration are removed, and a separator named `plugin_name` starts the
// group (QMenu hides it while the group is first). The menu is found by object
// name, so it works whichever plugin loads first. Qt owns it (menu bar > menu).
void *control_panel_qt_plugin_menu(void *main_window, const char *shared_name, const char *shared_title,
                               const char *plugin_name) {
    if (!main_window || !shared_name || !shared_title || !plugin_name) return nullptr;
    QMenuBar *menuBar = ((QMainWindow *)main_window)->menuBar();
    if (!menuBar) return nullptr;

    QString menuName = QString::fromUtf8(shared_name);
    QMenu *menu = (QMenu *)qt_qFindChild_helper(menuBar, menuName, QMenu::staticMetaObject, Qt::FindDirectChildrenOnly);
    if (!menu) {
        menu = menuBar->addMenu(QString::fromUtf8(shared_title));
        if (!menu) return nullptr;
        menu->setObjectName(menuName);
    }

    // The menu's items are its children (addAction parents them to it).
    QString itemName = QString::fromUtf8(plugin_name);
    while (QAction *item = (QAction *)qt_qFindChild_helper(menu, itemName, QAction::staticMetaObject,
                                                           Qt::FindDirectChildrenOnly)) {
        menu->removeAction(item);
        item->setObjectName(QString());
        item->deleteLater();
    }
    control_panel_qt_add_menu_separator(menu, plugin_name);
    return menu;
}

// Adds an item named `object_name` to `menu` that calls `callback(user_data)`
// when clicked, with the image at `icon_path` (optional) as its icon.
bool control_panel_qt_add_menu_item(void *menu, const char *object_name, const char *text, const char *icon_path,
                                MenuCallback callback, void *user_data) {
    if (!menu || !text) return false;
    QAction *action = ((QMenu *)menu)->addAction(QString::fromUtf8(text));
    if (!action) return false;
    set_name(action, object_name);
    if (icon_path && *icon_path) action->setIcon(QIcon(QString::fromUtf8(icon_path)));
    return connect_signal(action, "triggered(bool)", "triggered()", new CallbackSlot(callback, user_data));
}

// Shows and raises the dock holding `widget`: OBS wraps the widget in a
// Sets the minimum size of the dock named `dock_name` (its object name, the dock
// id) in the main window, in Qt's logical pixels; 0, 0 lets it shrink again.
// False if there's no such dock.
bool control_panel_qt_set_dock_minimum_size(void *main_window, const char *dock_name, int width, int height) {
    if (!main_window || !dock_name) return false;
    QWidget *dock = (QWidget *)qt_qFindChild_helper((QObject *)main_window, QString::fromUtf8(dock_name),
                                                    QDockWidget::staticMetaObject, Qt::FindChildrenRecursively);
    if (!dock) return false;
    dock->setMinimumSize(width, height);
    return true;
}

// QDockWidget whose parent is the main window, so walk up to that level.
void control_panel_qt_show_dock(void *main_window, void *widget) {
    QWidget *dock = (QWidget *)widget;
    while (dock) {
        QWidget *parent = dock->parentWidget();
        if (!parent || parent == (QWidget *)main_window) break;
        dock = parent;
    }
    if (dock) {
        dock->show();
        dock->raise();
        dock->activateWindow();
    }
}

} // extern "C"
