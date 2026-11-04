// Open Dental 24.3 PluginBase extension. Navigation only; no database access.
using System;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using OpenDentBusiness;

namespace LukCalendarNavigation {
 public class Plugin : PluginBase {
  const string ButtonName = "lukBackSixMonths";

  public override bool HookAddCode(object sender, string hookName, params object[] parameters) {
   if (hookName != "ContrAppt.ModuleSelected_end"
    && hookName != "ControlAppt.RefreshModuleScreenPeriod_end"
    && hookName != "ContrAppt.LayoutToolBar_end") return false;
   Control module = sender as Control;
   if (module == null || module.IsDisposed || module.InvokeRequired) return false;
   Version version = module.GetType().Assembly.GetName().Version;
   if (version == null || version.Major != 24 || version.Minor != 3) return false;
   MethodInfo getDate = module.GetType().GetMethod("GetDateSelected", Type.EmptyTypes);
   MethodInfo selectDate = module.GetType().GetMethod("ModuleSelected", new Type[] { typeof(DateTime) });
   if (getDate == null || getDate.ReturnType != typeof(DateTime) || selectDate == null) return false;
   Control[] found = module.Controls.Find("butClearPin", true);
   if (found.Length != 1 || found[0].Parent == null) return false;
   Control clear = found[0];
   Control parent = clear.Parent;
   if (parent.Controls.ContainsKey(ButtonName)) return false;
   Button button = new Button();
   button.Name = ButtonName;
   button.Text = "-6";
   button.AccessibleName = "Go back six months";
   button.UseVisualStyleBackColor = true;
   button.Font = clear.Font;
   ToolTip tip = new ToolTip();
   tip.SetToolTip(button, "Go back 6 months from the selected date");
   EventHandler position = delegate {
    int gap = Math.Max(2, clear.Height / 12);
    Rectangle bounds = new Rectangle(gap, clear.Top, Math.Max(0, clear.Left - gap * 2), clear.Height);
    // Hide rather than obscure another control on an unexpected layout.
    bool fits = bounds.Width >= clear.Height;
    foreach (Control sibling in parent.Controls) {
     if (sibling != button && sibling.Visible && bounds.IntersectsWith(sibling.Bounds)) fits = false;
    }
    button.Bounds = bounds;
    button.Visible = fits;
   };
   button.Click += delegate {
    try {
     DateTime current = (DateTime)getDate.Invoke(module, null);
     selectDate.Invoke(module, new object[] { current.AddMonths(-6) });
    } catch (Exception error) {
     Exception cause = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
     MessageBox.Show(module, "Could not move the calendar: " + cause.Message,
      "LUK Calendar Navigation", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
   };
   parent.Controls.Add(button);
   clear.LocationChanged += position;
   clear.SizeChanged += position;
   parent.SizeChanged += position;
   button.Disposed += delegate {
    clear.LocationChanged -= position;
    clear.SizeChanged -= position;
    parent.SizeChanged -= position;
    tip.Dispose();
   };
   position(null, EventArgs.Empty);
   return false;
  }
 }
}
