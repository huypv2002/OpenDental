using System;
using System.Drawing;
using System.Windows.Forms;
// Synthetic OD-style control: no UIA ListItems, custom painting, only Up/Down.
public class PaintedChoices : Control {
 readonly string[] items={"Credit Card","Zelle","Patient Refund","Deductible","Copays","Cash","Check","Transfer","Other","Membership","Insurance paid","Final Option"};
 int selected=-1,top=0; const int RowHeight=26;
 public string SelectedLabel {get{return selected<0?"":items[selected];}}
 public PaintedChoices(){SetStyle(ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);TabStop=true;Font=new Font("Segoe UI",12);}
 void Choose(int index){selected=Math.Max(0,Math.Min(items.Length-1,index));int rows=Math.Max(1,(Height-4)/RowHeight);if(selected<top)top=selected;if(selected>=top+rows)top=selected-rows+1;Invalidate();}
 protected override bool IsInputKey(Keys key){return key==Keys.Up||key==Keys.Down||base.IsInputKey(key);}
 protected override void OnKeyDown(KeyEventArgs e){base.OnKeyDown(e);if(e.KeyCode==Keys.Down)Choose(selected+1);if(e.KeyCode==Keys.Up)Choose(selected-1);}
 protected override void OnMouseDown(MouseEventArgs e){Focus();Choose(top+Math.Max(0,(e.Y-2)/RowHeight));base.OnMouseDown(e);}
 protected override void OnPaint(PaintEventArgs e){
  e.Graphics.Clear(Color.White);int rows=Math.Max(1,(Height-4)/RowHeight);
  for(int i=top;i<Math.Min(items.Length,top+rows);i++){
   int y=2+(i-top)*RowHeight;
   if(i==selected){using(var brush=new SolidBrush(Color.FromArgb(175,195,215)))e.Graphics.FillRectangle(brush,2,y,Width-4,RowHeight);}
   e.Graphics.DrawString(items[i],Font,Brushes.Black,new PointF(4,y+2));
  }
  e.Graphics.DrawRectangle(Pens.SlateGray,0,0,Width-1,Height-1);
 }
}
public class AccountGrid : Control {
 readonly string[][] rows={
  new[]{"09/20/2026","RYAN","DOC","D0120","","Periodic exam","86.40"},
  new[]{"09/20/2026","RYAN","DOC","D2392","13","Restoration","150.00"},
  new[]{"09/20/2026","RYAN","DOC","D2392","14","Restoration","150.00"},
  new[]{"09/20/2026","OTHER","DOC","D1110","","Cleaning","108.00"}
 };
 readonly int[] x={4,120,225,290,355,410,720};
 readonly System.Collections.Generic.SortedSet<int> selected=new System.Collections.Generic.SortedSet<int>{3};
 public string Selection {get{return string.Join(",",selected);}}
 public AccountGrid(){SetStyle(ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);TabStop=true;Font=new Font("Segoe UI",10);}
 protected override void OnMouseDown(MouseEventArgs e){
  Focus();int row=(e.Y-30)/32;if(e.Y<30||row<0||row>=rows.Length)return;
  if((ModifierKeys&Keys.Control)==0){selected.Clear();selected.Add(row);}
  else if(!selected.Remove(row))selected.Add(row);
  Invalidate();base.OnMouseDown(e);
 }
 protected override void OnPaint(PaintEventArgs e){
  e.Graphics.Clear(Color.White);
  string[] header={"Date","Patient","Prov","Code","Tth","Description","Charges"};
  for(int c=0;c<header.Length;c++)e.Graphics.DrawString(header[c],Font,Brushes.Black,new PointF(x[c],5));
  for(int r=0;r<rows.Length;r++){
   int y=30+r*32;
   if(selected.Contains(r)){using(var brush=new SolidBrush(Color.FromArgb(200,220,235)))e.Graphics.FillRectangle(brush,1,y,Width-2,32);}
   for(int c=0;c<rows[r].Length;c++)e.Graphics.DrawString(rows[r][c],Font,Brushes.Black,new PointF(x[c],y+7));
   e.Graphics.DrawLine(Pens.LightGray,0,y+31,Width,y+31);
  }
 }
}
public class Fixture : Form {
 public Fixture() {
  Name="FormOpenDental"; Text="Open Dental {Fixture} - TEST , PERSON - 99";
  Size=new Size(900,650); StartPosition=FormStartPosition.CenterScreen;
  var account=new Panel {Name="ControlAccount",Dock=DockStyle.Fill}; Controls.Add(account);
  var amount=new TextBox {Name="textAmount",Text="35.00",Location=new Point(20,30)};account.Controls.Add(amount);
  var note=new RichTextBox {Name="textNote",Text="Synthetic fixture only",Location=new Point(20,75),Size=new Size(300,90)};account.Controls.Add(note);
  var types=new ListBox {Name="listPayType",Location=new Point(20,180),Size=new Size(200,80)};
  types.Items.AddRange(new object[]{"Credit Card","Insurance Paid"});account.Controls.Add(types);
  var painted=new PaintedChoices {Name="listCustomPayType",Location=new Point(400,30),Size=new Size(260,134)};account.Controls.Add(painted);
  var selection=new TextBox {Name="textPaintedSelection",ReadOnly=true,Location=new Point(400,180),Width=260};account.Controls.Add(selection);
  var timer=new Timer {Interval=50};timer.Tick+=(sender,e)=>{selection.Text=painted.SelectedLabel;};timer.Start();
  var accountGrid=new AccountGrid {Name="gridAccount",Location=new Point(5,350),Size=new Size(850,180)};account.Controls.Add(accountGrid);
  var gridSelection=new TextBox {Name="textAccountSelection",Location=new Point(400,550),Width=260,ReadOnly=true};account.Controls.Add(gridSelection);
  timer.Tick+=(sender,e)=>{gridSelection.Text=accountGrid.Selection;};
  var action=new Button {Name="butAction",Text="Action",Location=new Point(250,290)};
  action.Click+=(sender,e)=>{amount.Text="77.00";};account.Controls.Add(action);
  var popup=new Button {Name="butPopup",Text="Open fixture popup",Location=new Point(20,290),Size=new Size(200,35)};
  popup.Click+=(sender,e)=>{using(var child=new Form {Name="FormPayment",Text="Fixture Payment",Size=new Size(400,250)}){
   child.Controls.Add(new TextBox {Name="textCheckNum",Text="FIXTURE",Location=new Point(20,30)});
   child.ShowDialog(this);
  }};account.Controls.Add(popup);
 }
 [STAThread] public static void Main(){
  Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
  try{Application.EnableVisualStyles();Application.Run(new Fixture());}
  catch(Exception error){System.IO.File.WriteAllText(Application.ExecutablePath+".error.txt",error.ToString());Environment.Exit(1);}
 }
}
