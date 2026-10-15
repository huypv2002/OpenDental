using System;
using System.Drawing;
using System.Windows.Forms;
public class Fixture : Form {
 public Fixture() {
  Name="FormOpenDental"; Text="Open Dental {Fixture} - TEST , PERSON - 99";
  Size=new Size(900,650); StartPosition=FormStartPosition.CenterScreen;
  var account=new Panel {Name="ControlAccount",Dock=DockStyle.Fill}; Controls.Add(account);
  var amount=new TextBox {Name="textAmount",Text="35.00",Location=new Point(20,30)};account.Controls.Add(amount);
  var note=new RichTextBox {Name="textNote",Text="Synthetic fixture only",Location=new Point(20,75),Size=new Size(300,90)};account.Controls.Add(note);
  var types=new ListBox {Name="listPayType",Location=new Point(20,180),Size=new Size(200,80)};
  types.Items.AddRange(new object[]{"Credit Card","Insurance Paid"});account.Controls.Add(types);
  var action=new Button {Name="butAction",Text="Action",Location=new Point(250,290)};
  action.Click+=(sender,e)=>{amount.Text="77.00";};account.Controls.Add(action);
  var popup=new Button {Name="butPopup",Text="Open fixture popup",Location=new Point(20,290),Size=new Size(200,35)};
  popup.Click+=(sender,e)=>{using(var child=new Form {Name="FormPayment",Text="Fixture Payment",Size=new Size(400,250)}){
   child.Controls.Add(new TextBox {Name="textCheckNum",Text="FIXTURE",Location=new Point(20,30)});
   child.ShowDialog(this);
  }};account.Controls.Add(popup);
 }
 [STAThread] public static void Main(){Application.EnableVisualStyles();Application.Run(new Fixture());}
}
